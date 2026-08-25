const FACADE_TYPES = new Set(["openai-chat", "openai-responses", "anthropic"]);

export function normalizeRequest(facade, body = {}, context = {}) {
  if (!FACADE_TYPES.has(facade)) {
    throw new Error(`unsupported request facade ${facade}`);
  }

  const messages = [...(body.messages ?? [])];
  if (facade === "anthropic" && body.system !== undefined) {
    messages.unshift({ role: "system", content: body.system });
  }
  const parameters = collectParameters(body);
  return compactObject({
    id: context.id ?? body.id,
    facade,
    model: context.model ?? context.upstreamModel ?? body.model,
    modelAlias: context.modelAlias ?? body.model,
    upstreamModel: context.upstreamModel,
    messages,
    input: facade === "openai-responses" ? body.input : undefined,
    tools: Array.isArray(body.tools) ? body.tools : [],
    tool_choice: body.tool_choice ?? body.toolChoice,
    images: collectImages({ messages, input: body.input }),
    stream: body.stream === true,
    reasoning: body.reasoning ?? body.reasoning_effort,
    temperature: body.temperature,
    topP: body.top_p ?? body.topP,
    maxTokens: body.max_tokens
      ?? body.max_completion_tokens
      ?? body.max_output_tokens
      ?? body.maxTokens,
    metadata: {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      source_facade: facade,
      parameters
    }
  });
}

export function cloneWithModel(request, model) {
  return { ...request, upstreamModel: model };
}

export function modelFor(request) {
  return request.upstreamModel ?? request.model ?? request.modelAlias;
}

export function collectImages({ messages = [], input } = {}) {
  const images = [];
  walkContent(messages, images);
  walkContent(input, images);
  return images;
}

function walkContent(value, images) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) walkContent(item, images);
    return;
  }
  if (typeof value !== "object") return;

  if (value.type === "image_url" && value.image_url) {
    images.push(value.image_url.url ?? value.image_url);
  } else if (value.type === "image" && value.source) {
    images.push(value.source.url ?? value.source.data ?? value.source);
  } else if (value.type === "input_image") {
    images.push(value.image_url ?? value.image ?? value.source);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walkContent(child, images);
  }
}

function collectParameters(body) {
  const keys = [
    "temperature",
    "top_p",
    "topP",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "stop",
    "parallel_tool_calls",
    "store",
    "include",
    "truncation",
    "user",
    "response_format"
  ];
  return compactObject(Object.fromEntries(keys
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]])));
}

export function parameter(request, key, fallback) {
  const direct = {
    temperature: request.temperature,
    top_p: request.topP,
    topP: request.topP,
    max_tokens: request.maxTokens,
    max_completion_tokens: request.maxTokens,
    max_output_tokens: request.maxTokens
  }[key];
  return direct !== undefined ? direct : request.metadata?.parameters?.[key] ?? fallback;
}

export function userMetadata(request) {
  const metadata = request.metadata && typeof request.metadata === "object"
    ? { ...request.metadata }
    : {};
  delete metadata.source_facade;
  delete metadata.parameters;
  return metadata;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
