import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { redactText } from "../server.mjs";
import { bridgeEvents, toBridgeEvent } from "./events.mjs";
import { createObservedAcpClient } from "./ipc-client.mjs";
import { createLiveSessionManager } from "./live-sessions.mjs";
import { validateBridgePermissions } from "./permissions.mjs";
import { createSessionStore } from "./session.mjs";
import { createBridgeToolRuntime } from "./tool-runtime.mjs";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787";
const DEFAULT_LISTEN = "127.0.0.1:8890";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOOL_MODE = "dry-run";
const PASSIVE_QODER_REQUESTS = new Set([
  "chat/process_step_callback",
  "task/planProgress/content/sync",
  "task/status/sync",
  "snapshot/syncAll",
  "user/inprogress/task/sync",
  "user/task/stats/sync",
  "session/title/update",
  "tool/call/approve"
]);

export function createBridgeHandler({
  gatewayUrl = DEFAULT_GATEWAY_URL,
  fetchImpl = globalThis.fetch,
  sessions = createSessionStore(),
  maxBodyBytes = MAX_BODY_BYTES,
  enableLiveIpc = false,
  qoderSocketPath,
  workspaceRoots = [process.cwd()],
  toolMode = DEFAULT_TOOL_MODE,
  allowedTools
} = {}) {
  const baseUrl = gatewayUrl.replace(/\/+$/, "");
  const liveSessions = createLiveSessionManager({
    qoderSocketPath,
    workspaceRoots,
    toolMode: normalizeToolMode(toolMode),
    allowedTools,
    handleRequest: (message, session) => handleQoderRequest(message, {
      requestId: session.active?.requestId ?? session.requestId,
      toolRuntime: session.toolRuntime
    })
  });
  return async function bridgeHandler(req, res) {
    const requestId = req.headers["x-qoder-bridge-request-id"] || crypto.randomUUID();
    res.setHeader("X-Qoder-Bridge-Request-Id", requestId);
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return writeJson(res, 200, {
          ok: true,
          service: "qoder-bridge",
          gateway_url: baseUrl,
          active_sessions: sessions.size()
        });
      }
      const isGatewayPrompt = req.method === "POST"
        && (url.pathname === "/bridge/session/prompt"
          || url.pathname === "/bridge/gateway/session/prompt");
      if (isGatewayPrompt) {
        const body = await readJson(req, maxBodyBytes);
        const sessionId = body.request_id || requestId;
        const session = sessions.create(sessionId);
        req.on("aborted", () => session.controller.abort());
        try {
          const upstream = await fetchImpl(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify(toGatewayBody(body)),
            signal: session.controller.signal
          });
          if (!upstream.ok) {
            const text = await upstream.text();
            throw bridgeError(`gateway ${upstream.status}: ${redactText(text)}`, upstream.status);
          }
          if (body.stream === true) {
            await writeStream(res, upstream.body, sessionId);
          } else {
            writeJson(res, 200, {
              backend: "gateway",
              request_id: sessionId,
              response: await upstream.json()
            });
          }
        } finally {
          sessions.delete(sessionId);
        }
        return;
      }
      const cancelMatch = req.method === "POST"
        ? url.pathname.match(/^\/bridge\/session\/([^/]+)\/cancel$/)
        : null;
      if (cancelMatch) {
        const sessionId = decodeURIComponent(cancelMatch[1]);
          return writeJson(res, 200, { request_id: sessionId, cancelled: sessions.cancel(sessionId) });
      }
      if (req.method === "POST" && url.pathname === "/bridge/qoder/session/prompt") {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        return await handleLiveQoderPrompt({
          req,
          res,
          body: await readJson(req, maxBodyBytes),
          requestId,
          sessions,
          qoderSocketPath,
          workspaceRoots,
          toolMode,
          allowedTools
        });
      }
      if (req.method === "GET" && url.pathname === "/bridge/qoder/sessions") {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        writeJson(res, 200, { sessions: liveSessions.list() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/bridge/qoder/session/open") {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        const body = await readJson(req, maxBodyBytes);
        const workspaceRoot = resolveWorkspaceRoot(
          body.cwd ?? body.workspace_path ?? body.workspace?.path,
          workspaceRoots
        );
        if (!workspaceRoot) {
          throw bridgeError(
            "workspace is outside the configured Bridge roots",
            403,
            "workspace_not_allowed"
          );
        }
        if (typeof body.model !== "string" || body.model.length === 0) {
          throw bridgeError("model is required when creating a Qoder session", 400, "model_required");
        }
        const session = await liveSessions.open({
          sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
          model: body.model,
          workspaceRoot,
          ideWindowType: body.ide_window_type ?? body.ideWindowType,
          requestId: body.request_id || requestId,
          loadTillRequestId: body.load_till_request_id ?? body.loadTillRequestId,
          loadRequestLimit: normalizeLoadRequestLimit(
            body.load_request_limit ?? body.loadRequestLimit
          ),
          metadata: body.metadata && typeof body.metadata === "object"
            ? body.metadata
            : {}
        });
        writeJson(res, 200, { request_id: requestId, ...session });
        return;
      }
      const livePromptMatch = req.method === "POST"
        ? url.pathname.match(/^\/bridge\/qoder\/session\/([^/]+)\/prompt$/)
        : null;
      if (livePromptMatch) {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        const sessionId = decodeURIComponent(livePromptMatch[1]);
        const body = await readJson(req, maxBodyBytes);
        const prompt = typeof body.prompt === "string"
          ? body.prompt
          : typeof body.input === "string"
            ? body.input
            : "";
        const stream = body.stream === true;
        if (stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no"
          });
        }
        req.on("aborted", () => {
          void liveSessions.cancel(sessionId).catch(() => {});
        });
        const events = await liveSessions.prompt(sessionId, {
          prompt,
          requestId: body.request_id || requestId,
          timeoutMs: body.timeout_ms,
          onEvent: stream
            ? (event) => writeBridgeEvent(res, requestId, event)
            : undefined
        });
        if (stream) {
          if (!res.writableEnded) res.end();
        } else {
          writeJson(res, 200, {
            request_id: requestId,
            session_id: sessionId,
            events
          });
        }
        return;
      }
      const liveCancelMatch = req.method === "POST"
        ? url.pathname.match(/^\/bridge\/qoder\/session\/([^/]+)\/cancel$/)
        : null;
      if (liveCancelMatch) {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        const sessionId = decodeURIComponent(liveCancelMatch[1]);
        writeJson(res, 200, {
          request_id: requestId,
          session_id: sessionId,
          cancelled: await liveSessions.cancel(sessionId)
        });
        return;
      }
      const liveCloseMatch = req.method === "POST"
        ? url.pathname.match(/^\/bridge\/qoder\/session\/([^/]+)\/close$/)
        : null;
      if (liveCloseMatch) {
        if (!enableLiveIpc) {
          throw bridgeError("live Qoder IPC is disabled", 503, "live_ipc_disabled");
        }
        const sessionId = decodeURIComponent(liveCloseMatch[1]);
        writeJson(res, 200, {
          request_id: requestId,
          session_id: sessionId,
          closed: liveSessions.close(sessionId)
        });
        return;
      }
      writeJson(res, 404, { error: { type: "not_found", message: "route not found" } });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy(error);
        return;
      }
      const status = error.statusCode ?? 400;
      writeJson(res, status, {
        request_id: requestId,
        error: { type: error.code ?? "bridge_error", message: redactText(error.message) }
      });
    }
  };
}

function toGatewayBody(body) {
  return {
    model: body.model,
    input: body.input ?? body.prompt ?? "",
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    tool_choice: body.tool_choice,
    stream: body.stream === true,
    reasoning: body.reasoning,
    metadata: {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      bridge_request: true
    }
  };
}

async function writeStream(res, body, requestId) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  for await (const event of bridgeEvents(body)) {
    writeBridgeEvent(res, requestId, event);
    if (event.type === "done" || event.type === "error") break;
  }
  res.end();
}

function writeBridgeEvent(res, requestId, event) {
  if (res.writableEnded) return;
  res.write(`event: bridge.event\ndata: ${JSON.stringify({
    request_id: requestId,
    event: event.type,
    data: event.data
  })}\n\n`);
}

function bridgeError(message, statusCode, code = "gateway_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function handleLiveQoderPrompt({
  req,
  res,
  body,
  requestId,
  sessions,
  qoderSocketPath,
  workspaceRoots,
  toolMode,
  allowedTools
}) {
  if (typeof qoderSocketPath !== "string" || qoderSocketPath.length === 0) {
    throw bridgeError("QODER_IPC_SOCKET is required for live IPC", 503, "ipc_socket_missing");
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw bridgeError("model is required for live Qoder IPC", 400, "model_required");
  }
  const prompt = typeof body.prompt === "string"
    ? body.prompt
    : typeof body.input === "string"
      ? body.input
      : "";
  if (!prompt) {
    throw bridgeError("prompt or input is required", 400, "prompt_required");
  }
  const workspaceRoot = resolveWorkspaceRoot(
    body.cwd ?? body.workspace_path ?? body.workspace?.path,
    workspaceRoots
  );
  if (!workspaceRoot) {
    throw bridgeError(
      "workspace is outside the configured Bridge roots",
      403,
      "workspace_not_allowed"
    );
  }

  const sessionKey = body.request_id || requestId;
  const bridgeSession = sessions.create(sessionKey);
  const requestTimeoutMs = Math.min(
    Math.max(Number(body.timeout_ms) || 30_000, 1_000),
    120_000
  );
  const toolRuntime = createBridgeToolRuntime({
    workspaceRoots: [workspaceRoot],
    allowedTools,
    executionMode: normalizeToolMode(toolMode)
  });
  const client = createObservedAcpClient({
    socketPath: qoderSocketPath,
    connectTimeoutMs: 3_000,
    requestTimeoutMs
  });
  const events = [];
  let qoderSessionId;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const stopRequests = client.onRequest((message) => handleQoderRequest(message, {
    requestId,
    toolRuntime
  }));
  const stopNotifications = client.onNotification((message) => {
    const event = toBridgeEvent(message);
    if (!["text_delta", "reasoning_delta", "tool_call", "done", "error"].includes(event.type)) {
      return;
    }
    events.push(event);
    if (res.headersSent && !res.writableEnded) {
      res.write(`event: bridge.event\ndata: ${JSON.stringify({
        request_id: requestId,
        event: event.type,
        data: event.data
      })}\n\n`);
    }
    if (event.type === "done" || event.type === "error") {
      settled = true;
      resolveCompletion();
    }
  });

  req.on("aborted", () => {
    bridgeSession.controller.abort();
    if (!settled) rejectCompletion(new Error("bridge request aborted"));
  });
  bridgeSession.controller.signal.addEventListener("abort", () => {
    if (!settled) rejectCompletion(new Error("bridge request cancelled"));
  }, { once: true });

  try {
    const stream = body.stream === true;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
    }
    const metadata = {
      "ai-coding/model": body.model,
      "ai-coding/workspace-path": workspaceRoot
    };
    const clientInfo = {
      name: "qoder-bridge",
      version: "0.2.0"
    };
    await client.initialize({
      processId: process.pid,
      rootPath: workspaceRoot,
      rootUri: pathToFileURL(workspaceRoot).href,
      workspaceFolders: [{
        uri: pathToFileURL(workspaceRoot).href,
        name: path.basename(workspaceRoot)
      }],
      clientInfo,
      capabilities: { workspace: { workspaceFolders: true } },
      ideWindowType: normalizeIdeWindowType(
        body.ide_window_type ?? body.ideWindowType
      ),
      _meta: metadata
    });
    const created = await client.sessionNew({
      cwd: workspaceRoot,
      mcpServers: [],
      _meta: metadata
    });
    qoderSessionId = created?.sessionId;
    if (typeof qoderSessionId !== "string" || !qoderSessionId) {
      throw bridgeError("Qoder session/new did not return sessionId", 502, "ipc_session_missing");
    }
    await client.sessionPrompt({
      sessionId: qoderSessionId,
      prompt: [{ type: "text", text: prompt }],
      _meta: {
        ...metadata,
        "ai-coding/request-id": requestId
      }
    });

    await waitForCompletion(completion, requestTimeoutMs);
    if (!stream) {
      writeJson(res, 200, {
        request_id: requestId,
        session_id: qoderSessionId,
        events
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    stopRequests();
    stopNotifications();
    if (qoderSessionId) {
      try {
        await client.sessionCancel({
          sessionId: qoderSessionId,
          _meta: { "ai-coding/request-id": requestId }
        });
      } catch {
        // Cleanup is best effort after a completed or aborted probe.
      }
    }
    client.close();
    sessions.delete(sessionKey);
  }
}

async function handleQoderRequest(message, {
  requestId,
  toolRuntime
} = {}) {
  const params = message?.params && typeof message.params === "object"
    ? message.params
    : {};
  if (message?.method === "tool/invoke") {
    const name = typeof params.name === "string" ? params.name : "";
    const parameters = normalizeQoderToolParameters(params.parameters);
    const result = await toolRuntime.execute({
      id: params.toolCallId,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(parameters)
      }
    }, { requestId: params.requestId ?? requestId });
    return toQoderToolResult(params, result, name);
  }
  if (message?.method === "session/request_permission") {
    return {
      requestId: params.requestId,
      errorMessage: "Bridge does not grant interactive permission requests",
      successful: false
    };
  }
  if (PASSIVE_QODER_REQUESTS.has(message?.method)) {
    return {};
  }
  throw new Error(`unsupported Qoder IPC request: ${message?.method ?? "unknown"}`);
}

function normalizeQoderToolParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return {};
  }
  const normalized = { ...parameters };
  if (typeof normalized.path !== "string" && typeof normalized.file_path === "string") {
    normalized.path = normalized.file_path;
  }
  if (typeof normalized.path !== "string" && typeof normalized.filePath === "string") {
    normalized.path = normalized.filePath;
  }
  return normalized;
}

function toQoderToolResult(params, result, name) {
  const content = parseToolContent(result?.content);
  const dryRun = content?.dry_run === true;
  return {
    toolCallId: params.toolCallId,
    name: name || params.name,
    success: Boolean(result?.ok) && !dryRun,
    ...(result?.ok && !dryRun ? {} : {
      errorMessage: dryRun
        ? "Bridge tool execution is in dry-run mode"
        : String(result?.content ?? "tool execution failed")
    }),
    result: content ?? {}
  };
}

function parseToolContent(content) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return { content };
  }
}

function normalizeToolMode(value) {
  return value === "controlled" ? "controlled" : DEFAULT_TOOL_MODE;
}

function normalizeIdeWindowType(value) {
  return value === "editor" ? "editor" : "quest";
}

function normalizeLoadRequestLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function resolveWorkspaceRoot(requestedRoot, workspaceRoots) {
  const candidate = path.resolve(
    typeof requestedRoot === "string" && requestedRoot.length > 0
      ? requestedRoot
      : process.cwd()
  );
  const roots = (Array.isArray(workspaceRoots) ? workspaceRoots : [])
    .filter((root) => typeof root === "string" && root.length > 0)
    .map((root) => path.resolve(root));
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
    ? candidate
    : undefined;
}

function waitForCompletion(completion, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs);
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

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw bridgeError("request body is too large", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw bridgeError("request body must be valid JSON", 400);
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export function startBridgeServer({
  listen = process.env.QODER_BRIDGE_LISTEN ?? DEFAULT_LISTEN,
  gatewayUrl = process.env.QODER_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
  fetchImpl,
  enableLiveIpc = process.env.QODER_BRIDGE_ENABLE_LIVE_IPC === "1",
  qoderSocketPath = process.env.QODER_IPC_SOCKET,
  workspaceRoots = parseWorkspaceRoots(process.env.QODER_BRIDGE_WORKSPACE_ROOTS),
  toolMode = process.env.QODER_BRIDGE_TOOL_MODE ?? DEFAULT_TOOL_MODE,
  allowedTools = parseAllowedTools(process.env.QODER_BRIDGE_ALLOWED_TOOLS)
} = {}) {
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : "127.0.0.1";
  const port = Number(separator > 0 ? listen.slice(separator + 1) : listen);
  validateBridgePermissions({ listenHost: host });
  const server = http.createServer(createBridgeHandler({
    gatewayUrl,
    fetchImpl,
    enableLiveIpc,
    qoderSocketPath,
    workspaceRoots,
    toolMode,
    allowedTools
  }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, host, port }));
  });
}

function parseWorkspaceRoots(value) {
  if (typeof value === "string" && value.trim()) {
    return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  }
  return [process.cwd()];
}

function parseAllowedTools(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startBridgeServer().then(({ host, port }) => {
    console.log(`qoder-bridge listening on http://${host}:${port}`);
  }).catch((error) => {
    console.error(redactText(error.stack ?? error));
    process.exitCode = 1;
  });
}
