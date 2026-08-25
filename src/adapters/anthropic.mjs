import { modelFor, normalizeRequest, parameter } from "../core/request.mjs";

export function fromAnthropic(body, context) {
  return normalizeRequest("anthropic", body, context);
}

export function toAnthropic(request, provider = {}) {
  const system = [];
  const messages = [];
  const sourceMessages = request.messages?.length
    ? request.messages
    : responsesInputToMessages(request.input);
  for (const message of sourceMessages) {
    if (message.role === "system" || message.role === "developer") {
      system.push(contentToText(message.content));
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: normalizeAnthropicContent(message.content)
        }]
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      messages.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: contentToText(message.content) }] : []),
          ...message.tool_calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function?.name,
            input: parseObject(call.function?.arguments)
          }))
        ]
      });
      continue;
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: normalizeAnthropicContent(message.content)
    });
  }
  const payload = {
    model: modelFor(request),
    messages,
    max_tokens: parameter(request, "max_tokens",
      parameter(request, "max_completion_tokens",
        parameter(request, "max_output_tokens", 4096))),
    stream: request.stream === true
  };
  if (system.length) payload.system = system.join("\n\n");
  for (const key of ["temperature", "top_p", "stop"]) {
    const value = parameter(request, key);
    if (value !== undefined) payload[key] = value;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map((tool) => {
      const definition = tool.function ?? tool;
      return {
        name: definition.name,
        description: definition.description,
        input_schema: definition.parameters ?? definition.input_schema ?? {
          type: "object",
          properties: {}
        }
      };
    }).filter((tool) => tool.name);
  }
  if (request.tool_choice !== undefined) {
    payload.tool_choice = normalizeToolChoice(request.tool_choice);
  }
  if (provider.anthropic_beta) payload["anthropic-beta"] = provider.anthropic_beta;
  return payload;
}

export function anthropicToOpenAI(value) {
  const text = (value.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  const toolCalls = (value.content ?? [])
    .filter((part) => part?.type === "tool_use")
    .map((part) => ({
      id: part.id,
      type: "function",
      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
    }));
  const message = { role: value.role ?? "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: value.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: value.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : value.stop_reason ?? "stop"
    }],
    usage: value.usage
  };
}

export function anthropicToResponses(value) {
  const output = [];
  const text = (value.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  for (const part of value.content ?? []) {
    if (part?.type === "tool_use") {
      output.push({
        type: "function_call",
        id: part.id,
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {})
      });
    }
  }
  return {
    id: value.id,
    object: "response",
    model: value.model,
    status: value.stop_reason === "end_turn" ? "completed" : value.stop_reason,
    output,
    output_text: text,
    usage: value.usage
  };
}

function normalizeAnthropicContent(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "input_text" || part.type === "output_text") {
        return { type: "text", text: part.text ?? "" };
      }
      return part;
    });
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function responsesInputToMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];

  const messages = [];
  const pendingText = [];
  for (const item of input) {
    if (item?.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output ?? ""
        }]
      });
      continue;
    }
    if (item?.role) {
      messages.push({
        role: item.role,
        content: normalizeAnthropicContent(item.content)
      });
      continue;
    }
    if (item?.type === "input_text" || item?.type === "output_text") {
      pendingText.push({ type: "text", text: item.text ?? "" });
    }
  }
  if (pendingText.length) messages.push({ role: "user", content: pendingText });
  return messages;
}

function contentToText(content) {
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  return content == null ? "" : String(content);
}

function normalizeToolChoice(value) {
  if (value === "auto" || value === "any" || value === "none") {
    return value === "none" ? { type: "none" } : { type: value === "any" ? "any" : "auto" };
  }
  if (value?.function?.name) return { type: "tool", name: value.function.name };
  if (value?.name) return { type: "tool", name: value.name };
  return value;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
