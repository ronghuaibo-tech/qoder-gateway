import { modelFor, normalizeRequest, parameter } from "../core/request.mjs";

export function fromOpenAIResponses(body, context) {
  return normalizeRequest("openai-responses", body, context);
}

export function toOpenAIResponses(request) {
  const payload = {
    model: modelFor(request),
    input: request.input ?? messagesToInput(request.messages),
    stream: request.stream === true
  };
  for (const key of ["temperature", "top_p", "max_output_tokens", "context_length", "max_input_tokens", "stop", "parallel_tool_calls", "store", "include", "truncation", "user"]) {
    const value = parameter(request, key);
    if (value !== undefined) payload[key] = value;
  }
  if (request.tools?.length) payload.tools = request.tools;
  if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
  if (request.reasoning !== undefined) payload.reasoning = request.reasoning;
  const responseFormat = parameter(request, "response_format");
  if (responseFormat !== undefined) payload.text = { format: responseFormat };
  return payload;
}

export function responsesToOpenAIChat(value) {
  const text = extractResponseText(value);
  const toolCalls = extractResponseToolCalls(value);
  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: value.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: value.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : value.status === "completed" ? "stop" : value.status
    }],
    usage: value.usage
  };
}

export function responsesToAnthropic(value) {
  const content = [];
  const text = extractResponseText(value);
  if (text) content.push({ type: "text", text });
  for (const toolCall of extractResponseToolCalls(value)) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseArguments(toolCall.function.arguments)
    });
  }
  return {
    id: value.id,
    type: "message",
    role: "assistant",
    model: value.model,
    content,
    stop_reason: content.some((item) => item.type === "tool_use")
      ? "tool_use"
      : value.status === "completed" ? "end_turn" : value.status,
    usage: value.usage
  };
}

export function extractResponseText(value) {
  if (typeof value.output_text === "string") return value.output_text;
  return (value.output ?? [])
    .flatMap((item) => item?.content ?? [])
    .filter((part) => part?.type === "output_text" || part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export function extractResponseToolCalls(value) {
  return (value.output ?? [])
    .filter((item) => item?.type === "function_call" || item?.type === "tool_call")
    .map((item, index) => ({
      id: item.call_id ?? item.id ?? `call_${index}`,
      type: "function",
      function: {
        name: item.name ?? item.function?.name,
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? item.function?.arguments ?? {})
      }
    }))
    .filter((item) => item.function.name);
}

function messagesToInput(messages = []) {
  return messages.flatMap((message) => {
    if (message.role === "tool") {
      return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
    }
    return [{
      role: message.role,
      content: typeof message.content === "string"
        ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }]
        : message.content
    }];
  });
}

function parseArguments(value) {
  try { return JSON.parse(value); } catch { return {}; }
}
