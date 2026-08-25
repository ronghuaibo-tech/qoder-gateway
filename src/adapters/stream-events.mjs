export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) {
        if (data.length) {
          yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    if (buffer.startsWith("event:")) event = buffer.slice(6).trim();
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  }
  if (data.length) yield { event, data: data.join("\n") };
}

export async function* unifiedEvents(body, sourceProtocol) {
  for await (const event of parseSse(body)) {
    if (event.data === "[DONE]") {
      yield { type: "message_done", data: {}, raw: event };
      continue;
    }
    let value;
    try { value = JSON.parse(event.data); } catch {
      yield { type: "text_delta", data: { text: event.data }, raw: event };
      continue;
    }
    const normalized = normalizeEvent(value, event.event, sourceProtocol);
    if (normalized) yield { ...normalized, raw: event };
  }
}

export function normalizeEvent(value, eventName = "message", sourceProtocol = "openai") {
  if (sourceProtocol === "openai-response") {
    if (eventName.includes("response.created") || value.type === "response.created") {
      return { type: "message_start", data: { id: value.response?.id ?? value.id } };
    }
    if (eventName.includes("output_text.delta") || value.type === "response.output_text.delta") {
      return { type: "text_delta", data: { text: value.delta ?? value.text ?? "" } };
    }
    if (eventName.includes("reasoning") || value.type?.includes("reasoning")) {
      return { type: "reasoning_delta", data: { text: value.delta ?? value.text ?? "" } };
    }
    if (value.type === "response.output_item.added" && value.item?.type === "function_call") {
      return {
        type: "tool_call",
        data: { id: value.item.call_id ?? value.item.id, name: value.item.name, arguments: "" }
      };
    }
    if (value.type === "response.function_call_arguments.delta") {
      return {
        type: "tool_call",
        data: { id: value.item_id ?? value.call_id, arguments: value.delta ?? "" }
      };
    }
    if (value.type === "response.completed" || eventName.includes("completed")) {
      return { type: "message_done", data: { response: value.response, usage: value.usage } };
    }
    if (value.type === "response.failed" || eventName.includes("failed")) {
      return { type: "error", data: { message: value.error?.message ?? "upstream response failed" } };
    }
  }

  if (sourceProtocol === "anthropic") {
    if (eventName === "message_start" || value.type === "message_start") {
      return { type: "message_start", data: value.message ?? value };
    }
    if (eventName === "content_block_start" || value.type === "content_block_start") {
      if (value.content_block?.type === "tool_use") {
        return {
          type: "tool_call",
          data: { id: value.content_block.id, name: value.content_block.name, arguments: "" }
        };
      }
    }
    if (eventName === "content_block_delta" || value.type === "content_block_delta") {
      if (value.delta?.type === "text_delta") {
        return { type: "text_delta", data: { text: value.delta.text ?? "" } };
      }
      if (value.delta?.type === "thinking_delta") {
        return { type: "reasoning_delta", data: { text: value.delta.thinking ?? "" } };
      }
      if (value.delta?.type === "input_json_delta") {
        return {
          type: "tool_call",
          data: { id: value.index, index: value.index, arguments: value.delta.partial_json ?? "" }
        };
      }
    }
    if (eventName === "message_delta" || value.type === "message_delta") {
      return { type: "usage", data: { usage: value.usage, delta: value.delta } };
    }
    if (eventName === "message_stop" || value.type === "message_stop") {
      return { type: "message_done", data: {} };
    }
  }

  if (sourceProtocol === "gemini") {
    const parts = value.candidates?.[0]?.content?.parts ?? [];
    const text = parts.find((part) => typeof part.text === "string");
    if (text) return { type: "text_delta", data: { text: text.text } };
    const functionCall = parts.find((part) => part.functionCall);
    if (functionCall) {
      return {
        type: "tool_call",
        data: {
          name: functionCall.functionCall.name,
          arguments: JSON.stringify(functionCall.functionCall.args ?? {})
        }
      };
    }
    if (value.usageMetadata) return { type: "usage", data: { usage: value.usageMetadata } };
    if (value.candidates?.[0]?.finishReason) {
      return { type: "message_done", data: { finish_reason: value.candidates[0].finishReason } };
    }
  }

  const choice = value.choices?.[0];
  const delta = choice?.delta;
  if (delta?.content) return { type: "text_delta", data: { text: delta.content } };
  if (delta?.reasoning_content || delta?.reasoning) {
    return { type: "reasoning_delta", data: { text: delta.reasoning_content ?? delta.reasoning } };
  }
  if (delta?.tool_calls?.length) {
    const tool = delta.tool_calls[0];
    return {
      type: "tool_call",
      data: {
        id: tool.id ?? tool.index,
        name: tool.function?.name,
        arguments: tool.function?.arguments ?? ""
      }
    };
  }
  if (value.usage) return { type: "usage", data: { usage: value.usage } };
  if (choice?.finish_reason || eventName === "done") {
    return { type: "message_done", data: { finish_reason: choice?.finish_reason } };
  }
  return null;
}

export async function writeConvertedSse(res, body, sourceProtocol, targetFacade, request = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const id = `bridge-${Date.now()}`;
  const model = request.upstreamModel ?? request.model ?? request.modelAlias ?? undefined;
  let emittedText = "";
  let done = false;
  const state = {
    toolIndices: new Map(),
    nextToolIndex: 0,
    usage: undefined
  };
  if (targetFacade === "openai-responses") {
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: {
        id,
        object: "response",
        model,
        status: "in_progress",
        output: []
      }
    })}\n\n`);
  }
  if (targetFacade === "anthropic") {
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id, type: "message", role: "assistant", content: [] }
    })}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    })}\n\n`);
  }
  for await (const event of unifiedEvents(body, sourceProtocol)) {
    if (event.type === "text_delta") {
      emittedText += event.data.text ?? "";
      writeFacadeEvent(res, targetFacade, event, id, state);
    } else if (event.type === "reasoning_delta" || event.type === "tool_call" || event.type === "usage") {
      if (event.type === "usage") state.usage = event.data.usage;
      writeFacadeEvent(res, targetFacade, event, id, state);
    } else if (event.type === "message_done" && !done) {
      writeFacadeDone(res, targetFacade, id, emittedText, state);
      done = true;
    }
  }
  if (!done) {
    throw new Error("upstream SSE ended before completion event");
  }
  res.end();
}

function writeFacadeEvent(res, facade, event, id, state) {
  let name = "message";
  let data;
  if (event.type === "usage") {
    if (facade === "openai-chat") {
      data = { id, object: "chat.completion.chunk", choices: [], usage: event.data.usage };
    } else if (facade === "openai-responses") {
      name = "response.usage";
      data = { type: name, response_id: id, usage: event.data.usage };
    } else {
      name = "message_delta";
      data = { type: name, usage: event.data.usage };
    }
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    return;
  }
  if (facade === "openai-chat") {
    let delta;
    if (event.type === "text_delta") delta = { content: event.data.text };
    else if (event.type === "reasoning_delta") delta = { reasoning_content: event.data.text };
    else {
      const key = String(event.data.index ?? event.data.id ?? state.nextToolIndex);
      if (!state.toolIndices.has(key)) state.toolIndices.set(key, state.nextToolIndex++);
      delta = { tool_calls: [{ index: state.toolIndices.get(key), id: event.data.id, type: "function", function: {
        name: event.data.name,
        arguments: event.data.arguments ?? ""
      } }] };
    }
    data = { id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] };
  } else if (facade === "openai-responses") {
    if (event.type === "text_delta") {
      name = "response.output_text.delta";
      data = { type: name, response_id: id, delta: event.data.text ?? "" };
    } else if (event.type === "reasoning_delta") {
      name = "response.reasoning_summary_text.delta";
      data = { type: name, response_id: id, delta: event.data.text ?? "" };
    } else {
      const key = String(event.data.index ?? event.data.id ?? state.nextToolIndex);
      if (!state.toolIndices.has(key)) state.toolIndices.set(key, state.nextToolIndex++);
      if (event.data.name) {
        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          response_id: id,
          output_index: state.toolIndices.get(key),
          item: { type: "function_call", id: event.data.id, call_id: event.data.id, name: event.data.name, arguments: "" }
        })}\n\n`);
      }
      name = "response.function_call_arguments.delta";
      data = {
        type: name,
        response_id: id,
        delta: event.data.arguments ?? "",
        item_id: event.data.id
      };
    }
  } else {
    if (event.type === "reasoning_delta") {
      name = "content_block_delta";
      data = { type: name, index: 0, delta: { type: "thinking_delta", thinking: event.data.text } };
    } else if (event.type === "tool_call") {
      const key = String(event.data.index ?? event.data.id ?? state.nextToolIndex);
      if (!state.toolIndices.has(key)) state.toolIndices.set(key, state.nextToolIndex++);
      const index = state.toolIndices.get(key);
      if (event.data.name) {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: event.data.id, name: event.data.name, input: {} }
        })}\n\n`);
      }
      name = "content_block_delta";
      data = { type: name, index, delta: { type: "input_json_delta", partial_json: event.data.arguments ?? "" } };
    } else {
      name = "content_block_delta";
      data = { type: name, index: 0, delta: { type: "text_delta", text: event.data.text } };
    }
  }
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeFacadeDone(res, facade, id, text, state) {
  if (facade === "openai-chat") {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: state.usage
    })}\n\n`);
    res.write("data: [DONE]\n\n");
  } else if (facade === "openai-responses") {
    res.write(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        }],
        output_text: text,
        usage: state.usage
      }
    })}\n\n`);
    res.write("data: [DONE]\n\n");
  } else {
    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: state.usage
    })}\n\n`);
    res.write("event: message_stop\ndata: {}\n\n");
  }
}
