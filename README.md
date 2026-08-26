# Qoder Bridge Gateway

这是一个面向本机使用的 Qoder Gateway。网关把 Chat、Responses 和
Anthropic Messages 请求统一转换后转发到 `ymeng.cc` 等兼容上游；Qoder
Desktop 接入走本地模型补丁路径，不依赖 custom pool 的云端 Provider 校验。

当前网关提供：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- 本地控制台：`http://127.0.0.1:8787/`
- 主模型和 fallback 模型路由
- 从上游 `/v1/models` 记录 `supported_endpoint_types`
- 对已核对的上游模型补充独立能力表：上下文上限、推理档位和输入/输出模态
- Chat、Responses、Anthropic、stream、tools、vision、reasoning 能力字段
- OpenAI Chat、OpenAI Responses、Anthropic Messages 的非流式转换
- OpenAI Responses 的 `input` 到 Anthropic `messages` 转换
- 同协议 SSE 透传，以及 Responses/Anthropic 到统一事件流后的跨协议 SSE 转换
- 原生 `tool_calls` 透传
- 仅对已声明工具进行安全的文本工具调用解析；不执行命令，当前没有开放任意终端执行能力
- 管理接口的配置和错误脱敏
- 独立的 `qoder-bridge/` 本地 Bridge 骨架、脱敏探针、请求取消和
  证据驱动的 JSON-RPC/ACP IPC 客户端

## 启动

```bash
cd /Users/a0000/Documents/gpt-codex/qoder-gateway
cp config.example.json config.json
export YMENG_API_KEY='替换为 api.ymeng.cc 的 API Key'
npm test
npm start
```

默认监听 `127.0.0.1:8787`。不要把网关长期暴露到公网；临时联调也应使用独立网关 Bearer Key 和短期 HTTPS 隧道。
如果没有设置 `YMENG_API_KEY`，网关仍会启动并提供本地健康检查，但不会同步
上游模型目录，也不会执行真实模型请求。也可以打开本地控制台，在“第三方
API Key（本次运行）”字段临时注入密钥；该密钥只保存在当前网关进程内存中。
启动时检测到环境变量密钥后，网关会自动同步 Provider 的 `/v1/models`，
不需要先手动点击同步。
重启网关会清除这类运行时注入的密钥；重启后出现 401 时，需要重新注入，
或在启动网关的同一个终端先设置 `YMENG_API_KEY`。控制台输入即使带有
`Bearer ` 前缀也会被网关规范化，不会写入配置文件。

如果网关已经在旧终端运行，修改 `server.mjs` 后必须重启 Node 进程；控制台
保存配置只能热更新配置值，不能替换已经加载的 JavaScript。推荐按下面顺序
重启，避免长任务继续使用旧的 120 秒超时和旧的路由筛选逻辑：

```bash
cd /Users/a0000/Documents/gpt-codex/qoder-gateway
export YMENG_API_KEY='替换为 api.ymeng.cc 的 API Key'
npm start
```

另开终端执行 `node tools/patch-qoder.mjs`，然后完全退出并重新打开 Qoder。
如果不希望在 shell 历史中出现密钥，可先运行 `npm start`，再在本地控制台
输入“第三方 API Key（本次运行）”；不要把真实密钥写入配置文件。

## Qoder Desktop 本地模型

当前已在 Qoder CN IDE 1.26.0 上验证本地接入。补丁会把本地 Gateway 模型
重建为 Qoder 可见的自定义模型记录，并在选择该模型时把 ACP prompt 转发到
本机 `/v1/responses`；不会调用 Qoder custom pool 生成接口，也不会修改 Qoder
自带模型逻辑。

启动 Gateway 时会自动执行 Qoder 本地补丁。配置入口是：

```bash
"qoder_patch": {
  "enabled": true,
  "gateway_url": "http://127.0.0.1:8787"
}
```

网关会等待模型能力目录同步完成后，自动从本地 `/v1/models` 读取真实模型
目录，并在 Qoder 的本地自定义模型存储里重建对应记录，自动过滤旧的测试
模型条目。随后会应用 Provider、Responses 转发、禁更新和禁推送补丁。Qoder
更新后只需重启网关即可重新应用；也可以通过下面的管理接口立即重新应用：

```bash
curl -X POST http://127.0.0.1:8787/admin/qoder-patch
```

当前 Qoder 本地补丁为 V27。V16 到 V26 主要补齐了 Quest 终态收口、
工作区 URI 回退、initialize `rootUri` 可枚举，以及只读插件缓存工具。
V27 修复第三方模型在 Quest 里被工具回路掐死的问题：

- Responses `response.reasoning_*` 事件只发送为 ACP `agent_thought_chunk`
  思考事件，不混入正文。
- Responses `response.output_text.*` 事件只发送为 ACP
  `agent_message_chunk` 正文事件，并防止 delta 与 done 重复显示。
- 原生 `function_call` 会转换为 ACP `tool_call`，工具完成后发送
  `tool_call_update`，再用 `function_call_output` 继续请求。单次请求最多
  8 轮、24 次工具调用；同一签名重复超过 2 次会停止，避免短任务被误判或空转。
- Qoder 会收到工作区只读工具 `read_file`、`list_files`、`search_text`，
  以及插件缓存只读工具 `list_qoder_plugins`、`list_qoder_plugin_files`、
  `read_qoder_plugin_file`、`search_qoder_plugins`。工具执行通过本机
  `POST /admin/local-tool`，只接受 localhost 请求。工作区文件工具必须落在
  配置的 `workspace_roots` 内；未打开文件夹或未配置根目录时会拒绝
  `read_file` / `list_files` / `search_text`，但插件缓存工具仍可使用。
- 同一组参数的重复工具调用会复用上次结果并继续对话，不再把整场任务掐死。
  上游失败会作为一段说明文字结束，而不是 Qoder「系统发生异常」。
- 不支持终端、Shell、写文件、补丁或任意命令执行。工具解析失败或工具不在
  allowlist 时不会执行任何命令，而是把失败结果返回给模型继续处理。
- 补丁会先发送 `session/prompt` 和 `chat_finish` 终态，再异步追加历史记录；
  历史写入变慢或失败不会让 Quest 侧栏一直保持运行中。成功、失败和取消
  都有一次性终态保护。
- V21 起跳过空工作区的 builtin command 刷新；V22-V26 为 Quest 空工作区
  和 initialize `rootUri` 提供本机回退，避免语言服务器初始化失败。

因此，长工作中看到思考、正文和工具卡片同时出现并不代表网关把内容混成一段：
它们分别对应 Qoder 的思考事件、消息事件和工具生命周期事件。若 Qoder
界面仍把思考显示在正文中，先完全退出 Qoder（macOS 使用 `⌘Q`），再重新
打开，让最新的 extension bundle 被重新加载。

本机受控工具接口示例：

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/local-tool \
  -H 'content-type: application/json' \
  --data-binary '{
    "request_id": "manual-read-test",
    "workspace_path": "/Users/a0000/Documents/gpt-codex/qoder-gateway",
    "tool_call": {
      "id": "call-read",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"README.md\"}"
      }
    }
  }'
```

该接口仅用于 Qoder 本地补丁的受控工具回路，不是通用命令执行 API，也不应
暴露到公网。调用前必须在 `config.json` 或控制台填写 `workspace_roots`，
例如：

```json
"workspace_roots": [
  "/Users/a0000/Documents/gpt-codex/qoder-gateway"
]
```

`workspace_path` 必须等于其中一个根目录，或落在其内部。未配置根目录时，
接口会返回 `workspace_roots_unconfigured`，而不是读取任意本机路径。

在本地控制台添加路由并点击“保存配置”后，网关会自动重新读取当前
`/v1/models` 并注入 Qoder Provider，不需要再手动调用上面的接口。保存响应中的
`qoder_patch_sync` 会报告自动注入状态和已注入的模型数量。控制台保存配置时
也会保留 `qoder_patch.enabled`，不会因为表单未显示该字段而意外关闭自动注入。

旧命令仍然兼容：

```bash
node tools/patch-qoder.mjs
```

脚本会自动识别 `/Applications/Qoder CN IDE.app` 和旧版安装路径。重复运行
是幂等的，不会重复添加本地 Provider；每次运行会在
`~/Library/Application Support/QoderCN/Backups/` 创建不覆盖已有文件的
bundle 备份。若本机没有 Qoder，网关只记录脱敏警告，不会启动失败。

补丁从 `http://127.0.0.1:8787/v1/models` 动态读取真实模型目录。当前 Qoder
专家团识别的本地模型键是 `Qwen3.8max`、`GLM5.2` 和 `GLM5.3`。
它们只是本地路由别名，不是上游真实模型 ID。当前 `config.json` 将
`Qwen3.8max` 映射到 ymeng 上游目录中的 `gpt-5.5`，将 `GLM5.2` 映射到
`grok-4.6`，将 `GLM5.3` 映射到 `gpt-5.6-sol`。不要把本地别名误当成
上游真实模型 ID，也不要在脚本或配置中凭空添加不存在的上游模型名。
这些路由使用 `openai-response` 协议。`grok-4.6` 虽然目录声明了 `anthropic`，但本地实测
其 Anthropic Messages 转发会导致上游连接失败；它的 Responses 入口会拒绝
Qoder 附带的内部 `metadata`，因此补丁和网关都不会把这类内部元数据发送给上游。
重复运行补丁会刷新已经注入的 Provider 模型列表和 Qoder 本地自定义模型
记录；如果模型目录发生变化，无需手工编辑 Qoder bundle。

补丁写入 Qoder bundle 后，必须完全退出 Qoder（macOS 使用 `⌘Q`，不是只关闭
窗口）再重新打开；已经运行的 Qoder 进程不会热加载新的模型列表。通过控制台
保存配置、输入本次运行的 API Key，或调用下面的管理接口，都会触发一次自动
注入：

```bash
curl -X POST http://127.0.0.1:8787/admin/qoder-patch
```

如果只是手动编辑 `config.json`，请在编辑后执行上面的接口，再完全重启
Qoder。模型选择器应显示网关路由别名，例如 `Qwen3.8max`、`GLM5.2`、
`GLM5.3`；它们不是上游真实模型 ID。
补丁会在以下目录生成 Qoder bundle 备份：

```text
~/Library/Application Support/QoderCN/Backups/
```

完全退出并重新启动 Qoder 后，在模型选择器中选择 `Qwen3.8max`。已验证的链路是：

```text
Qoder model selector
  -> qoder-local-gateway / Qwen3.8max
  -> http://127.0.0.1:8787/v1/responses
  -> ymeng.cc relay / gpt-5.5
```

Qoder 的 app bundle 被修改后，macOS 或 Qoder 内部仍可能把它标记为非官方
构建；这不代表 Gateway 请求失败。补丁会抑制 Qoder 自己的完整性告警，
并且只允许 `127.0.0.1`、`localhost` 或 `[::1]` 的 Base URL。

补丁还会在本机 Qoder 进程内关闭自动更新检查、手动“检查更新”入口、
`product.json` 的更新地址、动态远程公告候选和 Electron 系统通知入口。
这里的“禁止推送”指动态公告和系统通知弹窗，不等于阻断 Qoder 的所有
业务网络请求，也不等于禁止网关或上游模型产生内容。Qoder 再次升级后，
需要重新运行 `node tools/patch-qoder.mjs`。

第二阶段 Bridge 仍需要另开一个终端启动：

```bash
npm run bridge
```

默认监听 `127.0.0.1:8890`，转发目标是
`http://127.0.0.1:8787/v1/responses`。Bridge 的本地接口是
`POST /bridge/session/prompt` 和
`POST /bridge/session/:request_id/cancel`。它使用内部定义的
`bridge.event` SSE 包装，不声称已经兼容 Qoder IPC、ACP 或
`session/prompt` 的真实格式。

如需在受控环境中连接本机 Qoder CN Agent，必须显式开启 live IPC；默认
仍然关闭。Bridge 仍只监听本机，并且工作区必须落在显式允许的根目录内：

```bash
QODER_BRIDGE_ENABLE_LIVE_IPC=1 \
QODER_BRIDGE_TOOL_MODE=controlled \
QODER_BRIDGE_WORKSPACE_ROOTS=/Users/a0000/Documents/gpt-codex/qoder-gateway \
QODER_IPC_SOCKET="$HOME/Library/Application Support/QoderCN/SharedClientCache/qodercn.sock" \
npm run bridge
```

live IPC 的一次性接口为 `POST /bridge/qoder/session/prompt`，默认只监听
`127.0.0.1:8890`。它转发文本 prompt、模型、请求 ID 和工作区元数据，
`mcpServers` 固定为空。`QODER_BRIDGE_TOOL_MODE` 默认是 `dry-run`；
只有显式设为 `controlled` 时，才会在允许的工作区内提供
`read_file`、`list_files`、`search_text` 三个受控只读工具。任何其他工具、
越出工作区的路径和任意终端命令都会被拒绝。`QODER_BRIDGE_WORKSPACE_ROOTS`
使用 macOS 的路径分隔符配置多个根目录，未配置时只允许 Bridge 当前工作目录。

当前已在 Qoder CN IDE 1.26.0 的本机 Agent socket 上验证
`initialize`、`session/new`、`session/prompt`、真实 `session/update`、
`tool/invoke`、受控 `read_file` 和 `session/cancel`。这证明 Agent IPC
和工具响应链路可用。独立 Bridge 的 session handoff、工具确认界面和
文件上下文展示仍需单独验证；Qoder Desktop 本地模型接入则已由上面的
bundle patch 路径完成验证。

Bridge 也会对 Qoder 主动发来的 `task/status/sync`、
`user/inprogress/task/sync`、`task/planProgress/content/sync`、
`user/task/stats/sync`、`snapshot/syncAll` 和 `session/title/update`
请求返回空成功结果，避免辅助状态同步被 Bridge 拒绝。实测一次真实
Quest prompt 记录为 `task/status/sync: 2 success, 0 failed`。

持久化 session 实验接口也已加入：

```text
POST /bridge/qoder/session/open
GET  /bridge/qoder/sessions
POST /bridge/qoder/session/:session_id/prompt
POST /bridge/qoder/session/:session_id/cancel
POST /bridge/qoder/session/:session_id/close
```

`open` 不带 `session_id` 时调用 Qoder `session/new`；带
`session_id` 时调用 `session/load`。session 只保存在 Bridge 进程内存，
不会写入配置文件，Bridge 重启后需要重新 attach。live IPC 的 `model`
字段是 Qoder Agent 的本地 model key，与 Gateway/ymeng 的真实模型 ID
不是同一套命名；当前只使用从本机日志观察到的值，不在 Gateway 中硬编码
新的上游模型名。

API Key 只能通过环境变量、运行时内存或 macOS 钥匙串输入：

- `api_key_env` 只填写变量名，例如 `YMENG_API_KEY`
- 控制台的“第三方 API Key”默认只保存在当前进程内存；勾选后写入钥匙串
- 不要把真实密钥写入 `config.json`、README、Qoder 补丁或提交记录
- 配置返回值、诊断响应和网关错误会过滤鉴权信息

## 配置

Provider 的 `base_url` 应使用 API 根路径，例如：

```json
{
  "listen": "127.0.0.1:8787",
  "gateway_api_key_env": "",
  "workspace_roots": [
    "/Users/a0000/Documents/gpt-codex/qoder-gateway"
  ],
  "providers": {
    "ymeng-openai": {
      "protocol": "openai",
      "base_url": "https://api.ymeng.cc/v1",
      "api_key_env": "YMENG_API_KEY",
      "timeout_ms": 660000
    }
  }
}
```

路由左侧是本地别名，右侧 `model` 必须是上游模型目录实际返回的 ID。
主路由和 fallback 可以使用数组或 `fallback` 对象：

```json
{
  "routes": {
    "qoder-coding": [
      {
        "provider": "ymeng-openai",
        "model": "替换为 /v1/models 返回的实际模型 ID",
        "protocol": "openai-response"
      },
      {
        "provider": "ymeng-openai",
        "model": "替换为另一个实际模型 ID",
        "protocol": "openai"
      }
    ]
  }
}
```

数组顺序就是 fallback 顺序。网关不会凭空添加任何模型名；请先同步目录，
再根据 `supported_endpoint_types` 选择入口协议。对 Qoder Desktop，优先使用
`openai-response`；只有模型不支持 Responses 时才选择 `openai` 或
`anthropic`。控制台从目录添加路由时也遵循这个优先级。已同步目录后，网关会按
`stream`、`tools`、`vision` 和 `reasoning` 能力过滤候选；未同步时能力保持
未知，不会伪造支持声明。中转目录只作为发现来源；如果中转没有返回详细
运行参数，网关会使用 `src/core/upstream-capabilities.mjs` 中已核验的上游
能力表。对于未收录的模型，可以在路由对象中补充已核验字段：

```json
{
  "provider": "ymeng-openai",
  "model": "actual-upstream-model",
  "protocol": "openai-response",
  "context_lengths": [500000],
  "max_input_tokens": 500000,
  "reasoning_efforts": ["low", "medium", "high"],
  "capabilities": {
    "vision": true,
    "reasoning": true
  }
}
```

这些字段必须来自模型官方文档或实际能力验证；没有证据时不要填写。

## 能力发现

```bash
curl http://127.0.0.1:8787/admin/upstream-models?provider=ymeng-openai
curl http://127.0.0.1:8787/v1/models
```

同步后，网关会在内存中记录每个真实模型的：

```text
chat / responses / anthropic / stream / tools / vision / reasoning
context_lengths / max_input_tokens / reasoning_efforts
input_modalities / output_modalities
```

`/v1/models` 返回的是本地路由别名、主模型能力和
`fallback_models`。真实模型目录只保存在运行时内存，不会被自动写入
`config.json`。

## 内部请求格式

所有入口先归一化为：

```text
model
messages
input
tools
tool_choice
images
stream
reasoning
metadata
```

路由内部另外保留请求 ID、入口 facade、本地别名和上游模型字段，用于诊断
和 fallback；这些字段不会改变对外协议。

适配器位于：

```text
src/core/request.mjs
src/core/router.mjs
src/core/capabilities.mjs
src/adapters/openai-chat.mjs
src/adapters/openai-responses.mjs
src/adapters/anthropic.mjs
src/adapters/stream-events.mjs
```

## Bridge 探针与边界

Bridge 探针只记录字段名、字段类型、方向、事件名、流式标志、工具标志
和文件上下文标志，不记录 payload 值：

```bash
node qoder-bridge/probe.mjs --port 127.0.0.1 37510
node qoder-bridge/probe.mjs --port 127.0.0.1 36510 --websocket
node qoder-bridge/probe.mjs --fixture qoder-bridge/fixtures/sample-events.jsonl
node qoder-bridge/probe.mjs --socket "$HOME/Library/Application Support/QoderCN/SharedClientCache/qodercn.sock"
```

当前对 Qoder CN IDE 1.26.0 的本机观察结果是：

- `SharedClientCache/qodercn.sock` 是扩展宿主优先使用的本地 Agent IPC，
  只读连接探针成功；本轮已实际发送一个无业务内容的 `initialize`，
  Qoder 返回了 `serverInfo.name=qodercn`、`serverInfo.version=1.26.0`
  和 LSP 能力。
- Qoder bundle 的 Unix socket transport 使用
  `Content-Length: <bytes>\r\n\r\n` 加 UTF-8 JSON 的 JSON-RPC framing。
- `36510` 对标准 WebSocket Upgrade 返回 `101 Switching Protocols`，
  但当前没有证据证明它是 ACP 主通道。
- `37510` 为普通 HTTP/扩展 surface，GET `/` 返回 404。

`qoder-bridge/json-rpc.mjs`、`transport.mjs` 和 `ipc-client.mjs` 已实现
framing、请求/响应、通知、服务端反向请求响应和观察到的 ACP 方法形状；
`test/bridge.test.mjs` 在 mock Unix socket 上覆盖这些业务方法。真实 Qoder
socket 已在受控探针中验证 `initialize`、`session/new`、`session/prompt`、
`session/update`、`tool/invoke`、受控 `read_file` 和 `session/cancel`；
prompt 已产生真实文本/思考/完成事件。

本地网关、模型发现、Qoder 本地模型补丁和 Bridge 自测已经完成。Qoder 的
custom pool 生成和 Provider 云端校验仍由 Qoder 控制；本方案绕开该路径，
不把 `Failed to generate custom pool` 当作 Gateway 协议错误处理。

仍需要 Qoder Desktop 实际运行证据的内容：

- 独立 `qoder-bridge/` 是否能通过 IPC session handoff 直接接管现有 UI
- Qoder Desktop UI 的 session handoff、工具确认界面和文件上下文展示
- Desktop 侧实际使用的图片载荷和更多工具确认事件细节

最终结论：Qoder CN IDE 1.26.0 已能添加并使用本地 Gateway 模型
`Qwen3.8max`，实际请求已由本地 Gateway 转发并在 Qoder UI 显示文本。
独立 `qoder-bridge/` 仍是受控研究路径，下一步只需继续验证它的 UI
handoff、工具确认和文件上下文，不需要再修改 Gateway Base URL。

## 安全边界

- 默认只监听 `127.0.0.1`。
- API Key 只能来自环境变量、运行时内存或 macOS 钥匙串。
- `api_key_env` 必须是类似 `YMENG_API_KEY` 的变量名。
- 配置禁止保存 API Key、嵌入式 URL 凭据和敏感自定义 Header。
- `GET /health` 公开。`/admin/recent-requests` 和其他管理接口走
  `authorize()`；未配置 `gateway_api_key_env` 时，本机控制台仍可访问，
  但不要把监听地址改成公网网卡。
- `POST /admin/local-tool` 只接受 localhost，且工作区必须在
  `workspace_roots` 内；未配置根目录时 fail closed。
- 工具默认 dry-run，只允许受控文件工具和只读插件缓存工具；不开放任意
  终端命令。
- Qoder Desktop 的 app bundle 修改由网关启动时的
  `src/core/qoder-patch.mjs` 执行；`tools/patch-qoder.mjs` 只是兼容入口。
  没有修改 custom pool 云端逻辑，也没有新增公网服务。

## 验证

```bash
npm test
```

当前验证结果：覆盖 Chat、Responses、Anthropic、SSE、tool_calls、
tool result、fallback、能力发现、脱敏、鉴权 fail-closed、管理接口鉴权、
`workspace_roots` 约束、空工作区插件工具、重复工具复用、工具路径安全、
JSON-RPC framing、mock IPC 请求/响应/通知和 Bridge 本地自测。另行完成了真实 Qoder CN socket
的非流式 prompt、流式 prompt、controlled `read_file`、cancel，以及
持久化 session 的两次复用 prompt 和 close 运行态验证；同时完成了
Qoder Desktop 选择 `qwen3.8-max`、本地 `/v1/responses` 返回 200 以及
Qoder UI 文本显示验证。独立 Bridge 的 UI 接管仍未宣称完成。

长任务失败时先看：

```bash
curl http://127.0.0.1:8787/admin/config
curl http://127.0.0.1:8787/admin/recent-requests
```

确认 `timeout_ms` 为 `660000`，并在 `recent-requests` 的 `failures` 中区分
上游超时、连接失败、HTTP 错误或认证错误。若响应仍是旧格式、没有 `failures`
详情，说明 8787 仍是旧 Node 进程，需要按上面的命令重启。
