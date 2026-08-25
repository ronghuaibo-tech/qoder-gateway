import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeHandler } from "../qoder-bridge/server.mjs";
import { toAcpProgress, toBridgeEvent } from "../qoder-bridge/events.mjs";
import { normalizeAcpRequest } from "../qoder-bridge/acp.mjs";
import { classifyAcpEnvelope, inspectProtocolPayload } from "../qoder-bridge/protocol.mjs";
import { createContentLengthParser, encodeJsonRpcMessage } from "../qoder-bridge/json-rpc.mjs";
import { createObservedAcpClient } from "../qoder-bridge/ipc-client.mjs";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function request(baseUrl, pathname, body, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, baseUrl), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

test("bridge forwards a text prompt with a request id", async () => {
  let gatewayBody;
  const gateway = await startServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      gatewayBody = JSON.parse(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-1", output_text: "bridge ok", status: "completed" }));
    });
  });
  const bridge = await startServer(createBridgeHandler({ gatewayUrl: gateway.baseUrl }));
  const response = await request(bridge.baseUrl, "/bridge/session/prompt", {
    request_id: "request-1",
    model: "alias",
    input: "hello"
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).request_id, "request-1");
  assert.equal(gatewayBody.model, "alias");
  assert.equal(gatewayBody.input, "hello");
  await new Promise((resolve) => gateway.server.close(resolve));
  await new Promise((resolve) => bridge.server.close(resolve));
});

test("explicit gateway bridge endpoint never selects the Qoder Agent model", async () => {
  let gatewayBody;
  const gateway = await startServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      gatewayBody = JSON.parse(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-gateway-1",
        object: "response",
        model: "gpt-5.5",
        output_text: "gateway backend",
        status: "completed"
      }));
    });
  });
  const bridge = await startServer(createBridgeHandler({ gatewayUrl: gateway.baseUrl }));
  try {
    const response = await request(bridge.baseUrl, "/bridge/gateway/session/prompt", {
      request_id: "gateway-request-1",
      model: "qwen3.8-max",
      input: "hello"
    });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.backend, "gateway");
    assert.equal(payload.response.model, "gpt-5.5");
    assert.equal(gatewayBody.model, "qwen3.8-max");
    assert.equal(gatewayBody.input, "hello");
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    await new Promise((resolve) => bridge.server.close(resolve));
  }
});

test("live Qoder IPC bridge forwards real session events when explicitly enabled", async () => {
  const socketPath = `/tmp/qoder-bridge-live-${process.pid}-${Date.now()}.sock`;
  const ipcMessages = [];
  const ipcServer = net.createServer((socket) => {
    const parser = createContentLengthParser();
    socket.on("data", (chunk) => {
      for (const message of parser.push(chunk)) {
        ipcMessages.push(message);
        if (message.method === "initialize") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { serverInfo: { name: "qodercn", version: "1.25.1" } }
          }));
        } else if (message.method === "session/new") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "session-live-1" }
          }));
        } else if (message.method === "session/prompt") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-live-1",
              _meta: { "ai-coding/request-id": "request-live-1" },
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "bridge live ok" }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-live-1",
              _meta: { "ai-coding/request-id": "request-live-1" },
              update: {
                sessionUpdate: "notification",
                type: "chat_finish",
                data: { reason: "completed", statusCode: 200 }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {}
          }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(socketPath, resolve);
  });

  const bridge = await startServer(createBridgeHandler({
    enableLiveIpc: true,
    qoderSocketPath: socketPath
  }));
  try {
    const response = await request(bridge.baseUrl, "/bridge/qoder/session/prompt", {
      request_id: "request-live-1",
      model: "qmodel_latest",
      prompt: "hello",
      stream: false
    });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.session_id, "session-live-1");
    assert.deepEqual(payload.events.map((event) => event.type), ["text_delta", "done"]);
    assert.equal(payload.events[0].data.text, "bridge live ok");
    const initialize = ipcMessages.find((message) => message.method === "initialize");
    assert.equal(initialize.params.rootPath, process.cwd());
    assert.equal(initialize.params.workspaceFolders[0].uri, `file://${process.cwd()}`);
    assert.equal(initialize.params.ideWindowType, "quest");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ipcMessages.at(-1).method, "session/cancel");
  } finally {
    await new Promise((resolve) => bridge.server.close(resolve));
    await new Promise((resolve) => ipcServer.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
});

test("live Qoder IPC bridge answers a controlled read_file tool request", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-bridge-workspace-"));
  const fixturePath = path.join(workspace, "fixture.txt");
  fs.writeFileSync(fixturePath, "controlled bridge fixture", "utf8");
  const socketPath = `/tmp/qoder-bridge-tool-${process.pid}-${Date.now()}.sock`;
  let toolResult;
  let promptId;
  let taskStatusSyncSeen = false;
  let inProgressSyncSeen = false;
  const ipcServer = net.createServer((socket) => {
    const parser = createContentLengthParser();
    socket.on("data", (chunk) => {
      for (const message of parser.push(chunk)) {
        if (message.method === "initialize") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { serverInfo: { name: "qodercn", version: "1.25.1" } }
          }));
        } else if (message.method === "session/new") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "session-tool-1" }
          }));
        } else if (message.method === "session/prompt") {
          promptId = message.id;
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: 88,
            method: "task/status/sync",
            params: {
              sessionId: "session-tool-1",
              taskId: "task-tool-1"
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: 89,
            method: "user/inprogress/task/sync",
            params: {
              sessionId: "session-tool-1",
              taskId: "task-tool-1"
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: 77,
            method: "tool/invoke",
            params: {
              sessionId: "session-tool-1",
              requestId: "request-tool-1",
              toolCallId: "tool-call-1",
              name: "read_file",
              parameters: { file_path: "fixture.txt" }
            }
          }));
        } else if (message.id === 88) {
          taskStatusSyncSeen = true;
          assert.deepEqual(message.result, {});
        } else if (message.id === 89) {
          inProgressSyncSeen = true;
          assert.deepEqual(message.result, {});
        } else if (message.id === 77 && message.result) {
          toolResult = message.result;
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-tool-1",
              _meta: { "ai-coding/request-id": "request-tool-1" },
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "controlled bridge fixture" }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-tool-1",
              _meta: { "ai-coding/request-id": "request-tool-1" },
              update: {
                sessionUpdate: "notification",
                type: "chat_finish",
                data: { reason: "completed", statusCode: 200 }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: promptId,
            result: {}
          }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(socketPath, resolve);
  });

  const bridge = await startServer(createBridgeHandler({
    enableLiveIpc: true,
    qoderSocketPath: socketPath,
    workspaceRoots: [workspace],
    toolMode: "controlled"
  }));
  try {
    const response = await request(bridge.baseUrl, "/bridge/qoder/session/prompt", {
      request_id: "request-tool-1",
      model: "qmodel_latest",
      cwd: workspace,
      prompt: "Read fixture.txt.",
      stream: false
    });
    assert.equal(response.statusCode, 200);
    assert.equal(toolResult.success, true);
    assert.equal(toolResult.name, "read_file");
    assert.equal(toolResult.result.path, "fixture.txt");
    assert.equal(toolResult.result.content, "controlled bridge fixture");
    assert.equal(taskStatusSyncSeen, true);
    assert.equal(inProgressSyncSeen, true);
  } finally {
    await new Promise((resolve) => bridge.server.close(resolve));
    await new Promise((resolve) => ipcServer.close(resolve));
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("persistent Qoder sessions support reuse and session/load attach", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-bridge-persistent-"));
  const socketPath = `/tmp/qoder-bridge-persistent-${process.pid}-${Date.now()}.sock`;
  const seen = [];
  let promptCount = 0;
  const ipcServer = net.createServer((socket) => {
    const parser = createContentLengthParser();
    socket.on("data", (chunk) => {
      for (const message of parser.push(chunk)) {
        seen.push(message);
        if (message.method === "initialize") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { serverInfo: { name: "qodercn", version: "1.25.1" } }
          }));
        } else if (message.method === "session/new") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "session-persistent-1" }
          }));
        } else if (message.method === "session/load") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: message.params.sessionId }
          }));
        } else if (message.method === "session/set_model") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {}
          }));
        } else if (message.method === "session/prompt") {
          promptCount += 1;
          const sessionId = message.params.sessionId;
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              _meta: message.params._meta,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `persistent-${promptCount}` }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              _meta: message.params._meta,
              update: {
                sessionUpdate: "notification",
                type: "chat_finish",
                data: { reason: "completed", statusCode: 200 }
              }
            }
          }));
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {}
          }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(socketPath, resolve);
  });

  const bridge = await startServer(createBridgeHandler({
    enableLiveIpc: true,
    qoderSocketPath: socketPath,
    workspaceRoots: [workspace]
  }));
  try {
    const opened = await request(bridge.baseUrl, "/bridge/qoder/session/open", {
      model: "qmodel_latest",
      cwd: workspace,
      request_id: "persistent-open"
    });
    assert.equal(opened.statusCode, 200);
    const openedPayload = JSON.parse(opened.body);
    assert.equal(openedPayload.session_id, "session-persistent-1");
    assert.equal(openedPayload.attached, false);
    assert.equal(openedPayload.workspace_path, workspace);
    assert.equal(openedPayload.ide_window_type, "quest");
    assert.match(openedPayload.request_id, /^[0-9a-f-]{36}$/);

    const first = await request(
      bridge.baseUrl,
      "/bridge/qoder/session/session-persistent-1/prompt",
      { prompt: "first", request_id: "persistent-1" }
    );
    const second = await request(
      bridge.baseUrl,
      "/bridge/qoder/session/session-persistent-1/prompt",
      { prompt: "second", request_id: "persistent-2" }
    );
    assert.deepEqual(JSON.parse(first.body).events.map((event) => event.data.text ?? event.type), [
      "persistent-1",
      "done"
    ]);
    assert.deepEqual(JSON.parse(second.body).events.map((event) => event.data.text ?? event.type), [
      "persistent-2",
      "done"
    ]);

    const listed = await request(bridge.baseUrl, "/bridge/qoder/sessions", undefined, "GET");
    assert.deepEqual(JSON.parse(listed.body).sessions.map((session) => session.session_id), [
      "session-persistent-1"
    ]);

    const closed = await request(
      bridge.baseUrl,
      "/bridge/qoder/session/session-persistent-1/close",
      {}
    );
    assert.equal(JSON.parse(closed.body).closed, true);

    const loaded = await request(bridge.baseUrl, "/bridge/qoder/session/open", {
      session_id: "existing-session",
      cwd: workspace,
      model: "qmodel_latest",
      request_id: "persistent-attach",
      load_request_limit: 3,
      load_till_request_id: "anchor-redacted"
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(JSON.parse(loaded.body).session_id, "existing-session");
    assert.equal(JSON.parse(loaded.body).attached, true);
    assert.equal(promptCount, 2);
    assert.equal(seen.filter((message) => message.method === "session/new").length, 1);
    assert.equal(seen.filter((message) => message.method === "session/load").length, 1);
    const loadMessage = seen.find((message) => message.method === "session/load");
    assert.equal(loadMessage.params.loadRequestLimit, 3);
    assert.equal(loadMessage.params.loadTillRequestId, "anchor-redacted");
    assert.equal(loadMessage.params._meta["ai-coding/workspace-path"], workspace);
    assert.equal(
      seen.filter((message) => message.method === "initialize")
        .every((message) => message.params.ideWindowType === "quest"),
      true
    );
    assert.deepEqual(
      seen.filter((message) => message.method === "session/set_model").map((message) => ({
        sessionId: message.params.sessionId,
        modelId: message.params.modelId
      })),
      [
        { sessionId: "session-persistent-1", modelId: "qmodel_latest" },
        { sessionId: "existing-session", modelId: "qmodel_latest" }
      ]
    );

    await request(
      bridge.baseUrl,
      "/bridge/qoder/session/existing-session/close",
      {}
    );
  } finally {
    await new Promise((resolve) => bridge.server.close(resolve));
    await new Promise((resolve) => ipcServer.close(resolve));
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bridge maps Responses events without claiming Qoder protocol compatibility", () => {
  assert.deepEqual(toBridgeEvent({
    type: "response.output_text.delta",
    delta: "hello"
  }), { type: "text_delta", data: { text: "hello" } });
  assert.deepEqual(toBridgeEvent({
    type: "response.completed",
    response: { status: "completed" }
  }), { type: "done", data: { status: "completed" } });
});

test("probe summaries contain shapes and flags, never payload values", () => {
  const summary = inspectProtocolPayload({
    request_id: "secret-value",
    type: "session.prompt",
    stream: true,
    tools: [{ name: "read_file" }],
    workspace: { path: "/private/path" }
  }, { direction: "in", source: "test" });
  const serialized = JSON.stringify(summary);
  assert.match(serialized, /session\.prompt/);
  assert.equal(summary.stream, true);
  assert.equal(summary.tools, true);
  assert.equal(summary.file_context, true);
  assert.doesNotMatch(serialized, /secret-value|private\/path|read_file/);
});

test("normalizes the observed ACP session prompt shape", () => {
  const request = normalizeAcpRequest({
    kind: "session/prompt",
    sessionId: "session-redacted",
    requestId: "request-redacted",
    data: {
      sessionId: "session-redacted",
      prompt: [{ type: "text", text: "hello" }]
    },
    _meta: {
      "ai-coding/workspace-path": "/workspace/redacted"
    }
  });
  assert.equal(request.method, "session/prompt");
  assert.equal(request.prompt, "hello");
  assert.equal(request.shape.has_session_id, true);
  assert.equal(request.shape.has_request_id, true);
  assert.equal(request.shape.has_workspace_metadata, true);
  assert.equal(classifyAcpEnvelope({
    method: "session/cancel",
    params: { sessionId: "x" }
  }).method, "session/cancel");
});

test("maps gateway events to ACP-shaped progress without claiming transport compatibility", () => {
  const progress = toAcpProgress({
    type: "text_delta",
    data: { text: "hello" }
  }, { sessionId: "session-redacted", requestId: "request-redacted" });
  assert.equal(progress.kind, "session/update");
  assert.equal(progress.data.update.sessionUpdate, "agent_message_chunk");
  assert.equal(progress.data.update.content.type, "text");
});

test("normalizes real Qoder session/update text and finish notifications", () => {
  assert.deepEqual(toBridgeEvent({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-redacted",
      _meta: { "ai-coding/request-id": "request-redacted" },
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" }
      }
    }
  }), {
    type: "text_delta",
    data: {
      text: "hello",
      session_id: "session-redacted",
      request_id: "request-redacted"
    }
  });

  assert.deepEqual(toBridgeEvent({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-redacted",
      _meta: { "ai-coding/request-id": "request-redacted" },
      update: {
        sessionUpdate: "notification",
        type: "chat_finish",
        data: { reason: "completed", statusCode: 200, fullAnswer: "secret answer" }
      }
    }
  }), {
    type: "done",
    data: {
      session_id: "session-redacted",
      request_id: "request-redacted",
      reason: "completed",
      status_code: 200
    }
  });
});

test("preserves ACP tool lifecycle updates and outputs", () => {
  const pending = toBridgeEvent({
    method: "session/update",
    params: {
      sessionId: "session-tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "read_file",
        status: "in_progress",
        rawInput: { path: "README.md" }
      }
    }
  });
  assert.equal(pending.type, "tool_call");
  assert.deepEqual(pending.data.arguments, { path: "README.md" });

  const completed = toBridgeEvent({
    method: "session/update",
    params: {
      sessionId: "session-tool",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: [{
          type: "content",
          content: { type: "text", text: "ok" }
        }]
      }
    }
  });
  assert.equal(completed.type, "tool_call_update");
  assert.equal(completed.data.status, "completed");
  assert.equal(completed.data.output[0].content.text, "ok");

  const acp = toAcpProgress(completed, {
    sessionId: "session-tool",
    requestId: "request-tool"
  });
  assert.equal(acp.data.update.sessionUpdate, "tool_call_update");
  assert.equal(acp.data.update.rawOutput[0].content.text, "ok");
});

test("encodes and parses fragmented JSON-RPC Content-Length frames", () => {
  const first = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const second = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
  const parser = createContentLengthParser();
  const input = Buffer.concat([first, second]);
  const messages = [
    ...parser.push(input.subarray(0, 7)),
    ...parser.push(input.subarray(7, 31)),
    ...parser.push(input.subarray(31))
  ];
  assert.deepEqual(messages, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "session/new", params: {} }
  ]);
  assert.equal(parser.bufferedBytes(), 0);
});

test("rejects oversized or invalid JSON-RPC frames without executing anything", () => {
  const parser = createContentLengthParser({ maxMessageBytes: 8 });
  assert.throws(() => parser.push(Buffer.from("Content-Length: 9\r\n\r\n123456789")), /too large/);
  assert.throws(() => createContentLengthParser().push(Buffer.from("Content-Length: 2\r\n\r\n{x")), /valid JSON/);
});

test("observed ACP client uses requests and notifications over a mock Unix socket", async () => {
  const socketPath = `/tmp/qoder-bridge-test-${process.pid}-${Date.now()}.sock`;
  const server = await new Promise((resolve, reject) => {
    const value = net.createServer();
    value.once("error", reject);
    value.listen(socketPath, () => resolve(value));
  });
  const parserBySocket = new WeakMap();
  const seen = [];
  let client;
  server.on("connection", (socket) => {
    const parser = createContentLengthParser();
    parserBySocket.set(socket, parser);
    socket.on("data", (chunk) => {
      for (const message of parser.push(chunk)) {
        seen.push(message);
        if (message.id !== undefined) {
          const result = message.method === "initialize"
            ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
            : { sessionId: "session-1" };
          socket.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id: message.id, result }));
        }
        if (message.method === "session/prompt") {
          socket.write(encodeJsonRpcMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: message.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: [{ type: "text", text: "hello" }]
              }
            }
          }));
        }
      }
    });
  });

  try {
    client = createObservedAcpClient({ socketPath });
    const notifications = [];
    client.onNotification((message) => notifications.push(message));
    assert.deepEqual(await client.initialize(), {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: []
    });
    assert.deepEqual(await client.sessionNew({ cwd: "/workspace" }), { sessionId: "session-1" });
    await client.sessionCancel({ sessionId: "session-1" });
    await client.sessionPrompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }]
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.map((message) => message.method), [
      "initialize",
      "session/new",
      "session/cancel",
      "session/prompt"
    ]);
    assert.equal(notifications[0].method, "session/update");
  } finally {
    client?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
});

test("observed ACP client responds to inbound JSON-RPC requests", async () => {
  const socketPath = `/tmp/qoder-bridge-request-${process.pid}-${Date.now()}.sock`;
  const server = await new Promise((resolve, reject) => {
    const value = net.createServer();
    value.once("error", reject);
    value.listen(socketPath, () => resolve(value));
  });
  let client;
  try {
    const responsePromise = new Promise((resolve, reject) => {
      server.once("connection", (socket) => {
        const parser = createContentLengthParser();
        socket.on("data", (chunk) => {
          for (const message of parser.push(chunk)) {
            if (message.method === "initialize") {
              socket.write(encodeJsonRpcMessage({
                jsonrpc: "2.0",
                id: message.id,
                result: { protocolVersion: 1 }
              }));
              socket.write(encodeJsonRpcMessage({
                jsonrpc: "2.0",
                id: 41,
                method: "tool/invoke",
                params: { name: "read_file", parameters: { file_path: "fixture.txt" } }
              }));
            } else if (message.id === 41) {
              resolve(message);
            }
          }
        });
        socket.on("error", reject);
      });
    });
    client = createObservedAcpClient({ socketPath });
    client.onRequest(async (message) => ({
      accepted: message.method === "tool/invoke",
      method: message.method
    }));
    await client.initialize();
    const response = await responsePromise;
    assert.deepEqual(response.result, { accepted: true, method: "tool/invoke" });
  } finally {
    client?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
});
