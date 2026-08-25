# Qoder Bridge

This directory is an independent local bridge skeleton for the second phase of
Qoder Gateway work.

It currently provides:

- a localhost-only bridge HTTP service;
- one-shot text requests forwarded to the gateway `/v1/responses`;
- SSE forwarding as a documented local `bridge.event` envelope;
- request IDs and cancellation;
- a protocol probe that records field names, field types, directions, event
  names, stream/tool/file-context flags only;
- an evidence-based ACP-shaped normalizer for `session/new`,
  `session/prompt`, `session/cancel`, `session/update` and tool progress;
- a lazy JSON-RPC client for the observed Unix-socket transport, including
  `initialize`, `session/new`, `session/prompt`, `session/cancel`,
  `session/load` and `session/set_model`;
- Quest-aware initialization with optional history replay parameters
  (`loadRequestLimit` and `loadTillRequestId`);
- inbound JSON-RPC request responses for the observed Qoder auxiliary requests
  (`task/status/sync`, `user/inprogress/task/sync`,
  `task/planProgress/content/sync`, `user/task/stats/sync`,
  `snapshot/syncAll`, `session/title/update`) and `tool/invoke`;
- workspace-aware initialization and an allowlisted, read-only tool runtime;
- no terminal command execution and no Qoder.app patching.

The standalone `bridge.event` envelope is intentionally not claimed to be
Qoder IPC, ACP, or `session/prompt` compatible. The live IPC path does speak
the observed Qoder Unix-socket JSON-RPC framing and request shapes, but it is
still a research bridge and has not been shown to drive the Qoder Desktop UI.

Start it after the gateway is running:

```bash
cd /Users/a0000/Documents/gpt-codex/qoder-gateway
npm run bridge
```

The default listener is `127.0.0.1:8890`, and the gateway target is
`http://127.0.0.1:8787`. Override them with `QODER_BRIDGE_LISTEN` and
`QODER_GATEWAY_URL`. Live IPC is disabled unless
`QODER_BRIDGE_ENABLE_LIVE_IPC=1` is set.

For a controlled local workspace run:

```bash
QODER_BRIDGE_ENABLE_LIVE_IPC=1 \
QODER_BRIDGE_TOOL_MODE=controlled \
QODER_BRIDGE_WORKSPACE_ROOTS=/Users/a0000/Documents/gpt-codex/qoder-gateway \
QODER_IPC_SOCKET="$HOME/Library/Application Support/QoderCN/SharedClientCache/qodercn.sock" \
npm run bridge
```

`QODER_BRIDGE_TOOL_MODE` accepts `dry-run` (the default) or `controlled`.
Controlled mode only allowlists `read_file`, `list_files`, and `search_text`;
it never enables arbitrary shell commands. `QODER_BRIDGE_WORKSPACE_ROOTS`
accepts multiple roots separated by the platform path delimiter. A request
whose `cwd`, `workspace_path`, or `workspace.path` is outside those roots is
rejected.

Probe only local TCP availability or sanitized fixtures:

```bash
node qoder-bridge/probe.mjs --port 127.0.0.1 37510
node qoder-bridge/probe.mjs --port 127.0.0.1 36510 --websocket
node qoder-bridge/probe.mjs --fixture qoder-bridge/fixtures/sample-events.jsonl
node qoder-bridge/probe.mjs --fixture qoder-bridge/fixtures/qoder-acp-shapes.jsonl
node qoder-bridge/probe.mjs --socket "$HOME/Library/Application Support/QoderCN/SharedClientCache/qodercn.sock"
```

The ACP-shaped normalizer is based on observed Qoder bundle field names. The
live client now sends workspace-aware `initialize`, starts a Qoder
`session/new`, forwards `session/prompt`, observes `session/update`, and
answers inbound `tool/invoke` requests through the controlled tool runtime.

Persistent session endpoints are available when live IPC is enabled:

```text
POST /bridge/qoder/session/open
GET  /bridge/qoder/sessions
POST /bridge/qoder/session/:session_id/prompt
POST /bridge/qoder/session/:session_id/cancel
POST /bridge/qoder/session/:session_id/close
```

`session/open` calls `session/new` unless `session_id` is supplied, in which
case it calls `session/load`. A `model` value is required for both paths:
Qoder's `session/load` response does not reliably restore the model key, so
Bridge follows the load with an explicit `session/set_model`. These sessions
live in Bridge memory only and must be opened or loaded again after a Bridge
restart. The `model` value for this live IPC path is Qoder's local Agent model
key; it is separate from the Gateway's upstream model IDs. Use an observed
Qoder key for experiments rather than inventing a model name.

Live Bridge initialization defaults to `ideWindowType=quest`, matching the
Quest/Agents window. Pass `ide_window_type=editor` only when intentionally
testing an Editor-style session. `load_request_limit` and
`load_till_request_id` are optional and are forwarded only when supplied.

Current local observation for Qoder CN 1.25.1:

- `SharedClientCache/qodercn.sock`: the primary local Agent connection used by
  Qoder's extension host. A minimal `initialize` request was sent in the
  current run and Qoder returned `serverInfo.name=qodercn`,
  `serverInfo.version=1.25.1`, and LSP capabilities.
- `127.0.0.1:36510`: the companion WebSocket listener advertised in
  `SharedClientCache/.info.json`; a standard Upgrade returns 101.
- `127.0.0.1:37510`: a separate local HTTP/extension surface observed during
  probing; GET `/` returns 404.
- Qoder's bundled `vscode-jsonrpc` reader/writer uses
  `Content-Length: <bytes>\r\n\r\n` followed by UTF-8 JSON.
- `json-rpc.mjs`, `transport.mjs` and `ipc-client.mjs` implement that framing
  and the observed request/notification shapes. Tests use a mock Unix socket.
- The real socket has been verified with `initialize`, `session/new`,
  `session/prompt`, `session/update`, `tool/invoke`, controlled `read_file`,
  and `session/cancel`. The persistent API has also been verified against the
  real socket with two prompts on one session and explicit close. The prompt
  produced thought chunks, message chunks, `chat_finish`, and task status
  events. Bridge now answers Qoder's task-status and in-progress-task sync
  requests with an empty success result; a real run recorded
  `task/status/sync: 2 success, 0 failed` on the Qoder side.
- A real Qoder-created Quest session was then loaded through Bridge and
  prompted twice. Qoder completed both prompts and persisted the assistant
  replies in its local conversation-history file, but the already-open Quest
  window did not render the new replies after task switching. Desktop UI
  handoff therefore remains unverified even though IPC execution, persistence,
  and status synchronization are working.
- A follow-up UI-created Quest check was performed on August 24, 2026. Qoder
  exposed the new page as `blank_session_quest`, and `session/load` accepted
  that identifier, but Qoder had no persisted session row for it. A prompt
  then failed with `model key is empty`, and `session/set_model` could not
  repair it because the session did not exist in Qoder's local store. This
  indicates that a blank Quest page is only a UI placeholder; the real task
  session is created by Qoder's own submit flow. The bridge must therefore
  keep UI handoff marked as unverified until the task/session creation and
  Quest-window update path are observed end to end.
