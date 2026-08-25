const TYPE_ALIASES = new Map([
  ["openai", "chat"],
  ["openai-chat", "chat"],
  ["chat", "chat"],
  ["chat-completions", "chat"],
  ["openai-response", "responses"],
  ["openai-responses", "responses"],
  ["responses", "responses"],
  ["anthropic", "anthropic"],
  ["messages", "anthropic"],
  ["gemini", "chat"],
  ["gemini-chat", "chat"],
  ["stream", "stream"],
  ["gemini-stream", "stream"],
  ["streaming", "stream"],
  ["tools", "tools"],
  ["tool", "tools"],
  ["vision", "vision"],
  ["images", "vision"],
  ["reasoning", "reasoning"]
]);

export class ModelCapabilityRegistry {
  #models = new Map();

  record(providerName, catalog) {
    for (const model of catalog ?? []) {
      if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
      const supported = Array.isArray(model.supported_endpoint_types)
        ? model.supported_endpoint_types
        : [];
      const capabilities = normalizeCapabilities(supported);
      this.#models.set(key(providerName, model.id), {
        provider: providerName,
        id: model.id,
        capabilities,
        supported_endpoint_types: [...supported],
        raw: sanitizeModelMetadata(model)
      });
    }
    return this.list(providerName);
  }

  get(providerName, modelId) {
    return this.#models.get(key(providerName, modelId));
  }

  hasProvider(providerName) {
    return [...this.#models.values()].some((model) => model.provider === providerName);
  }

  list(providerName) {
    return [...this.#models.values()]
      .filter((model) => model.provider === providerName)
      .map((model) => ({ ...model, capabilities: { ...model.capabilities } }));
  }

  supports(providerName, modelId, capability) {
    const model = this.get(providerName, modelId);
    return model ? model.capabilities[capability] === true : undefined;
  }
}

export function normalizeCapabilities(supportedEndpointTypes = []) {
  const capabilities = {
    chat: false,
    responses: false,
    anthropic: false,
    stream: false,
    tools: false,
    vision: false,
    reasoning: false
  };
  for (const type of supportedEndpointTypes) {
    const capability = TYPE_ALIASES.get(String(type).toLowerCase());
    if (capability) capabilities[capability] = true;
  }
  return capabilities;
}

export function facadeCapability(facade) {
  if (facade === "openai-chat") return "chat";
  if (facade === "openai-responses") return "responses";
  if (facade === "anthropic") return "anthropic";
  return undefined;
}

export function capabilitiesForModel(registry, providerName, modelId) {
  return registry?.get(providerName, modelId)?.capabilities ?? null;
}

function key(providerName, modelId) {
  return `${providerName}\u0000${modelId}`;
}

function sanitizeModelMetadata(model) {
  return {
    id: model.id,
    object: model.object,
    created: model.created,
    owned_by: model.owned_by,
    supported_endpoint_types: Array.isArray(model.supported_endpoint_types)
      ? [...model.supported_endpoint_types]
      : []
  };
}
