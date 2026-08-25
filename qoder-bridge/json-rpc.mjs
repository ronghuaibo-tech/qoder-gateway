const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export function encodeJsonRpcMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export function createContentLengthParser({
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES
} = {}) {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("JSON-RPC input must be a Buffer");
      }
      if (chunk.length > 0) buffer = Buffer.concat([buffer, chunk]);

      const messages = [];
      while (true) {
        const headerEnd = findHeaderEnd(buffer);
        if (headerEnd < 0) {
          if (buffer.length > MAX_HEADER_BYTES) {
            throw new RangeError("JSON-RPC header is too large");
          }
          break;
        }

        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const contentLength = parseContentLength(header);
        if (contentLength > maxMessageBytes) {
          throw new RangeError("JSON-RPC message is too large");
        }

        const bodyStart = headerEnd + headerDelimiterLength(buffer, headerEnd);
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) break;

        const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.subarray(bodyEnd);
        try {
          messages.push(JSON.parse(body));
        } catch {
          throw new SyntaxError("JSON-RPC message body is not valid JSON");
        }
      }
      return messages;
    },
    reset() {
      buffer = Buffer.alloc(0);
    },
    bufferedBytes() {
      return buffer.length;
    }
  };
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

function headerDelimiterLength(buffer, headerEnd) {
  return buffer.subarray(headerEnd, headerEnd + 4).equals(Buffer.from("\r\n\r\n"))
    ? 4
    : 2;
}

function parseContentLength(header) {
  const line = header
    .split(/\r?\n/)
    .find((entry) => /^content-length\s*:/i.test(entry));
  const value = line?.replace(/^content-length\s*:/i, "").trim();
  if (!/^\d+$/.test(value ?? "")) {
    throw new SyntaxError("JSON-RPC header must include a numeric Content-Length");
  }
  return Number(value);
}

