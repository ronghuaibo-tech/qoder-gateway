import { cloneWithModel, modelFor, normalizeRequest, parameter } from "../core/request.mjs";

export function fromOpenAIChat(body, context) {
  return normalizeRequest("openai-chat", body, context);
}

export function toOpenAIChat(request) {
  const source = request.metadata?.source_facade;
  const messages = request.messages?.length
    ? request.messages
    : responsesInputToMessages(request.input);
  const payload = {
    model: modelFor(request),
    messages,
    stream: request.stream === true
  };
  copyParameters(payload, request);
  if (request.tools?.length) payload.tools = request.tools;
  if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
  if (request.reasoning !== undefined) {
    payload.reasoning_effort = typeof request.reasoning === "string"
      ? request.reasoning
      : request.reasoning.effort ?? request.reasoning;
  }
  if (source === "openai-chat") return { ...payload, ...passthrough(request) };
  return payload;
}

export function openAIChatToResponsesBody(body, model) {
  const request = body?.metadata?.source_facade
    ? cloneWithModel(body, model)
    : cloneWithModel(fromOpenAIChat(body), model);
  return {
    model,
    input: messagesToResponsesInput(request.messages),
    stream: request.stream,
    tools: request.tools,
    tool_choice: request.tool_choice,
    max_output_tokens: request.maxTokens,
    temperature: request.temperature,
    top_p: request.topP,
    reasoning: request.reasoning
  };
}

export function fromOpenAIChatResponse(value) {
  return value;
}

export function toOpenAIChatResponse(value) {
  return value;
}

function copyParameters(payload, request) {
  for (const key of [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "context_length",
    "max_input_tokens",
    "stop",
    "response_format",
    "parallel_tool_calls",
    "user"
  ]) {
    const value = parameter(request, key);
    if (value !== undefined) payload[key] = value;
  }
}

function passthrough(request) {
  const values = request.metadata?.parameters;
  return values && typeof values === "object" ? values : {};
}

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (item && typeof item === "object" && item.type === "message") {
      return { role: item.role, content: item.content };
    }
    if (item && typeof item === "object" && item.type === "function_call_output") {
      return {
        role: "tool",
        tool_call_id: item.call_id ?? item.id,
        content: item.output ?? ""
      };
    }
    return { role: "user", content: item };
  });
}

function messagesToResponsesInput(messages = []) {
  return messages.flatMap((message) => {
    if (message.role === "tool") {
      return [{
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content
      }];
    }
    return [{
      role: message.role,
      content: typeof message.content === "string"
        ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }]
        : message.content
    }];
  });
}
