import { connectUnixJsonRpc } from "./transport.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createQoderIpcClient({
  socketPath,
  connectTimeoutMs = 5_000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxMessageBytes
} = {}) {
  let transport;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notificationListeners = new Set();
  const requestListeners = new Set();

  async function connect() {
    if (closed) throw new Error("Qoder IPC client is closed");
    if (transport) return transport;
    transport = connectUnixJsonRpc({
      socketPath,
      timeoutMs: connectTimeoutMs,
      maxMessageBytes,
      onMessage: handleMessage,
      onError: handleTransportError
    });
    transport.socket.once("close", () => {
      handleTransportError(new Error("Qoder IPC socket closed"));
    });
    await transport.ready;
    return transport;
  }

  async function request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    const id = nextId++;
    const connection = await connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Qoder IPC request timed out: ${method}`);
        error.code = "ETIMEDOUT";
        reject(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        connection.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function notify(method, params = {}) {
    const connection = await connect();
    connection.send({ jsonrpc: "2.0", method, params });
  }

  function onNotification(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("notification listener must be a function");
    }
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function onRequest(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("request listener must be a function");
    }
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  }

  function close() {
    if (closed) return;
    closed = true;
    transport?.close();
    handleTransportError(new Error("Qoder IPC client closed"));
  }

  function handleMessage(message) {
    if (message && message.id !== undefined && typeof message.method === "string") {
      void handleIncomingRequest(message);
      return;
    }
    if (message && message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "Qoder IPC request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    for (const listener of notificationListeners) {
      try {
        listener(message);
      } catch {
        // Notification observers must not break the transport.
      }
    }
  }

  async function handleIncomingRequest(message) {
    const listener = [...requestListeners].at(-1);
    if (!listener) {
      try {
        transport?.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported Qoder IPC request: ${message.method}` }
        });
      } catch {
        // The transport error will reject pending requests through its normal path.
      }
      return;
    }
    try {
      const result = await listener(message);
      transport?.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      try {
        transport?.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: error?.message ?? "Qoder IPC request failed" }
        });
      } catch {
        // The transport error will reject pending requests through its normal path.
      }
    }
  }

  function handleTransportError(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
    transport = undefined;
  }

  return {
    connect,
    request,
    notify,
    onNotification,
    close,
    get pendingCount() {
      return pending.size;
    },
    onRequest
  };
}

export function createObservedAcpClient(options = {}) {
  const client = createQoderIpcClient(options);
  return {
    ...client,
    initialize(params = {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "qoder-bridge", version: "0.1.0" }
    }) {
      return client.request("initialize", params);
    },
    sessionNew({ cwd, mcpServers = [], _meta = {} } = {}) {
      return client.request("session/new", { cwd, mcpServers, _meta });
    },
    sessionPrompt({ sessionId, prompt, _meta = {} } = {}) {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("sessionPrompt requires sessionId");
      }
      if (!Array.isArray(prompt)) {
        throw new TypeError("sessionPrompt requires a prompt array");
      }
      return client.request("session/prompt", { sessionId, prompt, _meta });
    },
    sessionCancel({ sessionId, _meta = {} } = {}) {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("sessionCancel requires sessionId");
      }
      return client.notify("session/cancel", { sessionId, _meta });
    },
    sessionLoad({
      sessionId,
      cwd,
      mcpServers = [],
      loadTillRequestId,
      loadRequestLimit,
      _meta = {}
    } = {}) {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("sessionLoad requires sessionId");
      }
      return client.request("session/load", {
        sessionId,
        cwd,
        mcpServers,
        ...(typeof loadTillRequestId === "string" && loadTillRequestId
          ? { loadTillRequestId }
          : {}),
        ...(Number.isInteger(loadRequestLimit) && loadRequestLimit > 0
          ? { loadRequestLimit }
          : {}),
        _meta
      });
    },
    sessionSetModel({ sessionId, modelId, _meta } = {}) {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("sessionSetModel requires sessionId");
      }
      if (typeof modelId !== "string" || !modelId) {
        throw new TypeError("sessionSetModel requires modelId");
      }
      return client.request("session/set_model", { sessionId, modelId, timestamp: Date.now(), _meta });
    }
  };
}
