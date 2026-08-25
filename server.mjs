import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fromAnthropic, anthropicToOpenAI, anthropicToResponses, toAnthropic } from "./src/adapters/anthropic.mjs";
import { fromOpenAIChat, openAIChatToResponsesBody, toOpenAIChat } from "./src/adapters/openai-chat.mjs";
import { fromOpenAIResponses, responsesToAnthropic, responsesToOpenAIChat, toOpenAIResponses } from "./src/adapters/openai-responses.mjs";
import { geminiToOpenAIChat, geminiToResponses, geminiUrl, toGemini } from "./src/adapters/gemini.mjs";
import { writeConvertedSse } from "./src/adapters/stream-events.mjs";
import { ModelCapabilityRegistry } from "./src/core/capabilities.mjs";
import { GatewayError, errorPayload, isRetryableStatus, sanitizeErrorText, upstreamStatusError } from "./src/core/errors.mjs";
import { applyQoderPatch } from "./src/core/qoder-patch.mjs";
import { facadeForPath, flattenRouteEntries, resolveCandidates, validateConfig } from "./src/core/router.mjs";
import { parseSimulatedToolCalls } from "./src/tools/tool-parser.mjs";
import { createToolPolicy } from "./src/tools/tool-policy.mjs";
import { executeToolCall } from "./src/tools/tool-runtime.mjs";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

export async function loadConfig(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const config = JSON.parse(raw);
  validateConfig(config);
  return config;
}

export function createGateway(config, options = {}) {
  validateConfig(config);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBodyBytes = config.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const configPath = options.configPath;
  const qoderPatchRunner = options.qoderPatchRunner;
  const runtimeSecrets = new Map();
  const capabilities = options.capabilities ?? new ModelCapabilityRegistry();
  const recentRequests = [];

  return async function gatewayHandler(req, res) {
    const requestId = crypto.randomUUID();
    const clientAbortController = new AbortController();
    const abortOnClientClose = () => {
      if (!res.writableEnded) {
        clientAbortController.abort(new Error("client disconnected"));
      }
    };
    req.once("aborted", abortOnClientClose);
    res.once("close", abortOnClientClose);
    res.setHeader("X-Qoder-Gateway-Request-Id", requestId);

    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        await serveDashboard(res);
        return;
      }
      if (url.pathname === "/health") {
        json(res, 200, { ok: true, service: "qoder-bridge-gateway", request_id: requestId });
        return;
      }
      if (url.pathname === "/admin/recent-requests" && req.method === "GET") {
        json(res, 200, { data: recentRequests });
        return;
      }
      if (url.pathname === "/admin/local-tool" && req.method === "POST") {
        if (!isLoopbackRequest(req)) {
          json(res, 403, {
            error: {
              message: "local tool execution is only available from localhost",
              type: "forbidden"
            }
          });
          return;
        }
        const body = await readJson(req, maxBodyBytes);
        const result = await executeLocalTool(body);
        json(res, 200, {
          request_id: requestId,
          ...result
        });
        return;
      }
      if (!authorize(req, config)) {
        json(res, 401, { error: { message: "invalid gateway API key", type: "authentication_error" } });
        return;
      }
      if (url.pathname === "/admin/qoder-patch" && req.method === "POST") {
        if (!qoderPatchRunner) {
          json(res, 503, {
            error: {
              message: "Qoder patch runner is unavailable in this gateway instance",
              type: "configuration_error"
            }
          });
          return;
        }
        const result = await qoderPatchRunner();
        json(res, result.ok === false ? 503 : 200, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, { object: "list", data: listModels(config, capabilities) });
        return;
      }
      if (url.pathname === "/admin/config" && req.method === "GET") {
        json(res, 200, redactConfig(config, runtimeSecrets));
        return;
      }
      if (url.pathname === "/admin/config" && req.method === "PUT") {
        if (!configPath) {
          json(res, 503, { error: { message: "config persistence is unavailable", type: "configuration_error" } });
          return;
        }
        const nextConfig = await readJson(req, maxBodyBytes);
        await persistConfig(config, nextConfig, configPath);
        const patchResult = await autoInjectQoderModels(config, qoderPatchRunner);
        json(res, 200, {
          ...redactConfig(config, runtimeSecrets),
          qoder_patch_sync: patchResult
        });
        return;
      }
      if (url.pathname === "/admin/provider-secret" && req.method === "PUT") {
        const body = await readJson(req, maxBodyBytes);
        const providerName = body.provider;
        if (!config.providers[providerName]) {
          const error = new Error(`unknown provider ${providerName}`);
          error.statusCode = 404;
          throw error;
        }
        if (typeof body.api_key !== "string") {
          const error = new Error("api_key must be a string");
          error.statusCode = 400;
          throw error;
        }
        if (body.api_key.trim()) runtimeSecrets.set(providerName, body.api_key.trim());
        else runtimeSecrets.delete(providerName);
        const patchResult = await autoInjectQoderModels(config, qoderPatchRunner);
        json(res, 200, {
          ...redactConfig(config, runtimeSecrets),
          qoder_patch_sync: patchResult
        });
        return;
      }
      if (url.pathname === "/admin/test-upstream" && req.method === "POST") {
        const body = await readJson(req, maxBodyBytes);
        json(res, 200, await testUpstream(fetchImpl, config, body.provider, runtimeSecrets));
        return;
      }
      if (url.pathname === "/admin/upstream-models" && req.method === "GET") {
        const providerName = url.searchParams.get("provider");
        const result = await fetchUpstreamModels(fetchImpl, config, providerName, runtimeSecrets, capabilities);
        json(res, 200, result);
        return;
      }

      const facade = facadeForPath(req.method, url.pathname);
      if (!facade) {
        json(res, 404, { error: { message: "route not found", type: "not_found" } });
        return;
      }

      const body = await readJson(req, maxBodyBytes);
      const allowUnlistedStream = body.metadata?.qoder_bridge_stream_fallback === true
        || req.headers["x-qoder-gateway-stream-fallback"] === "1";
      const candidates = resolveCandidates(config, body.model, facade, capabilities, {
        stream: body.stream === true,
        tools: Array.isArray(body.tools) && body.tools.length > 0,
        vision: bodyHasImages(body),
        reasoning: body.reasoning !== undefined || body.reasoning_effort !== undefined,
        allowUnlistedStream
      });
      if (!candidates.length) {
        json(res, 400, {
          error: {
            message: `no route configured for model ${body.model ?? "(missing)"}`,
            type: "invalid_request_error"
          }
        });
        return;
      }

      const failures = [];
      for (const candidate of candidates) {
        try {
          const result = await forward({
            fetchImpl,
            facade,
            body,
            candidate,
            requestId,
            runtimeSecrets,
            allowStreamFallback: allowUnlistedStream,
            clientSignal: clientAbortController.signal
          });
          await writeResult(res, result);
          rememberRequest(recentRequests, {
            request_id: requestId,
            facade,
            model_alias: body.model,
            status: 200
          });
          return;
        } catch (error) {
          if (error.statusCode && !error.retryable) {
            rememberRequest(recentRequests, {
              request_id: requestId,
              facade,
              model_alias: body.model,
              status: error.statusCode,
              error: redactText(error.message)
            });
            json(res, error.statusCode, errorPayload(error, requestId));
            return;
          }
          failures.push({
            provider: candidate.providerName,
            model: candidate.model,
            message: redactText(error.message),
            retryable: Boolean(error.retryable)
          });
          if (!error.retryable) break;
        }
      }
      json(res, 502, {
        error: {
          message: "all configured upstream routes failed",
          type: "upstream_error",
          request_id: requestId,
          failures
        }
      });
      rememberRequest(recentRequests, {
        request_id: requestId,
        facade,
        model_alias: body.model,
        status: 502,
        error: "all configured upstream routes failed",
        failures
      });
    } catch (error) {
      if (clientAbortController.signal.aborted || req.aborted || res.destroyed) return;
      if (!res.headersSent) {
        const status = error.statusCode ?? 400;
        json(res, status, errorPayload(error, requestId));
      } else if (!res.writableEnded) {
        res.destroy(error);
      }
    }
  };
}

function authorize(req, config) {
  const envName = config.gateway_api_key_env;
  if (!envName) return true;
  const expected = process.env[envName];
  if (!expected) return false;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return supplied === expected;
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

async function executeLocalTool(body) {
  const workspacePath = body.workspace_path ?? body.workspacePath;
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    return {
      ok: false,
      error: "workspace_path is required",
      code: "workspace_required"
    };
  }
  const call = normalizeLocalToolCall(body.tool_call ?? body.call ?? body);
  if (!call) {
    return {
      ok: false,
      error: "a valid allowlisted tool call is required",
      code: "tool_call_invalid"
    };
  }
  const policy = createToolPolicy({
    workspaceRoots: [workspacePath],
    // This endpoint is intentionally restricted to the existing read-only
    // allowlist. It never enables terminal, shell, or arbitrary command tools.
    executionMode: "execute"
  });
  const result = await executeToolCall(policy, call, {
    requestId: body.request_id
  });
  return {
    ok: result.ok,
    tool_call_id: result.id,
    tool_use_id: result.tool_use_id,
    content: result.content,
    error: result.ok ? undefined : result.content
  };
}

function normalizeLocalToolCall(value) {
  const source = value?.function ? value : value?.tool_call ?? value;
  const functionValue = source?.function ?? source;
  const name = functionValue?.name ?? source?.name;
  if (typeof name !== "string" || !name) return null;
  const args = functionValue?.arguments
    ?? source?.arguments
    ?? source?.input
    ?? {};
  return {
    id: source?.id ?? source?.call_id ?? `local-${crypto.randomUUID()}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args)
    }
  };
}

function listModels(config, capabilities) {
  return Object.entries(config.routes).map(([id, route]) => {
    const entries = flattenRouteEntries(route);
    const models = entries.map((entry) => {
      const provider = typeof entry === "string" ? entry : entry.provider;
      const model = typeof entry === "string" ? id : entry.model ?? id;
      const providerConfig = config.providers[provider];
      const protocol = typeof entry === "string"
        ? providerConfig?.protocol
        : entry.protocol ?? providerConfig?.protocol;
      const info = capabilities.get(provider, model);
      const declaredCapabilities = typeof entry === "object" && entry.capabilities
        ? entry.capabilities
        : {};
      const discoveredTypes = Array.isArray(info?.supported_endpoint_types)
        ? info.supported_endpoint_types
        : [];
      const defaults = protocolCapabilities(protocol);
      const useDiscoveredCapabilities = discoveredTypes.length > 0;
      const mergedCapabilities = Object.fromEntries(
        MODEL_CAPABILITY_KEYS.map((key) => [
          key,
          useDiscoveredCapabilities
            ? info?.capabilities?.[key] === true
            : declaredCapabilities[key] ?? defaults[key] ?? false
        ])
      );
      return {
        provider,
        model,
        protocol,
        supported_endpoint_types: discoveredTypes.length
          ? [...discoveredTypes]
          : protocol
            ? [protocol]
            : [],
        capabilities: mergedCapabilities
      };
    });
    const primary = models[0];
    return {
      id,
      object: "model",
      created: 0,
      owned_by: "qoder-bridge-gateway",
      supported_endpoint_types: primary?.supported_endpoint_types ?? [],
      capabilities: primary?.capabilities ?? protocolCapabilities(),
      fallback_models: models.slice(1).map(({ provider, model, supported_endpoint_types, capabilities: fallbackCapabilities }) => ({
        provider,
        id: model,
        supported_endpoint_types,
        capabilities: fallbackCapabilities
      }))
    };
  });
}

const MODEL_CAPABILITY_KEYS = [
  "chat",
  "responses",
  "anthropic",
  "stream",
  "tools",
  "vision",
  "reasoning"
];

function protocolCapabilities(protocol) {
  const capabilities = Object.fromEntries(MODEL_CAPABILITY_KEYS.map((key) => [key, false]));
  if (protocol === "openai") capabilities.chat = true;
  if (protocol === "openai-response") capabilities.responses = true;
  if (protocol === "anthropic") capabilities.anthropic = true;
  if (protocol === "gemini") capabilities.chat = true;
  return capabilities;
}

function bodyHasImages(body) {
  const serialized = JSON.stringify({
    messages: body.messages,
    input: body.input
  });
  return /"image_url"|"input_image"|"image"/i.test(serialized);
}

async function serveDashboard(res) {
  const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function redactConfig(config, runtimeSecrets = new Map()) {
  return {
    listen: config.listen ?? "127.0.0.1:8787",
    gateway_api_key_env: config.gateway_api_key_env ?? "",
    max_body_bytes: config.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [
      name,
      {
        protocol: provider.protocol,
        base_url: redactUrl(provider.base_url),
        api_key_env: provider.api_key_env ?? "",
        api_key_configured: Boolean(runtimeSecrets.has(name)
          || (provider.api_key_env && process.env[provider.api_key_env])),
        timeout_ms: provider.timeout_ms ?? 120000,
        anthropic_version: provider.anthropic_version,
        headers: redactHeaders(provider.headers ?? {})
      }
    ])),
    routes: config.routes,
    qoder_patch: {
      enabled: config.qoder_patch?.enabled === true,
      gateway_url: redactUrl(config.qoder_patch?.gateway_url ?? localGatewayUrl(config.listen)),
      automatic_on_start: config.qoder_patch?.enabled === true
    }
  };
}

async function persistConfig(currentConfig, nextConfig, configPath) {
  if (!nextConfig || typeof nextConfig !== "object") {
    const error = new Error("configuration must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
  const persistedConfig = { ...nextConfig };
  if (persistedConfig.qoder_patch === undefined && currentConfig.qoder_patch !== undefined) {
    persistedConfig.qoder_patch = currentConfig.qoder_patch;
  }
  for (const provider of Object.values(persistedConfig.providers ?? {})) {
    if (provider && Object.prototype.hasOwnProperty.call(provider, "api_key")) {
      const error = new Error("store API keys in environment variables or runtime memory, not config.json");
      error.statusCode = 400;
      throw error;
    }
  }
  validateConfig(persistedConfig);
  for (const key of Object.keys(currentConfig)) delete currentConfig[key];
  Object.assign(currentConfig, persistedConfig);
  await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf8");
}

async function testUpstream(fetchImpl, config, providerName, runtimeSecrets = new Map()) {
  const provider = getProvider(config, providerName);
  const endpoint = new URL(provider.probe_path ?? provider.models_path ?? "models", ensureTrailingSlash(provider.base_url));
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: upstreamHeaders(provider, crypto.randomUUID(), runtimeSecrets.get(providerName)),
    signal: AbortSignal.timeout(provider.timeout_ms ?? 120000)
  });
  const text = await response.text();
  return {
    ok: response.ok,
    provider: providerName,
    status: response.status,
    endpoint: redactUrl(endpoint.toString()),
    body: truncate(redactText(text), 1200)
  };
}

async function fetchUpstreamModels(fetchImpl, config, providerName, runtimeSecrets = new Map(), capabilities) {
  const provider = getProvider(config, providerName);
  const endpoint = new URL(provider.models_path ?? "models", ensureTrailingSlash(provider.base_url));
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: upstreamHeaders(provider, crypto.randomUUID(), runtimeSecrets.get(providerName)),
    signal: AbortSignal.timeout(provider.timeout_ms ?? 120000)
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`upstream ${response.status}: ${truncate(redactText(text))}`);
    error.statusCode = response.status;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error("upstream models response is not valid JSON");
    error.statusCode = 502;
    throw error;
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  capabilities.record(providerName, data);
  return {
    provider: providerName,
    endpoint: redactUrl(endpoint.toString()),
    data,
    object: payload.object ?? "list",
    success: payload.success
  };
}

async function refreshConfiguredCapabilities(fetchImpl, config, capabilities) {
  for (const [providerName, provider] of Object.entries(config.providers ?? {})) {
    const apiKeyConfigured = !provider.api_key_env || Boolean(process.env[provider.api_key_env]);
    if (!apiKeyConfigured) continue;
    try {
      const result = await fetchUpstreamModels(
        fetchImpl,
        config,
        providerName,
        new Map(),
        capabilities
      );
      console.log(`model catalog synced provider=${providerName} models=${result.data.length}`);
    } catch (error) {
      console.warn(
        `model catalog sync skipped provider=${providerName}: ${redactText(error.message)}`
      );
    }
  }
}

function localGatewayUrl(listen = "127.0.0.1:8787") {
  const separator = listen.lastIndexOf(":");
  const rawHost = separator > 0 ? listen.slice(0, separator) : "127.0.0.1";
  const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  const port = Number(separator > 0 ? listen.slice(separator + 1) : listen);
  return `http://${host}:${port}`;
}

export async function runQoderPatch(config) {
  if (config.qoder_patch?.enabled !== true) {
    return { ok: true, status: "disabled", message: "Qoder patch is disabled by config" };
  }
  const gatewayUrl = config.qoder_patch.gateway_url || localGatewayUrl(config.listen);
  const gatewayKey = config.gateway_api_key_env
    ? process.env[config.gateway_api_key_env]
    : undefined;
  try {
    const result = await applyQoderPatch({
      gatewayUrl,
      authorization: gatewayKey ? `Bearer ${gatewayKey}` : undefined
    });
    console.log(
      `qoder patch applied models=${result.models.join(",")} changed=${result.files.filter((file) => file.changed).length}`
    );
    return { ok: true, status: "applied", ...result };
  } catch (error) {
    const message = redactText(error.message ?? error);
    console.warn(`qoder patch skipped: ${message}`);
    return { ok: false, status: "skipped", error: message };
  }
}

async function autoInjectQoderModels(config, qoderPatchRunner) {
  if (config.qoder_patch?.enabled !== true) {
    return { ok: true, status: "disabled", models: [] };
  }
  if (!qoderPatchRunner) {
    return { ok: false, status: "unavailable", models: [] };
  }
  try {
    const result = await qoderPatchRunner();
    return {
      ok: result?.ok !== false,
      status: result?.status ?? "applied",
      models: Array.isArray(result?.models) ? result.models : [],
      error: result?.ok === false ? redactText(result.error ?? "Qoder patch was skipped") : undefined
    };
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      models: [],
      error: redactText(error?.message ?? error)
    };
  }
}

async function forward({
  fetchImpl,
  facade,
  body,
  candidate,
  requestId,
  runtimeSecrets = new Map(),
  allowStreamFallback = false,
  clientSignal
}) {
  const apiKey = resolveProviderApiKey(
    candidate.provider,
    runtimeSecrets.get(candidate.providerName)
  );
  if (candidate.provider.api_key_env && !apiKey) {
    throw new GatewayError("provider API key is not configured in environment or runtime memory", {
      statusCode: 401,
      code: "provider_key_missing",
      retryable: false
    });
  }
  const request = normalizeFacadeRequest(facade, body, {
    id: requestId,
    modelAlias: body.model,
    upstreamModel: candidate.model
  });
  const payload = buildPayload(facade, candidate.protocol, request);
  const url = upstreamUrl(candidate.provider, facade, candidate.path, candidate.protocol, candidate.model, request.stream);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: upstreamHeaders(candidate.provider, requestId, runtimeSecrets.get(candidate.providerName), candidate.protocol),
      body: JSON.stringify(payload),
      signal: combinedRequestSignal(clientSignal, candidate.provider.timeout_ms ?? 120000)
    });
  } catch (error) {
    if (clientSignal?.aborted) throw error;
    const detail = describeFetchError(error);
    throw new GatewayError(
      `upstream request failed: ${detail}; endpoint=${redactUrl(url)}; protocol=${candidate.protocol}`,
      {
      statusCode: 502,
      code: "upstream_network_error",
      retryable: true
      }
    );
  }
  if (!response.ok) {
    const text = await response.text();
    if (request.stream && allowStreamFallback && isStreamProbeFailure(response.status)) {
      const fallbackRequest = { ...request, stream: false };
      const fallbackPayload = buildPayload(facade, candidate.protocol, fallbackRequest);
      try {
        const fallbackResponse = await fetchImpl(url, {
          method: "POST",
          headers: upstreamHeaders(
            candidate.provider,
            requestId,
            runtimeSecrets.get(candidate.providerName),
            candidate.protocol
          ),
          body: JSON.stringify(fallbackPayload),
          signal: combinedRequestSignal(clientSignal, candidate.provider.timeout_ms ?? 120000)
        });
        if (fallbackResponse.ok) {
          return {
            response: fallbackResponse,
            facade,
            providerProtocol: candidate.protocol,
            streaming: false,
            request: fallbackRequest,
            requestId
          };
        }
        const fallbackText = await fallbackResponse.text();
        throw upstreamStatusError(
          fallbackResponse.status,
          `upstream stream fallback ${fallbackResponse.status}: ${truncate(redactText(fallbackText))}`
        );
      } catch (fallbackError) {
        if (fallbackError instanceof GatewayError) throw fallbackError;
        throw new GatewayError(
          `upstream stream fallback failed: ${describeFetchError(fallbackError)}`,
          { statusCode: 502, code: "upstream_network_error", retryable: true }
        );
      }
    }
    throw upstreamStatusError(response.status, `upstream ${response.status}: ${truncate(redactText(text))}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  return {
    response,
    facade,
    providerProtocol: candidate.protocol,
    streaming: request.stream && isEventStream(contentType),
    request,
    requestId
  };
}

function isEventStream(contentType) {
  return /(?:^|[;\s])text\/event-stream(?:[;\s]|$)/i.test(contentType);
}

function isStreamProbeFailure(status) {
  return status === 400 || status === 404 || status === 405 || status === 415 || status === 422;
}

function describeFetchError(error) {
  const cause = error?.cause;
  const parts = [
    error?.name,
    error?.message,
    cause?.code,
    cause?.name,
    cause?.message
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  return redactText(parts.join(": ") || "unknown fetch error");
}

function normalizeFacadeRequest(facade, body, context) {
  if (facade === "openai-chat") return fromOpenAIChat(body, context);
  if (facade === "openai-responses") return fromOpenAIResponses(body, context);
  return fromAnthropic(body, context);
}

function buildPayload(facade, providerProtocol, request) {
  if (providerProtocol === "openai") return toOpenAIChat(request);
  if (providerProtocol === "openai-response") {
    if (facade === "openai-chat") return openAIChatToResponsesBody(request, request.upstreamModel);
    return toOpenAIResponses(request);
  }
  if (providerProtocol === "anthropic"
    && request.metadata?.parameters?.response_format !== undefined) {
    throw new GatewayError("response_format conversion to Anthropic is not enabled", {
      statusCode: 501,
      code: "unsupported_conversion"
    });
  }
  if (providerProtocol === "anthropic") return toAnthropic(request);
  if (providerProtocol === "gemini") {
    if (request.metadata?.parameters?.response_format) {
      throw new GatewayError("response_format conversion to Gemini is not enabled", {
        statusCode: 501,
        code: "unsupported_conversion"
      });
    }
    return toGemini(request);
  }
  throw new Error(`unsupported provider protocol ${providerProtocol}`);
}

function upstreamUrl(provider, facade, explicitPath, protocol = provider.protocol, model, stream = false) {
  if (explicitPath) return new URL(explicitPath, ensureTrailingSlash(provider.base_url)).toString();
  const suffix = protocol === "anthropic"
    ? "/messages"
    : protocol === "openai-response"
      ? "/responses"
      : protocol === "gemini"
        ? null
      : "/chat/completions";
  if (protocol === "gemini") return geminiUrl(provider, model, stream);
  return new URL(suffix.slice(1), ensureTrailingSlash(provider.base_url)).toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function upstreamHeaders(provider, requestId, runtimeSecret, protocol = provider.protocol) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-qoder-gateway-request-id": requestId
  };
  const apiKey = resolveProviderApiKey(provider, runtimeSecret);
  if (apiKey) {
    if (protocol === "anthropic") headers["x-api-key"] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  if (protocol === "anthropic") headers["anthropic-version"] = provider.anthropic_version ?? "2023-06-01";
  for (const [key, value] of Object.entries(provider.headers ?? {})) {
    if (/(authorization|api[-_]?key|token|secret)/i.test(key)) continue;
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function resolveProviderApiKey(provider, runtimeSecret) {
  const raw = runtimeSecret ?? (
    provider.api_key_env ? process.env[provider.api_key_env] : undefined
  );
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().replace(/^Bearer\s+/i, "");
  return value || undefined;
}

async function writeResult(res, result) {
  const upstream = result.response;
  const sameProtocol = (result.facade === "openai-chat" && result.providerProtocol === "openai")
    || (result.facade === "anthropic" && result.providerProtocol === "anthropic");
  const shouldConvertOpenAIResponses = result.facade === "openai-responses"
    && result.providerProtocol === "openai-response";
  if (result.streaming) {
    try {
      if (sameProtocol && !shouldConvertOpenAIResponses) {
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } else {
        await writeConvertedSse(res, upstream.body, result.providerProtocol, result.facade, result.request);
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) throw error;
      writeStreamFailure(res, result.facade, result.requestId, error);
      res.end();
    }
    return;
  }

  const value = await upstream.json();
  const converted = convertResponse(value, result.facade, result.providerProtocol);
  json(res, 200, addSafeToolSimulation(converted, result.facade, result.request));
}

function combinedRequestSignal(clientSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!clientSignal) return timeoutSignal;
  return AbortSignal.any([clientSignal, timeoutSignal]);
}

function writeStreamFailure(res, facade, requestId, error) {
  const message = truncate(redactText(error?.message ?? "upstream stream failed"), 400);
  if (facade === "openai-responses") {
    res.write(`event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response_id: requestId,
      error: { message }
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    return;
  }
  if (facade === "anthropic") {
    res.write(`event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "upstream_error", message }
    })}\n\n`);
    return;
  }
  res.write(`data: ${JSON.stringify({
    error: { type: "upstream_error", message }
  })}\n\n`);
  res.write("data: [DONE]\n\n");
}

function convertResponse(value, facade, providerProtocol) {
  if (facade === "openai-chat") {
    if (providerProtocol === "openai") return value;
    if (providerProtocol === "openai-response") return responsesToOpenAIChat(value);
    if (providerProtocol === "anthropic") return anthropicToOpenAI(value);
    if (providerProtocol === "gemini") return geminiToOpenAIChat(value);
  }
  if (facade === "openai-responses") {
    if (providerProtocol === "openai-response") return value;
    if (providerProtocol === "anthropic") return anthropicToResponses(value);
    if (providerProtocol === "openai") return openAIChatToResponsesResponse(value);
    if (providerProtocol === "gemini") return geminiToResponses(value);
  }
  if (facade === "anthropic") {
    if (providerProtocol === "anthropic") return value;
    if (providerProtocol === "openai-response") return responsesToAnthropic(value);
    if (providerProtocol === "openai") return openAIChatToAnthropicResponse(value);
  }
  throw new Error(`unsupported response conversion ${providerProtocol} -> ${facade}`);
}

function openAIChatToResponsesResponse(value) {
  const choice = value.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const output = [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  }];
  for (const call of choice?.message?.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments ?? "{}"
    });
  }
  return {
    id: value.id,
    object: "response",
    model: value.model,
    status: "completed",
    output,
    output_text: text,
    usage: value.usage
  };
}

function openAIChatToAnthropicResponse(value) {
  const choice = value.choices?.[0];
  const message = choice?.message ?? {};
  const content = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseObject(call.function?.arguments)
    });
  }
  return {
    id: value.id,
    type: "message",
    role: "assistant",
    model: value.model,
    content,
    stop_reason: message.tool_calls?.length ? "tool_use" : choice?.finish_reason ?? "end_turn",
    usage: value.usage
  };
}

function addSafeToolSimulation(value, facade, request) {
  if (!request.tools?.length) return value;
  const nativeCalls = extractToolCalls(value, facade);
  if (nativeCalls.length) return value;
  const text = extractText(value, facade);
  const simulated = parseSimulatedToolCalls(text, request.tools)[0];
  if (!simulated) return value;
  if (facade === "openai-chat") {
    const choice = value.choices?.[0];
    choice.message.tool_calls = [{
      id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      type: "function",
      function: { name: simulated.function.name, arguments: simulated.function.arguments }
    }];
    choice.message.content = text.replace(simulated.raw, "").trim() || null;
    choice.finish_reason = "tool_calls";
  } else if (facade === "openai-responses") {
    const callId = `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    value.output ||= [];
    value.output.push({
      type: "function_call",
      id: callId,
      call_id: callId,
      name: simulated.function.name,
      arguments: simulated.function.arguments
    });
    value.status = "completed";
  } else {
    value.content ||= [];
    value.content.push({
      type: "tool_use",
      id: `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      name: simulated.function.name,
      input: parseObject(simulated.function.arguments)
    });
    value.stop_reason = "tool_use";
  }
  return value;
}

function extractToolCalls(value, facade) {
  if (facade === "openai-chat") return value.choices?.[0]?.message?.tool_calls ?? [];
  if (facade === "openai-responses") return (value.output ?? []).filter((item) => item.type === "function_call");
  return (value.content ?? []).filter((item) => item.type === "tool_use");
}

function extractText(value, facade) {
  if (facade === "openai-chat") return value.choices?.[0]?.message?.content ?? "";
  if (facade === "openai-responses") return value.output_text ?? "";
  return (value.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("");
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getProvider(config, providerName) {
  const provider = config.providers[providerName];
  if (!provider) {
    const error = new Error(`unknown provider ${providerName}`);
    error.statusCode = 404;
    throw error;
  }
  return provider;
}

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([key]) => !/(authorization|api[-_]?key|token|secret)/i.test(key))
    .map(([key, value]) => [key, redactText(String(value))]));
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(api[-_]?key|auth|token|secret|password)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return redactText(value);
  }
}

function rememberRequest(recentRequests, entry) {
  recentRequests.unshift({
    request_id: entry.request_id,
    facade: entry.facade,
    model_alias: entry.model_alias,
    status: entry.status,
    error: entry.error ? truncate(redactText(entry.error), 300) : undefined,
    failures: Array.isArray(entry.failures)
      ? entry.failures.map((failure) => ({
        provider: failure.provider,
        model: failure.model,
        message: truncate(redactText(failure.message), 300),
        retryable: Boolean(failure.retryable)
      }))
      : undefined
  });
  recentRequests.splice(50);
}

export function redactText(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._~-]+\b/gi, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|authorization|x-api-key)"?\s*[:=]\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .replace(/((?:api[_-]?key|authorization|x-api-key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function truncate(text, max = 500) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function main() {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : "./config.json";
  const config = await loadConfig(configPath);
  const capabilities = new ModelCapabilityRegistry();
  const qoderPatchRunner = () => runQoderPatch(config);
  const server = http.createServer(createGateway(config, {
    configPath,
    capabilities,
    qoderPatchRunner
  }));
  const listen = config.listen ?? "127.0.0.1:8787";
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : "127.0.0.1";
  const port = Number(separator > 0 ? listen.slice(separator + 1) : listen);
  server.listen(port, host, () => {
    console.log(`qoder-bridge-gateway listening on http://${host}:${port}`);
    void (async () => {
      await refreshConfiguredCapabilities(globalThis.fetch, config, capabilities);
      if (config.qoder_patch?.enabled === true) await qoderPatchRunner();
    })();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(redactText(error.stack ?? error));
    process.exitCode = 1;
  });
}
