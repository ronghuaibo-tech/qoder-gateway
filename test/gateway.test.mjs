import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGateway, redactText, runQoderPatch } from "../server.mjs";
import { modelRecordsForQoder } from "../src/core/qoder-patch.mjs";
import { normalizeRequest } from "../src/core/request.mjs";
import { createToolPolicy } from "../src/tools/tool-policy.mjs";
import { executeToolCall } from "../src/tools/tool-runtime.mjs";

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function request(baseUrl, path, body, headers = {}, method) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers
      }
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

test("normalizes facade input into the shared internal request shape", () => {
  const normalized = normalizeRequest("openai-chat", {
    model: "alias",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,redacted" } }
      ]
    }],
    tools: [{ type: "function", function: { name: "lookup" } }],
    tool_choice: "auto",
    stream: true,
    reasoning_effort: "high",
    metadata: { trace: "test" }
  });

  assert.deepEqual(Object.keys(normalized).sort(), [
    "facade", "images", "messages", "metadata", "model", "modelAlias",
    "reasoning", "stream", "tool_choice", "tools"
  ]);
  assert.equal(normalized.model, "alias");
  assert.equal(normalized.tool_choice, "auto");
  assert.deepEqual(normalized.images, ["data:image/png;base64,redacted"]);
  assert.equal(normalized.reasoning, "high");
  assert.equal(normalized.metadata.trace, "test");
});

test("forwards an OpenAI-compatible request and replaces the model alias", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    req.on("data", (chunk) => {
      upstreamBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: upstreamBody.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
      }));
    });
  }, {}, "PUT");

  const gateway = await startServer(createGateway({
    providers: {
      provider: { protocol: "openai", base_url: `${upstream.baseUrl}/v1` }
    },
    routes: {
      "qoder-coding": { provider: "provider", model: "actual-coder-model" }
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "qoder-coding",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.model, "actual-coder-model");
  assert.equal(JSON.parse(response.body).choices[0].message.content, "ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("falls back to the next route after a retryable upstream error", async () => {
  let calls = 0;
  const upstream = await startServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("busy");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-fallback",
      choices: [{ message: { role: "assistant", content: "fallback-ok" } }]
    }));
  });

  const gateway = await startServer(createGateway({
    providers: {
      first: { protocol: "openai", base_url: `${upstream.baseUrl}/v1` },
      second: { protocol: "openai", base_url: `${upstream.baseUrl}/v1` }
    },
    routes: {
      "qoder-coding": [
        { provider: "first", model: "one" },
        { provider: "second", model: "two" }
      ]
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "qoder-coding",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(response.body).choices[0].message.content, "fallback-ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("exposes configured aliases through the models endpoint", async () => {
  const gateway = await startServer(createGateway({
    providers: {
      provider: { protocol: "openai", base_url: "https://example.com/v1" }
    },
    routes: {
      "qoder-coding": { provider: "provider", model: "actual-model" }
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/models");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).data.map((item) => item.id), ["qoder-coding"]);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("derives safe protocol capabilities and keeps fallbacks visible before catalog sync", async () => {
  const gateway = await startServer(createGateway({
    providers: {
      provider: { protocol: "openai-response", base_url: "https://example.com/v1" },
      fallback: { protocol: "openai", base_url: "https://example.com/v1" }
    },
    routes: {
      "gateway-model": {
        provider: "provider",
        model: "real-response-model",
        protocol: "openai-response",
        fallback: {
          provider: "fallback",
          model: "real-chat-model"
        }
      }
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/models");
  assert.equal(response.statusCode, 200);
  const model = JSON.parse(response.body).data[0];
  assert.equal(model.capabilities.responses, true);
  assert.equal(model.capabilities.chat, false);
  assert.deepEqual(model.supported_endpoint_types, ["openai-response"]);
  assert.deepEqual(model.fallback_models, [{
    provider: "fallback",
    id: "real-chat-model",
    supported_endpoint_types: ["openai"],
    capabilities: {
      chat: true,
      responses: false,
      anthropic: false,
      stream: false,
      tools: false,
      vision: false,
      reasoning: false
    }
  }]);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("serves the control page and persists a redacted configuration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-gateway-"));
  const configPath = path.join(directory, "config.json");
  const config = {
    listen: "127.0.0.1:8787",
    gateway_api_key_env: "",
    qoder_patch: {
      enabled: true,
      gateway_url: "http://127.0.0.1:8787"
    },
    providers: {
      provider: {
        protocol: "openai",
        base_url: "https://example.com/v1",
        api_key_env: "YMENG_API_KEY"
      }
    },
    routes: {
      "qoder-coding": { provider: "provider", model: "actual-model" }
    }
  };
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  let patchCalls = 0;
  const gateway = await startServer(createGateway(config, {
    configPath,
    qoderPatchRunner: async () => {
      patchCalls += 1;
      return { ok: true, status: "applied", models: ["new-model"] };
    }
  }));

  const page = await request(gateway.baseUrl, "/");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Qoder Gateway/);

  const before = await request(gateway.baseUrl, "/admin/config");
  assert.equal(before.statusCode, 200);
  assert.equal(JSON.parse(before.body).providers.provider.api_key_configured, false);
  assert.doesNotMatch(before.body, /"api_key"\s*:/);

  const secret = await request(gateway.baseUrl, "/admin/provider-secret", {
    provider: "provider",
    api_key: "runtime-secret-test-value"
  }, {}, "PUT");
  assert.equal(secret.statusCode, 200);
  assert.equal(JSON.parse(secret.body).providers.provider.api_key_configured, true);
  assert.doesNotMatch(secret.body, /runtime-secret-test-value/);

  const saved = await request(gateway.baseUrl, "/admin/config", {
    listen: "127.0.0.1:8787",
    gateway_api_key_env: "",
    providers: {
      provider: {
        protocol: "openai",
        base_url: "https://api.ymeng.cc/v1",
        api_key_env: "YMENG_API_KEY",
        timeout_ms: 60000
      }
    },
    routes: {
      "qoder-coding": { provider: "provider", model: "new-model" }
    }
  }, {}, "PUT");

  assert.equal(saved.statusCode, 200);
  assert.equal(JSON.parse(saved.body).routes["qoder-coding"].model, "new-model");
  assert.equal(JSON.parse(saved.body).qoder_patch.enabled, true);
  assert.deepEqual(JSON.parse(saved.body).qoder_patch_sync, {
    ok: true,
    status: "applied",
    models: ["new-model"]
  });
  assert.equal(patchCalls, 2);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).providers.provider.base_url, "https://api.ymeng.cc/v1");
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).qoder_patch.enabled, true);

  await new Promise((resolve) => gateway.server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
});

test("uses a per-route protocol with one shared relay provider", async () => {
  let requestPath;
  let requestBody;
  const upstream = await startServer((req, res) => {
    requestPath = req.url;
    req.on("data", (chunk) => {
      requestBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg-shared-relay",
        type: "message",
        role: "assistant",
        model: requestBody.model,
        content: [{ type: "text", text: "shared relay ok" }]
      }));
    });
  });

  const gateway = await startServer(createGateway({
    providers: {
      relay: { protocol: "openai", base_url: upstream.baseUrl }
    },
    routes: {
      "cc-sonnet": { provider: "relay", model: "claude-sonnet", protocol: "anthropic" }
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "cc-sonnet",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requestPath, "/messages");
  assert.equal(requestBody.model, "claude-sonnet");
  assert.equal(JSON.parse(response.body).choices[0].message.content, "shared relay ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("syncs the relay model catalog", async () => {
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "grok-4.6", supported_endpoint_types: ["openai", "openai-response", "anthropic"] },
        { id: "qwen3-coder", supported_endpoint_types: ["openai"] }
      ]
    }));
  });

  const gateway = await startServer(createGateway({
    providers: {
      relay: { protocol: "openai", base_url: upstream.baseUrl }
    },
    routes: {}
  }));

  const response = await request(gateway.baseUrl, "/admin/upstream-models?provider=relay");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).data.map((item) => item.id), ["grok-4.6", "qwen3-coder"]);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("forwards an OpenAI Responses request and converts the response", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/responses");
    req.on("data", (chunk) => {
      upstreamBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp-test",
        object: "response",
        model: upstreamBody.model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "responses ok" }] }],
        output_text: "responses ok"
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { "responses-alias": { provider: "provider", model: "real-responses-model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "responses-alias",
    input: "hello",
    stream: false
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.model, "real-responses-model");
  assert.equal(upstreamBody.input, "hello");
  assert.equal(JSON.parse(response.body).output_text, "responses ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("keeps internal metadata out of strict OpenAI Responses upstreams", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    req.on("data", (chunk) => {
      upstreamBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "strict-responses",
        object: "response",
        model: upstreamBody.model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        output_text: "ok"
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { "qoder-alias": { provider: "provider", model: "strict-model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "qoder-alias",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: false,
    metadata: {
      qoder_session_id: "session-redacted",
      qoder_request_id: "request-redacted"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.model, "strict-model");
  assert.equal("metadata" in upstreamBody, false);
  assert.equal(JSON.parse(response.body).output_text, "ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("converts OpenAI Responses input into Anthropic messages", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/messages");
    req.on("data", (chunk) => {
      upstreamBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg-responses-anthropic",
        type: "message",
        role: "assistant",
        model: upstreamBody.model,
        content: [{ type: "text", text: "anthropic ok" }],
        stop_reason: "end_turn"
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "anthropic", base_url: upstream.baseUrl } },
    routes: { "anthropic-responses-alias": { provider: "provider", model: "grok-4.6" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "anthropic-responses-alias",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }],
    stream: false
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.model, "grok-4.6");
  assert.deepEqual(upstreamBody.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello" }]
  }]);
  assert.equal(JSON.parse(response.body).output_text, "anthropic ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("converts an Anthropic facade request to an OpenAI provider", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/chat/completions");
    req.on("data", (chunk) => {
      upstreamBody = JSON.parse(chunk.toString());
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chat-anthropic-test",
        model: upstreamBody.model,
        choices: [{ message: { role: "assistant", content: "anthropic facade ok" }, finish_reason: "stop" }]
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai", base_url: upstream.baseUrl } },
    routes: { "anthropic-alias": { provider: "provider", model: "actual-model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/messages", {
    model: "anthropic-alias",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.messages[0].content, "hello");
  assert.equal(JSON.parse(response.body).content[0].text, "anthropic facade ok");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("converts Responses SSE text deltas to an OpenAI Chat SSE stream", async () => {
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/responses");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: response.output_text.delta\n");
    res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    res.write("event: response.output_text.delta\n");
    res.write('data: {"type":"response.output_text.delta","delta":" stream"}\n\n');
    res.write("event: response.completed\n");
    res.write('data: {"type":"response.completed"}\n\n');
    res.end();
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { "stream-alias": { provider: "provider", model: "stream-model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "stream-alias",
    messages: [{ role: "user", content: "hello" }],
    stream: true
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.match(response.body, /"content":"hello"/);
  assert.match(response.body, /"content":" stream"/);
  assert.match(response.body, /\[DONE\]/);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("turns an upstream stream disconnect into an SSE failure instead of fake completion", async () => {
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/responses");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created","response":{"id":"partial"}}\n\n');
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    setTimeout(() => res.destroy(), 10);
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { "partial-alias": { provider: "provider", model: "partial-model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "partial-alias",
    input: "hello",
    stream: true
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /response\.failed/);
  assert.doesNotMatch(response.body, /response\.completed/);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("preserves native tool calls and safely parses an allowlisted simulated call", async () => {
  let calls = 0;
  const upstream = await startServer((req, res) => {
    calls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (calls === 1) {
        res.end(JSON.stringify({
          id: "native-tool",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_native",
                type: "function",
                function: { name: "lookup", arguments: "{\"key\":\"value\"}" }
              }]
            },
            finish_reason: "tool_calls"
          }]
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "simulated-tool",
        choices: [{
          message: {
            role: "assistant",
            content: '```json\n{"name":"lookup","arguments":{"key":"value"}}\n```'
          },
          finish_reason: "stop"
        }]
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai", base_url: upstream.baseUrl } },
    routes: { "tool-alias": { provider: "provider", model: "tool-model" } }
  }));
  const body = {
    model: "tool-alias",
    messages: [{ role: "user", content: "use lookup" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]
  };

  const native = await request(gateway.baseUrl, "/v1/chat/completions", body);
  const simulated = await request(gateway.baseUrl, "/v1/chat/completions", body);
  assert.equal(JSON.parse(native.body).choices[0].message.tool_calls[0].id, "call_native");
  assert.equal(JSON.parse(simulated.body).choices[0].message.tool_calls[0].function.name, "lookup");
  assert.equal(calls, 2);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("records model capabilities from the upstream catalog", async () => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{
        id: "real-model-from-catalog",
        supported_endpoint_types: ["openai", "openai-response", "anthropic", "stream", "tools", "vision", "reasoning"]
      }]
    }));
  });
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "relay", model: "real-model-from-catalog" } }
  }));

  const sync = await request(gateway.baseUrl, "/admin/upstream-models?provider=relay");
  assert.equal(sync.statusCode, 200);
  const models = await request(gateway.baseUrl, "/v1/models");
  const model = JSON.parse(models.body).data[0];
  assert.equal(model.capabilities.responses, true);
  assert.equal(model.capabilities.tools, true);
  assert.deepEqual(model.supported_endpoint_types, [
    "openai", "openai-response", "anthropic", "stream", "tools", "vision", "reasoning"
  ]);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("does not expose API keys in redacted output or errors", async () => {
  const gateway = await startServer(createGateway({
    providers: {
      provider: {
        protocol: "openai",
        base_url: "https://example.com/v1",
        api_key_env: "YMENG_API_KEY"
      }
    },
    routes: { alias: { provider: "provider", model: "model" } }
  }));

  const secretResponse = await request(gateway.baseUrl, "/admin/provider-secret", {
    provider: "provider",
    api_key: "live-test-secret-value"
  }, {}, "PUT");
  assert.equal(secretResponse.statusCode, 200);
  assert.doesNotMatch(secretResponse.body, /live-test-secret-value/);
  assert.match(redactText("upstream: Bearer live-test-secret-value"), /\[REDACTED\]/);
  assert.doesNotMatch(redactText("x-api-key: live-test-secret-value"), /live-test-secret-value/);
  assert.doesNotMatch(redactText("https://example.test/?api_key=live-test-secret-value"), /live-test-secret-value/);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("does not fall back after an authentication failure", async () => {
  let calls = 0;
  const upstream = await startServer((req, res) => {
    calls += 1;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid key" } }));
  });
  const gateway = await startServer(createGateway({
    providers: {
      first: { protocol: "openai", base_url: upstream.baseUrl },
      second: { protocol: "openai", base_url: upstream.baseUrl }
    },
    routes: {
      alias: [
        { provider: "first", model: "one" },
        { provider: "second", model: "two" }
      ]
    }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.statusCode, 401);
  assert.equal(calls, 1);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("fails clearly when a configured provider key is missing", async () => {
  const previous = process.env.QODER_MISSING_PROVIDER_KEY;
  delete process.env.QODER_MISSING_PROVIDER_KEY;
  const gateway = await startServer(createGateway({
    providers: {
      provider: {
        protocol: "anthropic",
        base_url: "https://example.com/v1",
        api_key_env: "QODER_MISSING_PROVIDER_KEY"
      }
    },
    routes: { alias: { provider: "provider", model: "model" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "alias",
    input: "hello"
  });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error.type, "provider_key_missing");
  await new Promise((resolve) => gateway.server.close(resolve));
  if (previous === undefined) delete process.env.QODER_MISSING_PROVIDER_KEY;
  else process.env.QODER_MISSING_PROVIDER_KEY = previous;
});

test("supports a fallback object and records its discovered capabilities", async () => {
  const upstream = await startServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "primary-real", supported_endpoint_types: ["openai", "stream"] },
          { id: "fallback-real", supported_endpoint_types: ["openai-response", "reasoning"] }
        ]
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "ok", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  const gateway = await startServer(createGateway({
    providers: {
      relay: { protocol: "openai", base_url: upstream.baseUrl }
    },
    routes: {
      alias: {
        provider: "relay",
        model: "primary-real",
        fallback: { provider: "relay", model: "fallback-real" }
      }
    }
  }));

  assert.equal((await request(gateway.baseUrl, "/admin/upstream-models?provider=relay")).statusCode, 200);
  const response = await request(gateway.baseUrl, "/v1/models");
  const model = JSON.parse(response.body).data[0];
  assert.equal(model.capabilities.chat, true);
  assert.equal(model.capabilities.responses, false);
  assert.equal(model.capabilities.reasoning, false);
  assert.deepEqual(model.supported_endpoint_types, ["openai", "stream"]);
  assert.equal(model.fallback_models[0].id, "fallback-real");
  assert.equal(model.fallback_models[0].capabilities.responses, true);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("falls back after a provider timeout", async () => {
  let upstreamCalls = 0;
  const upstream = await startServer((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "timeout-fallback", choices: [{ message: { role: "assistant", content: "recovered" } }] }));
  });
  let firstAttempt = true;
  const fetchImpl = async (url, options) => {
    if (firstAttempt && String(url).endsWith("/chat/completions")) {
      firstAttempt = false;
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return fetch(url, options);
  };
  const gateway = await startServer(createGateway({
    providers: {
      first: { protocol: "openai", base_url: upstream.baseUrl },
      second: { protocol: "openai", base_url: upstream.baseUrl }
    },
    routes: {
      alias: [
        { provider: "first", model: "one" },
        { provider: "second", model: "two" }
      ]
    }
  }, { fetchImpl }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).choices[0].message.content, "recovered");
  assert.equal(upstreamCalls, 1);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("converts Gemini non-stream and stream responses", async () => {
  let requests = 0;
  const upstream = await startServer((req, res) => {
    requests += 1;
    assert.match(req.url, /\/models\/gemini-real:generateContent/);
    req.resume();
    req.on("end", () => {
      if (requests === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          responseId: "gemini-response",
          modelVersion: "gemini-real",
          candidates: [{ content: { parts: [{ text: "gemini ok" }] }, finishReason: "STOP" }]
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'data: {"candidates":[{"content":{"parts":[{"text":"gemini"}]}}]}',
        ""
      ].join("\n"));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { gemini: { protocol: "gemini", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "gemini", model: "gemini-real" } }
  }));

  const normal = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(normal.statusCode, 200);
  assert.equal(JSON.parse(normal.body).choices[0].message.content, "gemini ok");

  const streamed = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }],
    stream: true
  });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.body, /"content":"gemini"/);
  assert.match(streamed.body, /\[DONE\]/);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("converts Anthropic SSE events to Responses SSE events", async () => {
  const upstream = await startServer((req, res) => {
    assert.equal(req.url, "/messages");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg-1"}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
        "",
        'event: message_stop',
        'data: {"type":"message_stop"}',
        ""
      ].join("\n"));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { anthropic: { protocol: "anthropic", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "anthropic", model: "claude-real" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "alias",
    input: "hello",
    stream: true
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /response\.output_text\.delta/);
  assert.match(response.body, /"delta":"hello"/);
  assert.match(response.body, /response\.completed/);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("preserves tool results across multi-turn Anthropic conversion", async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      upstreamBody = JSON.parse(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "tool-result",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "done" }]
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { anthropic: { protocol: "anthropic", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "anthropic", model: "claude-real" } }
  }));

  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }]
      },
      { role: "tool", tool_call_id: "call-1", content: "{\"ok\":true}" }
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(upstreamBody.messages[0].content[0].type, "tool_use");
  assert.equal(upstreamBody.messages[1].content[0].type, "tool_result");
  assert.equal(JSON.parse(response.body).choices[0].message.content, "done");
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("rejects unreliable response_format conversion to Anthropic", async () => {
  let calls = 0;
  const gateway = await startServer(createGateway({
    providers: { anthropic: { protocol: "anthropic", base_url: "http://127.0.0.1:1" } },
    routes: { alias: { provider: "anthropic", model: "claude-real" } }
  }, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not be called");
    }
  }));
  const response = await request(gateway.baseUrl, "/v1/messages", {
    model: "alias",
    max_tokens: 100,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(response.statusCode, 501);
  assert.match(response.body, /unsupported_conversion/);
  assert.equal(calls, 0);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("blocks tool paths outside the configured workspace", async () => {
  const policy = createToolPolicy({ workspaceRoots: ["/tmp/qoder-safe-root"], executionMode: "execute" });
  const result = await executeToolCall(policy, {
    id: "call-outside",
    type: "function",
    function: { name: "read_file", arguments: "{\"path\":\"/etc/passwd\"}" }
  }, { requestId: "request-tool" });
  assert.equal(result.ok, false);
  assert.match(result.content, /outside the allowed workspace/);
});

test("keeps recent request diagnostics redacted", async () => {
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai", base_url: "http://127.0.0.1:1" } },
    routes: { alias: { provider: "provider", model: "model" } }
  }, {
    fetchImpl: async () => {
      const error = new Error("upstream returned Bearer live-test-secret-value");
      error.statusCode = 401;
      return Promise.reject(error);
    }
  }));
  const response = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(response.statusCode, 502);
  const recent = await request(gateway.baseUrl, "/admin/recent-requests");
  assert.doesNotMatch(recent.body, /live-test-secret-value/);
  assert.match(recent.body, /all configured upstream routes failed/);
  const recentPayload = JSON.parse(recent.body);
  assert.equal(recentPayload.data[0].failures[0].provider, "provider");
  assert.doesNotMatch(recentPayload.data[0].failures[0].message, /live-test-secret-value/);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("fails closed when gateway API key configuration is missing", async () => {
  const previous = process.env.QODER_GATEWAY_TEST_KEY;
  delete process.env.QODER_GATEWAY_TEST_KEY;
  const gateway = await startServer(createGateway({
    gateway_api_key_env: "QODER_GATEWAY_TEST_KEY",
    providers: { provider: { protocol: "openai", base_url: "https://example.com/v1" } },
    routes: {}
  }));
  const response = await request(gateway.baseUrl, "/v1/models");
  assert.equal(response.statusCode, 401);
  if (previous === undefined) delete process.env.QODER_GATEWAY_TEST_KEY;
  else process.env.QODER_GATEWAY_TEST_KEY = previous;
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("exposes a protected in-gateway Qoder patch trigger", async () => {
  let calls = 0;
  const gateway = await startServer(createGateway({
    providers: { provider: { protocol: "openai", base_url: "https://example.com/v1" } },
    routes: { alias: { provider: "provider", model: "model" } }
  }, {
    qoderPatchRunner: async () => {
      calls += 1;
      return { ok: true, status: "applied", models: ["alias"] };
    }
  }));
  const response = await request(gateway.baseUrl, "/admin/qoder-patch", {}, {}, "POST");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    status: "applied",
    models: ["alias"]
  });
  assert.equal(calls, 1);
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("does not patch Qoder when the gateway config disables it", async () => {
  const result = await runQoderPatch({
    qoder_patch: { enabled: false },
    listen: "127.0.0.1:8787"
  });
  assert.deepEqual(result, {
    ok: true,
    status: "disabled",
    message: "Qoder patch is disabled by config"
  });
});

test("builds managed Qoder models without storing a gateway API key", () => {
  const records = modelRecordsForQoder([
    {
      id: "Qwen3.8max",
      capabilities: { vision: true, reasoning: true }
    },
    {
      id: "GLM5.2",
      capabilities: { vision: false, reasoning: false }
    }
  ], "http://127.0.0.1:8787/");

  assert.deepEqual(records.map((record) => ({
    id: record.id,
    provider: record.provider,
    model: record.model,
    baseUrl: record.baseUrl,
    hasApiKey: record.hasApiKey,
    enabled: record.enabled,
    is_vl: record.is_vl,
    is_reasoning: record.is_reasoning
  })), [
    {
      id: "qoder-bridge-Qwen3.8max",
      provider: "qoder-local-gateway",
      model: "Qwen3.8max",
      baseUrl: "http://127.0.0.1:8787/v1",
      hasApiKey: true,
      enabled: true,
      is_vl: true,
      is_reasoning: true
    },
    {
      id: "qoder-bridge-GLM5.2",
      provider: "qoder-local-gateway",
      model: "GLM5.2",
      baseUrl: "http://127.0.0.1:8787/v1",
      hasApiKey: true,
      enabled: true,
      is_vl: false,
      is_reasoning: false
    }
  ]);
  assert.equal(Object.hasOwn(records[0], "api_key"), false);
  assert.equal(Object.hasOwn(records[0], "apiKey"), false);
});

test("rejects embedded provider credentials and sensitive custom headers", () => {
  assert.throws(() => createGateway({
    providers: {
      provider: {
        protocol: "openai",
        base_url: "https://user:password@example.com/v1"
      }
    },
    routes: {}
  }), /embedded credentials/);
  assert.throws(() => createGateway({
    providers: {
      provider: {
        protocol: "openai",
        base_url: "https://example.com/v1",
        headers: { "x-provider-auth": "secret" }
      }
    },
    routes: {}
  }), /credential header/);
});

test("filters stream and tool requests using discovered capabilities", async () => {
  let calls = 0;
  const upstream = await startServer((req, res) => {
    calls += 1;
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          id: "catalog-model",
          supported_endpoint_types: ["openai"]
        }]
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "unexpected" } }] }));
  });
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "relay", model: "catalog-model" } }
  }));
  assert.equal((await request(gateway.baseUrl, "/admin/upstream-models?provider=relay")).statusCode, 200);

  const streamed = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }],
    stream: true
  });
  assert.equal(streamed.statusCode, 400);
  const tooled = await request(gateway.baseUrl, "/v1/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup" } }]
  });
  assert.equal(tooled.statusCode, 400);
  assert.equal(calls, 1);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("tries Bridge streaming for an unlisted model and falls back to non-stream", async () => {
  let calls = 0;
  const upstream = await startServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{ id: "catalog-response-model", supported_endpoint_types: ["openai-response"] }]
      }));
      return;
    }
    calls += 1;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      if (payload.stream === true) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stream is not supported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "response-fallback",
        object: "response",
        model: payload.model,
        status: "completed",
        output_text: "fallback response"
      }));
    });
  });
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "relay", model: "catalog-response-model" } }
  }));
  assert.equal((await request(gateway.baseUrl, "/admin/upstream-models?provider=relay")).statusCode, 200);

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "alias",
    input: "hello",
    stream: true,
    metadata: { qoder_bridge_stream_fallback: true }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).output_text, "fallback response");
  assert.equal(calls, 2);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("forwards Bridge SSE when the upstream returns event-stream", async () => {
  let requestBody;
  const upstream = await startServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{ id: "catalog-stream-model", supported_endpoint_types: ["openai-response"] }]
      }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.created","response":{"id":"stream-1"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"streamed"}\n\n');
      res.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai-response", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "relay", model: "catalog-stream-model" } }
  }));
  assert.equal((await request(gateway.baseUrl, "/admin/upstream-models?provider=relay")).statusCode, 200);

  const response = await request(gateway.baseUrl, "/v1/responses", {
    model: "alias",
    input: "hello",
    stream: true,
    metadata: { qoder_bridge_stream_fallback: true }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.match(response.body, /response\.created/);
  assert.match(response.body, /response.output_text.delta/);
  assert.match(response.body, /"delta":"streamed"/);
  assert.match(response.body, /"output":\[\{"type":"message","role":"assistant","content":\[\{"type":"output_text","text":"streamed"\}\]\}\]/);
  assert.equal(requestBody.stream, true);
  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("Qoder V9 bridge guards duplicate deltas and incomplete streams", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V9/);
  assert.match(source, /deltaSeen:!1/);
  assert.match(source, /!state\.deltaSeen/);
  assert.match(source, /SSE ended before response\.completed/);
  assert.match(source, /response\.output_item\.added.*function_call/);
});

test("Qoder V10 bridge wires session cancellation to the local fetch", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V10/);
  assert.match(source, /_cancelLocalGatewayPrompt/);
  assert.match(source, /signal:controller\.signal/);
  assert.match(source, /session cancelled/);
});

test("Qoder V11 keeps ACP text chunks as objects for rendering and history", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V11/);
  assert.match(
    source,
    /sessionUpdate:"agent_message_chunk",content:\{type:"text",text\}/
  );
  assert.doesNotMatch(
    source,
    /source\.replace\(\s*'content:\{type:"text",text:r\}'/
  );
});

test("Qoder V12 forwards safe tools and closes the ACP tool lifecycle", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V12/);
  assert.match(source, /_localGatewayTools/);
  assert.match(source, /_executeLocalGatewayTool/);
  assert.match(source, /function_call_output/);
  assert.match(source, /sessionUpdate:initial\?"tool_call":"tool_call_update"/);
  assert.match(source, /rawOutput/);
  assert.match(source, /agent_thought_chunk/);
});

test("local tool endpoint executes only the read-only allowlist", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-local-tool-"));
  await fs.writeFile(path.join(workspace, "fixture.txt"), "local tool ok", "utf8");
  const gateway = await startServer(createGateway({
    providers: {},
    routes: {}
  }));
  try {
    const read = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "local-tool-test",
      workspace_path: workspace,
      tool_call: {
        id: "call-read",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "fixture.txt" })
        }
      }
    });
    assert.equal(read.statusCode, 200);
    const readPayload = JSON.parse(read.body);
    assert.equal(readPayload.ok, true);
    assert.match(readPayload.content, /local tool ok/);

    const shell = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "local-tool-shell",
      workspace_path: workspace,
      tool_call: {
        id: "call-shell",
        function: {
          name: "terminal",
          arguments: JSON.stringify({ command: "touch should-not-exist" })
        }
      }
    });
    assert.equal(shell.statusCode, 200);
    const shellPayload = JSON.parse(shell.body);
    assert.equal(shellPayload.ok, false);
    assert.equal(fsSync.existsSync(path.join(workspace, "should-not-exist")), false);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("blocks workspace symlink escape in controlled tool mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-tool-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-tool-outside-"));
  const outsideFile = path.join(outside, "secret.txt");
  const link = path.join(root, "link.txt");
  await fs.writeFile(outsideFile, "should not be readable", "utf8");
  await fs.symlink(outsideFile, link);
  const policy = createToolPolicy({ workspaceRoots: [root], executionMode: "execute" });
  const result = await executeToolCall(policy, {
    id: "call-symlink",
    type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path: link }) }
  });
  assert.equal(result.ok, false);
  assert.match(result.content, /resolves outside/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
