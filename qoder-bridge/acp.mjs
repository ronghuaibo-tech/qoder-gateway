import { ACP_METHODS, ACP_UPDATE_TYPES, classifyAcpEnvelope } from "./protocol.mjs";

export { ACP_METHODS, ACP_UPDATE_TYPES };

export function normalizeAcpRequest(payload = {}) {
  const method = payload.method ?? payload.kind;
  const params = payload.params ?? payload.data ?? {};
  const sessionId = payload.sessionId ?? params.sessionId;
  const prompt = params.prompt ?? params.content ?? params.message;
  return {
    method,
    sessionId,
    requestId: payload.requestId ?? payload._meta?.["ai-coding/request-id"],
    model: params.model ?? params.modelId,
    prompt: typeof prompt === "string" ? prompt : extractText(prompt),
    metadata: params._meta ?? payload._meta ?? {},
    shape: classifyAcpEnvelope(payload)
  };
}

export function createAcpProgress(sessionId, update, {
  requestId,
  metadata = {},
  kind = "session/update"
} = {}) {
  return {
    sessionId,
    kind,
    data: { sessionId, update },
    _meta: {
      ...metadata,
      ...(requestId ? { "ai-coding/request-id": requestId } : {})
    },
    timestamp: Date.now()
  };
}

export function createAcpPromptResult(sessionId, stopReason = "completed", {
  requestId,
  metadata = {},
  result = {}
} = {}) {
  return {
    sessionId,
    kind: "session/prompt",
    data: { sessionId, stopReason, ...result },
    _meta: {
      ...metadata,
      ...(requestId ? { "ai-coding/request-id": requestId } : {})
    },
    timestamp: Date.now()
  };
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text ?? "")
    .join("");
}
