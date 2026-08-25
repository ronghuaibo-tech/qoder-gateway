export class GatewayError extends Error {
  constructor(message, {
    statusCode = 500,
    code = "gateway_error",
    retryable = false,
    details
  } = {}) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function upstreamStatusError(status, message) {
  return new GatewayError(message, {
    statusCode: status,
    code: status >= 500 ? "upstream_error" : "upstream_request_error",
    retryable: isRetryableStatus(status)
  });
}

export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function errorPayload(error, requestId) {
  return {
    error: {
      message: sanitizeErrorText(error?.message ?? error),
      type: error?.code ?? "gateway_error",
      request_id: requestId
    }
  };
}

export function sanitizeErrorText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._~-]+\b/gi, "[REDACTED_SECRET]")
    .replace(/("?(?:api[_-]?key|authorization|x-api-key|cookie|secret)"?\s*[:=]\s*)"[^"]*"/gi, "$1\"[REDACTED_SECRET]\"")
    .replace(/((?:api[_-]?key|authorization|x-api-key|cookie|secret)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED_SECRET]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]+/gi, "$1[REDACTED_SECRET]");
}
