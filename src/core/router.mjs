import { facadeCapability } from "./capabilities.mjs";

export const SUPPORTED_PROTOCOLS = ["openai", "openai-response", "anthropic", "gemini"];

export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config must be a JSON object");
  }
  if (!config.providers || typeof config.providers !== "object") {
    throw new Error("config.providers is required");
  }
  if (!config.routes || typeof config.routes !== "object") {
    throw new Error("config.routes is required");
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider || typeof provider !== "object" || !provider.base_url) {
      throw new Error(`provider ${name} is missing base_url`);
    }
    validateBaseUrl(provider.base_url, `provider ${name} base_url`);
    if (Object.prototype.hasOwnProperty.call(provider, "api_key")) {
      throw new Error(`provider ${name} must not store API keys in config.json`);
    }
    if (provider.headers !== undefined) validateHeaders(provider.headers, `provider ${name} headers`);
    if (!SUPPORTED_PROTOCOLS.includes(provider.protocol)) {
      throw new Error(`provider ${name} protocol must be one of ${SUPPORTED_PROTOCOLS.join(", ")}`);
    }
    validateEnvName(provider.api_key_env, `provider ${name} api_key_env`);
  }
  validateEnvName(config.gateway_api_key_env, "gateway_api_key_env");
  if (config.qoder_patch !== undefined) {
    if (!config.qoder_patch || typeof config.qoder_patch !== "object"
      || Array.isArray(config.qoder_patch)) {
      throw new Error("qoder_patch must be an object");
    }
    if (config.qoder_patch.enabled !== undefined
      && typeof config.qoder_patch.enabled !== "boolean") {
      throw new Error("qoder_patch.enabled must be a boolean");
    }
    if (config.qoder_patch.gateway_url !== undefined) {
      validateBaseUrl(config.qoder_patch.gateway_url, "qoder_patch.gateway_url");
      const url = new URL(config.qoder_patch.gateway_url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error("qoder_patch.gateway_url must point to localhost");
      }
    }
  }
  for (const [alias, route] of Object.entries(config.routes)) {
    const entries = flattenRouteEntries(route);
    if (!entries.length) throw new Error(`route ${alias} must not be empty`);
    for (const entry of entries) {
      if (entry && typeof entry === "object" && entry.protocol
        && !SUPPORTED_PROTOCOLS.includes(entry.protocol)) {
        throw new Error(`route ${alias} protocol must be one of ${SUPPORTED_PROTOCOLS.join(", ")}`);
      }
    }
  }
}

export function resolveCandidates(config, requestedModel, facade, registry, requestOptions = {}) {
  const route = config.routes[requestedModel];
  if (!route) return [];
  const entries = flattenRouteEntries(route);
  const capability = facadeCapability(facade);
  return entries.map((entry, index) => {
    const providerName = typeof entry === "string" ? entry : entry.provider;
    const provider = config.providers[providerName];
    if (!provider) throw new Error(`route references unknown provider ${providerName}`);
    const model = typeof entry === "string" ? requestedModel : entry.model ?? requestedModel;
    const protocol = typeof entry === "string"
      ? provider.protocol
      : entry.protocol ?? provider.protocol;
    const discovered = registry?.get(providerName, model);
    const discoveredSupport = registry?.supports(providerName, model, capability);
    const declaredSupport = typeof entry === "object" ? entry.capabilities?.[capability] : undefined;
    const knownSupport = discoveredSupport ?? declaredSupport;
    const requiredCapabilities = [
      capability,
      requestOptions.stream && !requestOptions.allowUnlistedStream ? "stream" : undefined,
      requestOptions.tools ? "tools" : undefined,
      requestOptions.vision ? "vision" : undefined,
      requestOptions.reasoning ? "reasoning" : undefined
    ].filter(Boolean);
    const unsupportedByCatalog = registry?.hasProvider(providerName)
      && !discovered
      || requiredCapabilities.some((name) => {
        const discoveredValue = discovered?.capabilities?.[name];
        const declaredValue = typeof entry === "object" ? entry.capabilities?.[name] : undefined;
        return (discoveredValue ?? declaredValue) === false;
      });
    return {
      providerName,
      provider,
      model,
      path: typeof entry === "string" ? undefined : entry.path,
      protocol,
      primary: index === 0,
      capabilities: registry?.get(providerName, model)?.capabilities
        ?? (typeof entry === "object" ? entry.capabilities ?? null : null),
      unsupportedFacade: knownSupport === false || unsupportedByCatalog
    };
  }).filter((candidate) => !candidate.unsupportedFacade);
}

export function flattenRouteEntries(route) {
  if (Array.isArray(route)) return route;
  if (!route || typeof route !== "object") return [route];
  const primary = { ...route };
  delete primary.fallback;
  const fallback = Array.isArray(route.fallback)
    ? route.fallback
    : route.fallback && typeof route.fallback === "object"
      ? [route.fallback]
      : [];
  return [primary, ...fallback];
}

export function protocolForFacade(facade) {
  if (facade === "openai-chat") return "openai";
  if (facade === "openai-responses") return "openai-response";
  if (facade === "anthropic") return "anthropic";
  return undefined;
}

export function facadeForPath(method, pathname) {
  if (method !== "POST") return null;
  if (pathname === "/v1/chat/completions") return "openai-chat";
  if (pathname === "/v1/responses") return "openai-responses";
  if (pathname === "/v1/messages") return "anthropic";
  return null;
}

function validateEnvName(value, label) {
  if (value === undefined || value === "") return;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) {
    throw new Error(`${label} must be an environment variable name such as YMENG_API_KEY`);
  }
}

function validateBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.hash || [...url.searchParams.keys()].some((key) => /(api[-_]?key|auth|token|secret|password)/i.test(key))) {
    throw new Error(`${label} must not contain embedded credentials or secret query parameters`);
  }
}

function validateHeaders(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (/(authorization|api[-_]?key|auth|token|secret|cookie|password)/i.test(key)) {
      throw new Error(`${label} must not contain credential header ${key}`);
    }
  }
}
