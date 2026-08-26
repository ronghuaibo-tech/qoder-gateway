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

test("keeps Qoder runtime context settings in gateway parameters", () => {
  const normalized = normalizeRequest("openai-responses", {
    model: "runtime-model",
    input: "hello",
    context_length: 400000,
    reasoning: { effort: "xhigh" }
  });

  assert.equal(normalized.metadata.parameters.context_length, 400000);
  assert.deepEqual(normalized.reasoning, { effort: "xhigh" });
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
    workspace_roots: ["/tmp/qoder-workspace"],
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
  assert.deepEqual(JSON.parse(saved.body).workspace_roots, ["/tmp/qoder-workspace"]);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")).workspace_roots, ["/tmp/qoder-workspace"]);

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

test("fills sparse relay metadata from the verified upstream capability table", async () => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-5.5", supported_endpoint_types: ["openai-response"] }]
    }));
  });
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai", base_url: upstream.baseUrl } },
    routes: { alias: { provider: "relay", model: "gpt-5.5" } }
  }));

  assert.equal(
    (await request(gateway.baseUrl, "/admin/upstream-models?provider=relay")).statusCode,
    200
  );
  const model = JSON.parse((await request(gateway.baseUrl, "/v1/models")).body).data[0];
  assert.deepEqual(model.context_lengths, [1050000]);
  assert.equal(model.max_input_tokens, 1050000);
  assert.deepEqual(model.reasoning_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.vision, true);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.deepEqual(model.output_modalities, ["text"]);
  assert.equal(model.reasoning_disabled, undefined);

  await new Promise((resolve) => upstream.server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

test("keeps verified model runtime and multimodal controls model-specific", async () => {
  const gateway = await startServer(createGateway({
    providers: { relay: { protocol: "openai-response", base_url: "https://example.com/v1" } },
    routes: {
      openai: { provider: "relay", model: "gpt-5.5" },
      sol: { provider: "relay", model: "gpt-5.6-sol" },
      grok: { provider: "relay", model: "grok-4.6" },
      unknown: { provider: "relay", model: "unlisted-model" }
    }
  }));

  const models = Object.fromEntries(
    JSON.parse((await request(gateway.baseUrl, "/v1/models")).body).data
      .map((item) => [item.id, item])
  );
  assert.deepEqual(models.openai.context_lengths, [1050000]);
  assert.deepEqual(models.openai.reasoning_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(models.openai.capabilities.vision, true);
  assert.deepEqual(models.openai.input_modalities, ["text", "image"]);
  assert.deepEqual(models.sol.reasoning_efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(models.sol.reasoning_required, true);
  assert.deepEqual(models.grok.context_lengths, [500000]);
  assert.deepEqual(models.grok.reasoning_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(models.grok.reasoning_required, true);
  assert.equal(Object.hasOwn(models.unknown, "context_lengths"), false);
  assert.equal(Object.hasOwn(models.unknown, "reasoning_efforts"), false);
  assert.equal(models.unknown.capabilities.vision, false);

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

test("restores provider secrets from keychain storage after restart", async () => {
  const secrets = new Map([["provider", "persisted-secret-value"]]);
  const keychain = {
    async read(provider) {
      return secrets.get(provider);
    },
    async write(provider, secret) {
      secrets.set(provider, secret);
    },
    async delete(provider) {
      secrets.delete(provider);
    }
  };

  let upstreamAuth;
  const upstream = await startServer((req, res) => {
    upstreamAuth = req.headers.authorization || req.headers["x-api-key"] || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-keychain",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });

  const config = {
    providers: {
      provider: {
        protocol: "openai",
        base_url: `${upstream.baseUrl}/v1`,
        api_key_env: "QODER_KEYCHAIN_TEST"
      }
    },
    routes: { alias: { provider: "provider", model: "model" } }
  };

  const firstGateway = await startServer(createGateway(config, { keychain }));
  try {
    const response = await request(firstGateway.baseUrl, "/v1/chat/completions", {
      model: "alias",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(response.statusCode, 200);
    assert.equal(upstreamAuth, "Bearer persisted-secret-value");
  } finally {
    await new Promise((resolve) => firstGateway.server.close(resolve));
  }

  const updateGateway = await startServer(createGateway(config, { keychain }));
  try {
    const saved = await request(updateGateway.baseUrl, "/admin/provider-secret", {
      provider: "provider",
      api_key: "persisted-secret-value-2",
      persist_keychain: true
    }, {}, "PUT");
    assert.equal(saved.statusCode, 200);
    assert.equal(secrets.get("provider"), "persisted-secret-value-2");
  } finally {
    await new Promise((resolve) => updateGateway.server.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
  }
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
  const health = await request(gateway.baseUrl, "/health");
  assert.equal(health.statusCode, 200);
  const recent = await request(gateway.baseUrl, "/admin/recent-requests");
  assert.equal(recent.statusCode, 401);
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
      capabilities: { vision: true, reasoning: true },
      context_lengths: [200000, 400000],
      reasoning_efforts: ["low", "medium"]
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
  assert.deepEqual(
    Object.fromEntries(Object.entries(records[0].contextConfig).map(([key, value]) => [
      key,
      { label: value.label, tokenCount: value.tokenCount, isDefault: value.isDefault === true }
    ])),
    {
      "200000": { label: "200K", tokenCount: 200000, isDefault: true },
      "400000": { label: "400K", tokenCount: 400000, isDefault: false }
    }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(records[0].thinkingConfig.enabled.efforts).map(([key, value]) => [
      key,
      { label: value.label, isDefault: value.isDefault === true }
    ])),
    {
      low: { label: "Low", isDefault: false },
      medium: { label: "Medium", isDefault: true }
    }
  );
  assert.equal(Object.hasOwn(records[0].thinkingConfig.enabled.efforts, "xhigh"), false);
  assert.equal(Object.hasOwn(records[1], "contextConfig"), false);
  assert.equal(Object.hasOwn(records[1], "thinkingConfig"), false);
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
  assert.match(source, /PATCH_MARKER_V19/);
  assert.match(source, /_localGatewayTools/);
  assert.match(source, /_executeLocalGatewayTool/);
  assert.match(source, /function_call_output/);
  assert.match(source, /sessionUpdate:initial\?"tool_call":"tool_call_update"/);
  assert.match(source, /rawOutput/);
  assert.match(source, /agent_thought_chunk/);
  assert.match(source, /list_qoder_plugins/);
  assert.match(source, /read_qoder_plugin_file/);
  assert.match(source, /search_qoder_plugins/);
});

test("Qoder V13/V18 bounds local tool loops for third-party models", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V13/);
  assert.match(source, /PATCH_MARKER_V18/);
  assert.match(source, /MAX_TOOL_ROUNDS=8/);
  assert.match(source, /MAX_TOOL_CALLS=24/);
  assert.match(source, /MAX_DUPLICATE_TOOL_CALLS=2/);
  assert.match(source, /_localGatewayToolSignature/);
  assert.match(source, /_compactLocalGatewayToolOutput/);
  assert.match(source, /Stopped a repeated local tool call/);
  assert.match(source, /truncated by Qoder Bridge/);
});

test("Qoder V14 persists local gateway turns through ACP history", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V14/);
  assert.match(source, /__qoderBridgeHistory/);
  assert.match(source, /_appendLocalGatewayHistory/);
  assert.match(source, /session\/appendHistoryTurn/);
  assert.match(source, /contentType:"markdown"/);
  assert.match(source, /status="Completed"/);
  assert.match(source, /Cancelled/);
});

test("Qoder V15 forwards selected context and reasoning runtime settings", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V15/);
  assert.match(source, /ai-coding\/model_config/);
  assert.match(source, /context_length:contextLength/);
  assert.match(source, /reasoning:reasoningEffort\?\{effort:reasoningEffort\}/);
  assert.match(source, /context_lengths/);
  assert.match(source, /reasoning_efforts/);
  assert.match(source, /if \(!tokenCounts\.length\) return undefined/);
});

test("Qoder V16 closes the Quest state before persisting history", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V16/);
  assert.match(source, /_finishLocalGatewayPrompt/);
  assert.match(source, /terminalSent/);
  const v16Start = source.indexOf("const LOCAL_GATEWAY_PROGRESS_V16");
  const terminalIndex = source.indexOf(
    'handleChatProgress("session/update",sessionId,requestId,{sessionId,update:{sessionUpdate:"notification"'
    , v16Start);
  const historyIndex = source.indexOf(
    'await this._appendLocalGatewayHistory(sessionId,requestId,state'
    , v16Start);
  assert.ok(terminalIndex >= 0);
  assert.ok(historyIndex > terminalIndex);
  assert.match(
    source,
    /await this\.handleRequestError\("session\/prompt",\{sessionId,_meta:metadata\},error,"request"\);await this\._appendLocalGatewayHistory/
  );
});

test("Qoder V17 repairs the V16 method boundary syntax", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  const v16Start = source.indexOf("const LOCAL_GATEWAY_PROGRESS_V16");
  const v16End = source.indexOf("const LOCAL_GATEWAY_HANDLER_V12", v16Start);
  const v16Template = source.slice(v16Start, v16End);
  assert.match(source, /PATCH_MARKER_V17/);
  assert.match(
    v16Template,
    /if\(done\)await this\._finishLocalGatewayPrompt\(sessionId,requestId,state\)}`;/
  );
  assert.doesNotMatch(v16Template, /state\)\}\}async _appendLocalGatewayHistory/);
  assert.match(source, /fixedProgressBoundary/);
});

test("Qoder V18 replaces old installed handlers without losing runtime controls", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V18/);
  assert.match(source, /local gateway V18 handler replacement point/);
  assert.match(source, /runtimeConfig=metadata\?\.\["ai-coding\/model_config"\]\|\|\{\}/);
  assert.match(source, /context_length:contextLength/);
  assert.match(source, /this\.__qoderBridgeHistory/);
  assert.match(source, /await this\._appendLocalGatewayHistory\(sessionId,requestId,history,cancelled\?"Cancelled":"Failed"\)/);
});

test("Qoder V21 skips empty workspace builtin command refreshes", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V21/);
  assert.match(source, /Skipping builtin commands refresh for empty workspace/);
  assert.match(source, /!n&&!r/);
});



test("Qoder V22 falls back to an available workspace folder", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V22/);
  assert.match(source, /workspace folder fallback/);
  assert.ok(source.includes('process.cwd&&process.cwd()!=="/"?process.cwd():process.env.HOME||"/"'));
});

test("Qoder V23 gives current workspace fallback a real file URI", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V23/);
  assert.match(source, /current workspace fallback uri/);
  assert.ok(source.includes('function m(){const e=a.window.activeTextEditor?.document.uri;if(e)return{index:0,uri:e,name:"Untitled"}'));
  assert.ok(source.includes('return{index:0,uri:a.Uri.file(t),name:"Fallback"}'));
  assert.ok(source.includes('name:"Fallback"'));
});

test("Qoder V24 initializes the language server with file URIs", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V24/);
  assert.match(source, /initialize workspace uri fallback/);
  assert.ok(source.includes('e.rootUri=t[0]?.uri?.toString()'));
  assert.ok(source.includes('e.rootPath=t[0]?.uri?.fsPath'));
  assert.ok(source.includes('uri:e.uri.toString()'));
});

test("Qoder V25 repairs conflicting V24 initialize variables", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V25/);
  assert.match(source, /initialize workspace URI conflict repaired/);
  assert.ok(source.includes('conflictingInitializePatch'));
  assert.ok(source.includes('!source.includes(\'),r=t[0]?.uri?.toString();e.rootUri=r\')'));
});

test("Qoder V26 makes rootUri enumerable for Qoder initialize", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /PATCH_MARKER_V26/);
  assert.match(source, /initialize enumerable rootUri/);
  assert.ok(source.includes('Object.defineProperty(e,"rootUri"'));
  assert.ok(source.includes('enumerable:!0'));
  assert.ok(source.includes('uri:e.uri.toString()'));
});

test("Qoder V27 reuses duplicate tool results instead of aborting the session", async () => {
  const source = await fs.readFile(
    new URL("../src/core/qoder-patch.mjs", import.meta.url),
    "utf8"
  );
  const handlerStart = source.indexOf("const LOCAL_GATEWAY_HANDLER_V12");
  const handlerEnd = source.indexOf("_localGatewayTools(){", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(source, /PATCH_MARKER_V27/);
  assert.match(handler, /repeated tool call reused previous result/);
  assert.match(handler, /toolResults=new Map/);
  assert.match(handler, /await failPrompt\(/);
  assert.match(handler, /tool loop limit reached after/);
  assert.doesNotMatch(handler, /Stopped a repeated local tool call/);
  assert.doesNotMatch(handler, /Stopped the local tool loop after/);
  assert.doesNotMatch(handler, /handleRequestError\("session\/prompt"/);
});

test("local tool endpoint executes only the read-only allowlist", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-local-tool-"));
  await fs.writeFile(path.join(workspace, "fixture.txt"), "local tool ok", "utf8");
  await fs.mkdir(path.join(workspace, "folder"));
  const gateway = await startServer(createGateway({
    providers: {},
    routes: {},
    workspace_roots: [workspace]
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

    const list = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "local-tool-list",
      workspace_path: workspace,
      tool_call: {
        id: "call-list",
        function: {
          name: "list_files",
          arguments: ""
        }
      }
    });
    assert.equal(list.statusCode, 200);
    const listPayload = JSON.parse(list.body);
    assert.equal(listPayload.ok, true);
    assert.match(listPayload.content, /fixture\.txt/);
    assert.match(listPayload.content, /folder/);
    const listed = JSON.parse(listPayload.content);
    assert.equal(listed.total, 2);
    assert.equal(listed.truncated, false);

    const missingPath = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "local-tool-empty-read",
      workspace_path: workspace,
      tool_call: {
        id: "call-empty-read",
        function: {
          name: "read_file",
          arguments: "  "
        }
      }
    });
    assert.equal(missingPath.statusCode, 200);
    const missingPathPayload = JSON.parse(missingPath.body);
    assert.equal(missingPathPayload.ok, false);
    assert.equal(missingPathPayload.error, "tool path is required");

    const malformed = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "local-tool-malformed",
      workspace_path: workspace,
      tool_call: {
        id: "call-malformed",
        function: {
          name: "list_files",
          arguments: "{"
        }
      }
    });
    assert.equal(malformed.statusCode, 200);
    const malformedPayload = JSON.parse(malformed.body);
    assert.equal(malformedPayload.ok, false);
    assert.equal(malformedPayload.error, "tool arguments must be valid JSON");

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

test("discovers and reads Qoder plugin bundles from the plugin cache", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-plugin-cache-"));
  const pluginRoot = path.join(cacheRoot, "qoder-marketplace", "prompt-design-studio", "1.1.0");
  await fs.mkdir(path.join(pluginRoot, ".qoder-plugin"), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, "prompt-design-studio"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".qoder-plugin", "plugin.json"),
    JSON.stringify({
      name: "prompt-design-studio",
      version: "1.1.0",
      description: "Prompt Design Studio",
      skills: ["./skills/prompt-design-studio"]
    }),
    "utf8"
  );
  await fs.writeFile(path.join(pluginRoot, "prompt-design-studio", "SKILL.md"), "# Prompt Design Studio\n", "utf8");
  await fs.writeFile(
    path.join(pluginRoot, "prompt-design-studio", "template-library.md"),
    "# Templates\n",
    "utf8"
  );

  const previous = process.env.QODER_PLUGIN_CACHE_ROOTS;
  process.env.QODER_PLUGIN_CACHE_ROOTS = cacheRoot;
  const gateway = await startServer(createGateway({
    providers: {},
    routes: {},
    workspace_roots: [cacheRoot]
  }));

  try {
    const list = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "plugin-list",
      workspace_path: cacheRoot,
      tool_call: {
        id: "call-list-plugins",
        function: {
          name: "list_qoder_plugins",
          arguments: "{}"
        }
      }
    });
    assert.equal(list.statusCode, 200);
    const listPayload = JSON.parse(list.body);
    assert.equal(listPayload.ok, true);
    const pluginList = JSON.parse(listPayload.content);
    assert.match(JSON.stringify(pluginList), /prompt-design-studio/);
    assert.equal(pluginList.total, 1);
    assert.deepEqual(pluginList.plugins[0].skill_paths, ["prompt-design-studio/SKILL.md"]);

    const read = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "plugin-read",
      workspace_path: cacheRoot,
      tool_call: {
        id: "call-read-plugin",
        function: {
          name: "read_qoder_plugin_file",
          arguments: JSON.stringify({
            plugin: "prompt-design-studio",
            path: "SKILL.md"
          })
        }
      }
    });
    assert.equal(read.statusCode, 200);
    const readPayload = JSON.parse(read.body);
    assert.equal(readPayload.ok, true);
    assert.match(readPayload.content, /Prompt Design Studio/);

    const readFullPath = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "plugin-read-full-path",
      workspace_path: cacheRoot,
      tool_call: {
        id: "call-read-plugin-full-path",
        function: {
          name: "read_qoder_plugin_file",
          arguments: JSON.stringify({
            plugin: "prompt-design-studio",
            path: "prompt-design-studio/template-library.md"
          })
        }
      }
    });
    assert.equal(readFullPath.statusCode, 200);
    const fullPathPayload = JSON.parse(readFullPath.body);
    assert.equal(fullPathPayload.ok, true);
    assert.match(fullPathPayload.content, /Templates/);

    const search = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "plugin-search",
      workspace_path: cacheRoot,
      tool_call: {
        id: "call-search-plugins",
        function: {
          name: "search_qoder_plugins",
          arguments: JSON.stringify({ query: "Prompt" })
        }
      }
    });
    assert.equal(search.statusCode, 200);
    const searchPayload = JSON.parse(search.body);
    assert.equal(searchPayload.ok, true);
    assert.match(searchPayload.content, /prompt-design-studio/);
  } finally {
    process.env.QODER_PLUGIN_CACHE_ROOTS = previous;
    await new Promise((resolve) => gateway.server.close(resolve));
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test("rejects plugin path escapes outside the plugin bundle", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-plugin-cache-"));
  const pluginRoot = path.join(cacheRoot, "qoder-marketplace", "prompt-design-studio", "1.1.0");
  await fs.mkdir(path.join(pluginRoot, ".qoder-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".qoder-plugin", "plugin.json"),
    JSON.stringify({ name: "prompt-design-studio", version: "1.1.0" }),
    "utf8"
  );
  const policy = createToolPolicy({
    qoderPluginRoots: [cacheRoot],
    executionMode: "execute"
  });
  const result = await executeToolCall(policy, {
    id: "call-escape",
    type: "function",
    function: {
      name: "read_qoder_plugin_file",
      arguments: JSON.stringify({ plugin: "prompt-design-studio", path: "../../secret.txt" })
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.content, /stay inside the plugin directory/);
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

test("rejects local tools when workspace roots are missing or outside the allowlist", async () => {
  const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-allowed-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-outside-root-"));
  await fs.writeFile(path.join(allowed, "inside.txt"), "inside", "utf8");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

  const unconfigured = await startServer(createGateway({
    providers: {},
    routes: {}
  }));
  const missingRoots = await request(unconfigured.baseUrl, "/admin/local-tool", {
    request_id: "missing-roots",
    workspace_path: allowed,
    tool_call: {
      id: "call-missing-roots",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "inside.txt" })
      }
    }
  });
  assert.equal(missingRoots.statusCode, 200);
  const missingPayload = JSON.parse(missingRoots.body);
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.code, "workspace_roots_unconfigured");
  await new Promise((resolve) => unconfigured.server.close(resolve));

  const gateway = await startServer(createGateway({
    providers: {},
    routes: {},
    workspace_roots: [allowed]
  }));
  try {
    const nestedOk = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "nested-ok",
      workspace_path: path.join(allowed, "nested-does-not-need-to-exist"),
      tool_call: {
        id: "call-nested",
        function: {
          name: "list_files",
          arguments: JSON.stringify({ path: "." })
        }
      }
    });
    assert.equal(nestedOk.statusCode, 200);
    assert.equal(JSON.parse(nestedOk.body).ok, false);

    const denied = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "outside-root",
      workspace_path: outside,
      tool_call: {
        id: "call-outside",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "secret.txt" })
        }
      }
    });
    assert.equal(denied.statusCode, 200);
    const deniedPayload = JSON.parse(denied.body);
    assert.equal(deniedPayload.ok, false);
    assert.equal(deniedPayload.code, "workspace_not_allowed");

    const allowedRead = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "allowed-root",
      workspace_path: allowed,
      tool_call: {
        id: "call-allowed",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "inside.txt" })
        }
      }
    });
    assert.equal(allowedRead.statusCode, 200);
    assert.equal(JSON.parse(allowedRead.body).ok, true);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    await fs.rm(allowed, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("allows plugin cache tools without a workspace folder", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-plugin-empty-ws-"));
  const pluginRoot = path.join(cacheRoot, "qoder-marketplace", "architecture-visual", "1.0.0");
  await fs.mkdir(path.join(pluginRoot, ".qoder-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".qoder-plugin", "plugin.json"),
    JSON.stringify({ name: "architecture-visual", version: "1.0.0", description: "Architecture visual" }),
    "utf8"
  );
  const previous = process.env.QODER_PLUGIN_CACHE_ROOTS;
  process.env.QODER_PLUGIN_CACHE_ROOTS = cacheRoot;
  const gateway = await startServer(createGateway({
    providers: {},
    routes: {},
    workspace_roots: []
  }));
  try {
    const missingWorkspace = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "empty-ws-list",
      workspace_path: "",
      tool_call: {
        id: "call-empty-ws",
        function: {
          name: "list_files",
          arguments: "{}"
        }
      }
    });
    assert.equal(missingWorkspace.statusCode, 200);
    const missingPayload = JSON.parse(missingWorkspace.body);
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.code, "workspace_required");
    assert.match(missingPayload.error, /open a folder in Qoder/);

    const plugins = await request(gateway.baseUrl, "/admin/local-tool", {
      request_id: "empty-ws-plugins",
      tool_call: {
        id: "call-plugins",
        function: {
          name: "list_qoder_plugins",
          arguments: JSON.stringify({ query: "Architecture" })
        }
      }
    });
    assert.equal(plugins.statusCode, 200);
    const pluginPayload = JSON.parse(plugins.body);
    assert.equal(pluginPayload.ok, true);
    assert.match(pluginPayload.content, /architecture-visual/);
  } finally {
    process.env.QODER_PLUGIN_CACHE_ROOTS = previous;
    await new Promise((resolve) => gateway.server.close(resolve));
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});
