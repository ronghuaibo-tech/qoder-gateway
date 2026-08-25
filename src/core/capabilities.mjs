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
      if (model.reasoning === true || model.supports_reasoning === true
        || normalizeReasoningEfforts(
          model.reasoning_efforts
            ?? model.supported_reasoning_efforts
            ?? model.reasoning?.efforts
        ).length > 0) {
        capabilities.reasoning = true;
      }
      this.#models.set(key(providerName, model.id), {
        provider: providerName,
        id: model.id,
        capabilities,
        supported_endpoint_types: [...supported],
        raw: sanitizeModelMetadata(model),
        runtime: runtimeMetadata(model, capabilities)
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
      .map((model) => ({
        ...model,
        capabilities: { ...model.capabilities },
        runtime: cloneRuntimeMetadata(model.runtime)
      }));
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

export function runtimeForModel(registry, providerName, modelId) {
  return cloneRuntimeMetadata(registry?.get(providerName, modelId)?.runtime);
}

export function runtimeMetadata(model, capabilities = normalizeCapabilities(
  model?.supported_endpoint_types
)) {
  const contextLengths = positiveIntegers(
    model?.context_lengths
      ?? model?.supported_context_lengths
      ?? model?.context_windows
      ?? model?.supported_context_windows
  );
  const maxContext = positiveInteger(
    model?.max_input_tokens
      ?? model?.max_context_tokens
      ?? model?.max_context_length
      ?? model?.context_window
      ?? model?.context_length
  );
  const normalizedContextLengths = contextLengths.length
    ? contextLengths
    : maxContext !== undefined ? [maxContext] : [];
  const reasoningEfforts = normalizeReasoningEfforts(
    model?.reasoning_efforts
      ?? model?.supported_reasoning_efforts
      ?? model?.reasoning?.efforts
  );
  return {
    contextLengths: normalizedContextLengths,
    maxInputTokens: maxContext ?? (
      Math.max(...normalizedContextLengths, 0) || undefined
    ),
    reasoningEfforts,
    reasoning: capabilities.reasoning === true || reasoningEfforts.length > 0,
    reasoningRequired: model?.reasoning_required === true,
    reasoningDisabled: model?.reasoning_disabled !== false
  };
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
      : [],
    context_lengths: model.context_lengths,
    supported_context_lengths: model.supported_context_lengths,
    context_windows: model.context_windows,
    supported_context_windows: model.supported_context_windows,
    max_input_tokens: model.max_input_tokens,
    max_context_tokens: model.max_context_tokens,
    max_context_length: model.max_context_length,
    context_window: model.context_window,
    context_length: model.context_length,
    reasoning_efforts: model.reasoning_efforts,
    supported_reasoning_efforts: model.supported_reasoning_efforts,
    input_modalities: model.input_modalities
      ?? model.modalities?.input,
    output_modalities: model.output_modalities
      ?? model.modalities?.output,
    supports_reasoning: model.supports_reasoning,
    reasoning: model.reasoning
  };
}

function cloneRuntimeMetadata(value) {
  if (!value) return undefined;
  return {
    contextLengths: [...(value.contextLengths ?? [])],
    maxInputTokens: value.maxInputTokens,
    reasoningEfforts: [...(value.reasoningEfforts ?? [])],
    reasoning: value.reasoning === true,
    reasoningRequired: value.reasoningRequired === true,
    reasoningDisabled: value.reasoningDisabled !== false
  };
}

function positiveInteger(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function positiveIntegers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positiveInteger).filter((item) => item !== undefined))].sort((a, b) => a - b);
}

function normalizeReasoningEfforts(value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .map((item) => typeof item === "string" ? item.trim().toLowerCase() : "")
      .filter(Boolean))];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeReasoningEfforts(Object.keys(value));
  }
  return [];
}
