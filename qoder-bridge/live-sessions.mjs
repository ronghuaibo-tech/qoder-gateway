import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createObservedAcpClient } from "./ipc-client.mjs";
import { toBridgeEvent } from "./events.mjs";
import { createBridgeToolRuntime } from "./tool-runtime.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const FORWARDED_EVENTS = new Set(["text_delta", "reasoning_delta", "tool_call", "done", "error"]);

export function createLiveSessionManager({
  qoderSocketPath,
  workspaceRoots = [],
  toolMode = "dry-run",
  allowedTools,
  ideWindowType = "quest",
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  handleRequest = async (message) => {
    throw new Error(`unsupported Qoder IPC request: ${message?.method ?? "unknown"}`);
  }
} = {}) {
  const sessions = new Map();

  async function open({
    sessionId,
    model,
    workspaceRoot,
    metadata = {},
    requestId = crypto.randomUUID(),
    loadTillRequestId,
    loadRequestLimit
  } = {}) {
    if (typeof qoderSocketPath !== "string" || qoderSocketPath.length === 0) {
      throw bridgeError("QODER_IPC_SOCKET is required for live IPC", 503, "ipc_socket_missing");
    }
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw bridgeError("workspace is required for live IPC", 400, "workspace_required");
    }
    if (sessionId && sessions.has(sessionId)) {
      return describe(sessions.get(sessionId));
    }

    const toolRuntime = createBridgeToolRuntime({
      workspaceRoots: [workspaceRoot],
      allowedTools,
      executionMode: toolMode
    });
    const client = createObservedAcpClient({
      socketPath: qoderSocketPath,
      connectTimeoutMs: 3_000,
      requestTimeoutMs
    });
    const session = {
      sessionId,
      model,
      workspaceRoot,
      metadata: {
        ...metadata,
        "ai-coding/workspace-path": workspaceRoot,
        ...(model ? { "ai-coding/model": model } : {})
      },
      requestId,
      ideWindowType: normalizeIdeWindowType(ideWindowType),
      loadTillRequestId,
      loadRequestLimit,
      toolRuntime,
      client,
      active: undefined,
      createdAt: Date.now(),
      stopRequests: undefined,
      stopNotifications: undefined
    };

    session.stopRequests = client.onRequest((message) => handleRequest(message, session));
    session.stopNotifications = client.onNotification((message) => {
      const event = toBridgeEvent(message);
      if (!FORWARDED_EVENTS.has(event.type) || !session.active) return;
      session.active.events.push(event);
      session.active.onEvent?.(event);
      if (event.type === "done" || event.type === "error") {
        session.active.settled = true;
        session.active.resolve();
      }
    });

    try {
      await client.initialize({
        processId: process.pid,
        rootPath: workspaceRoot,
        rootUri: pathToFileURL(workspaceRoot).href,
        workspaceFolders: [{
          uri: pathToFileURL(workspaceRoot).href,
          name: path.basename(workspaceRoot)
        }],
        clientInfo: { name: "qoder-bridge", version: "0.3.0" },
        ideWindowType: session.ideWindowType,
        capabilities: { workspace: { workspaceFolders: true } },
        _meta: session.metadata
      });

      const result = sessionId
        ? await client.sessionLoad({
          sessionId,
          cwd: workspaceRoot,
          mcpServers: [],
          loadTillRequestId,
          loadRequestLimit,
          _meta: session.metadata
        })
        : await client.sessionNew({
          cwd: workspaceRoot,
          mcpServers: [],
          _meta: session.metadata
        });
      const resolvedSessionId = result?.sessionId ?? sessionId;
      if (typeof resolvedSessionId !== "string" || !resolvedSessionId) {
        throw bridgeError("Qoder session open did not return sessionId", 502, "ipc_session_missing");
      }
      session.sessionId = resolvedSessionId;
      session.attached = Boolean(sessionId);
      if (typeof model === "string" && model.length > 0) {
        await client.sessionSetModel({
          sessionId: resolvedSessionId,
          modelId: model,
          _meta: session.metadata
        });
      }
      sessions.set(resolvedSessionId, session);
      return describe(session);
    } catch (error) {
      cleanup(session);
      throw error;
    }
  }

  async function prompt(sessionId, {
    prompt,
    requestId = crypto.randomUUID(),
    timeoutMs = requestTimeoutMs,
    onEvent
  } = {}) {
    const session = requireLiveSession(sessions, sessionId);
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw bridgeError("prompt or input is required", 400, "prompt_required");
    }
    if (session.active) {
      throw bridgeError("session already has an active prompt", 409, "session_busy");
    }

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    session.active = {
      requestId,
      events: [],
      onEvent,
      settled: false,
      resolve: resolveCompletion,
      reject: rejectCompletion
    };
    try {
      await session.client.sessionPrompt({
        sessionId,
        prompt: [{ type: "text", text: prompt }],
        _meta: {
          ...session.metadata,
          "ai-coding/request-id": requestId
        }
      });
      await waitForCompletion(completion, timeoutMs);
      return [...session.active.events];
    } finally {
      session.active = undefined;
    }
  }

  async function cancel(sessionId) {
    const session = requireLiveSession(sessions, sessionId);
    session.active?.reject(new Error("bridge session cancelled"));
    session.active = undefined;
    await session.client.sessionCancel({
      sessionId,
      _meta: { "ai-coding/request-id": session.requestId }
    });
    return true;
  }

  function close(sessionId) {
    const session = requireLiveSession(sessions, sessionId);
    cleanup(session);
    sessions.delete(sessionId);
    return true;
  }

  function get(sessionId) {
    return sessions.get(sessionId);
  }

  function list() {
    return [...sessions.values()].map(describe);
  }

  function dispose() {
    for (const session of sessions.values()) cleanup(session);
    sessions.clear();
  }

  return {
    open,
    prompt,
    cancel,
    close,
    get,
    list,
    dispose,
    size: () => sessions.size
  };
}

function describe(session) {
  return {
    session_id: session.sessionId,
    model: session.model,
    workspace_path: session.workspaceRoot,
    attached: session.attached === true,
    ide_window_type: session.ideWindowType,
    active: Boolean(session.active),
    created_at: session.createdAt
  };
}

function normalizeIdeWindowType(value) {
  return value === "editor" ? "editor" : "quest";
}

function requireLiveSession(sessions, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw bridgeError("session_id is required", 400, "session_id_required");
  }
  const session = sessions.get(sessionId);
  if (!session) {
    throw bridgeError("Qoder session is not open in Bridge", 404, "session_not_found");
  }
  return session;
}

function cleanup(session) {
  session.stopRequests?.();
  session.stopNotifications?.();
  session.client.close();
}

function waitForCompletion(completion, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("Qoder session prompt timed out");
      error.code = "ETIMEDOUT";
      reject(error);
    }, Math.max(Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, 1_000));
    completion.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function bridgeError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
