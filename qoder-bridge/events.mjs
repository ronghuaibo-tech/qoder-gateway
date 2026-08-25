import { parseSse } from "../src/adapters/stream-events.mjs";
import { createAcpProgress, createAcpPromptResult } from "./acp.mjs";

export async function* bridgeEvents(body) {
  for await (const event of parseSse(body)) {
    if (event.data === "[DONE]") {
      yield { type: "done", data: {} };
      continue;
    }
    let value;
    try {
      value = JSON.parse(event.data);
    } catch {
      yield { type: "text_delta", data: { text: event.data } };
      continue;
    }
    yield toBridgeEvent(value, event.event);
  }
}

export function toBridgeEvent(value, eventName = "message") {
  if (value?.method === "session/update" && value.params?.update) {
    return toBridgeEvent({
      ...value.params.update,
      sessionId: value.params.sessionId,
      metadata: value.params._meta
    }, "session/update");
  }

  const type = value?.sessionUpdate ?? value?.type ?? eventName;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    return {
      type: type === "agent_thought_chunk" ? "reasoning_delta" : "text_delta",
      data: {
        text: contentText(value.content),
        session_id: value.sessionId,
        request_id: value.metadata?.["ai-coding/request-id"]
      }
    };
  }
  if (type === "notification" && value.type === "chat_finish") {
    return {
      type: "done",
      data: {
        session_id: value.sessionId,
        request_id: value.metadata?.["ai-coding/request-id"],
        reason: value.data?.reason,
        status_code: value.data?.statusCode
      }
    };
  }
  if (type === "notification") {
    return {
      type: "upstream_event",
      data: {
        event: "qoder.notification",
        notification_type: value.type,
        session_id: value.sessionId
      }
    };
  }
  if (type === "tool_call" || type === "tool_call_update") {
    return {
      type,
      data: {
        id: value.toolCallId,
        name: value.title ?? value.toolName,
        status: value.status,
        arguments: value.rawInput,
        output: value.rawOutput ?? value.content
      }
    };
  }
  if (type === "response.output_text.delta" || type === "response.reasoning_summary_text.delta") {
    return {
      type: type.includes("reasoning") ? "reasoning_delta" : "text_delta",
      data: { text: value.delta ?? "" }
    };
  }
  if (type === "response.output_item.added" && value.item?.type === "function_call") {
    return {
      type: "tool_call",
      data: {
        id: value.item.call_id ?? value.item.id,
        name: value.item.name
      }
    };
  }
  if (type === "response.function_call_arguments.delta") {
    return {
      type: "tool_call",
      data: { id: value.item_id, arguments: value.delta ?? "" }
    };
  }
  if (type === "response.completed") return { type: "done", data: value.response ?? value };
  if (type === "response.failed") {
    return { type: "error", data: { message: value.error?.message ?? "response failed" } };
  }
  if (type === "response.usage") return { type: "usage", data: value.usage };
  return { type: "upstream_event", data: { event: type } };
}

function contentText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" || part?.type === "input_text")
      .map((part) => part.text ?? "")
      .join("");
  }
  if (content?.type === "text" || content?.type === "input_text") {
    return content.text ?? "";
  }
  return "";
}

export function toAcpProgress(event, {
  sessionId,
  requestId,
  metadata
} = {}) {
  if (event.type === "text_delta") {
    return createAcpProgress(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: event.data.text ?? "" }
    }, { requestId, metadata });
  }
  if (event.type === "reasoning_delta") {
    return createAcpProgress(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: event.data.text ?? "" }
    }, { requestId, metadata });
  }
  if (event.type === "tool_call") {
    return createAcpProgress(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: event.data.id,
      title: event.data.name,
      kind: "other",
      status: event.data.status ?? "in_progress",
      rawInput: event.data.arguments
    }, { requestId, metadata });
  }
  if (event.type === "tool_call_update") {
    return createAcpProgress(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.data.id,
      status: event.data.status ?? "completed",
      rawOutput: event.data.output ?? [],
      content: event.data.output ?? []
    }, { requestId, metadata });
  }
  if (event.type === "done") {
    return createAcpPromptResult(sessionId, "completed", {
      requestId,
      metadata,
      result: event.data
    });
  }
  return createAcpProgress(sessionId, {
    sessionUpdate: "notification",
    type: event.type,
    data: event.data
  }, { requestId, metadata });
}
