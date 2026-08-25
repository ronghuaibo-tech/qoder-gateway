const MAX_DEPTH = 5;
const MAX_KEYS = 200;

export const ACP_METHODS = Object.freeze([
  "initialize",
  "session/new",
  "session/prompt",
  "session/cancel",
  "session/load",
  "session/generateTitle",
  "session/appendHistoryTurn",
  "session/request_permission",
  "session/set_mode",
  "session/set_model",
  "session/set_model/quest",
  "fs/read_text_file",
  "fs/write_text_file"
]);

export const ACP_UPDATE_TYPES = Object.freeze([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "notification",
  "tool_call",
  "tool_call_update",
  "plan",
  "current_mode_update",
  "current_model_update",
  "available_commands_update"
]);

export function inspectProtocolPayload(payload, {
  direction = "unknown",
  source = "unknown"
} = {}) {
  const fieldTypes = {};
  const eventNames = new Set();
  walk(payload, "$", 0, fieldTypes, eventNames);
  const serialized = JSON.stringify(payload);
  return {
    direction,
    source,
    field_types: fieldTypes,
    event_names: [...eventNames].sort(),
    stream: detectStream(payload, serialized),
    tools: detectTools(payload, serialized),
    file_context: detectFileContext(payload, serialized)
  };
}

export function inspectJsonLine(line, options = {}) {
  try {
    return inspectProtocolPayload(JSON.parse(line), options);
  } catch {
    return {
      direction: options.direction ?? "unknown",
      source: options.source ?? "unknown",
      field_types: { $: "invalid_json" },
      event_names: [],
      stream: false,
      tools: false,
      file_context: false
    };
  }
}

export function classifyAcpEnvelope(payload) {
  const method = typeof payload?.method === "string" ? payload.method : undefined;
  const sessionUpdate = payload?.data?.update?.sessionUpdate
    ?? payload?.update?.sessionUpdate;
  const stopReason = payload?.data?.stopReason ?? payload?.stopReason;
  return {
    method: method && ACP_METHODS.includes(method) ? method : undefined,
    kind: typeof payload?.kind === "string" ? payload.kind : undefined,
    session_update: typeof sessionUpdate === "string" && ACP_UPDATE_TYPES.includes(sessionUpdate)
      ? sessionUpdate
      : undefined,
    has_session_id: typeof (payload?.sessionId ?? payload?.params?.sessionId) === "string",
    has_request_id: typeof (payload?.requestId ?? payload?._meta?.["ai-coding/request-id"]) === "string",
    has_stop_reason: typeof stopReason === "string",
    has_workspace_metadata: Boolean(
      payload?._meta?.["ai-coding/workspace-path"]
      || payload?.data?._meta?.["ai-coding/workspace-path"]
    )
  };
}

function walk(value, path, depth, fieldTypes, eventNames) {
  if (depth > MAX_DEPTH || Object.keys(fieldTypes).length >= MAX_KEYS) return;
  fieldTypes[path] = typeOf(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index += 1) {
      walk(value[index], `${path}[${index}]`, depth + 1, fieldTypes, eventNames);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value).slice(0, MAX_KEYS)) {
    const childPath = `${path}.${key}`;
    fieldTypes[childPath] = typeOf(child);
    if ((key === "event" || key === "event_name" || key === "type") && typeof child === "string") {
      if (/^(response|message|content_block|session|tool|error)[._-]/i.test(child)) {
        eventNames.add(child);
      }
    }
    walk(child, childPath, depth + 1, fieldTypes, eventNames);
  }
}

function detectStream(payload, serialized) {
  return Boolean(
    payload?.stream === true
    || payload?.streaming === true
    || payload?.type === "stream"
    || /event:\s|data:\s|delta|stream/i.test(serialized)
  );
}

function detectTools(payload, serialized) {
  return Boolean(
    Array.isArray(payload?.tools)
    || Array.isArray(payload?.tool_calls)
    || payload?.tool_call
    || payload?.function_call
    || /tool[_-]?call|tool[_-]?use|function[_-]?call/i.test(serialized)
  );
}

function detectFileContext(payload, serialized) {
  return Boolean(
    payload?.file
    || payload?.files
    || payload?.workspace
    || payload?.workspaceRoot
    || payload?.path
    || /file|workspace|repository|repo|path/i.test(serialized)
  );
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
