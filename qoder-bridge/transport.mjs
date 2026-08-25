import net from "node:net";
import { createContentLengthParser, encodeJsonRpcMessage } from "./json-rpc.mjs";

export function probeUnixSocket(socketPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ socket_path: socketPath, ...result });
    };
    const timer = setTimeout(() => finish({ ipc: false, timeout: true }), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish({ ipc: true });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish({ ipc: false, error: error.code ?? error.message });
    });
  });
}

export function connectUnixJsonRpc({
  socketPath,
  onMessage,
  onError,
  timeoutMs = 800,
  maxMessageBytes
} = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new TypeError("socketPath is required");
  }
  const parser = createContentLengthParser({ maxMessageBytes });
  const socket = net.createConnection({ path: socketPath });
  const connectTimer = setTimeout(() => {
    const error = new Error("Qoder IPC socket connection timed out");
    error.code = "ETIMEDOUT";
    onError?.(error);
    socket.destroy(error);
  }, timeoutMs);
  socket.once("connect", () => clearTimeout(connectTimer));
  socket.once("close", () => clearTimeout(connectTimer));
  socket.on("data", (chunk) => {
    try {
      for (const message of parser.push(chunk)) onMessage?.(message);
    } catch (error) {
      onError?.(error);
      socket.destroy(error);
    }
  });
  socket.on("error", (error) => {
    clearTimeout(connectTimer);
    onError?.(error);
  });

  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }),
    send(message) {
      if (socket.destroyed) throw new Error("Qoder IPC socket is closed");
      socket.write(encodeJsonRpcMessage(message));
    },
    close() {
      socket.end();
    }
  };
}
