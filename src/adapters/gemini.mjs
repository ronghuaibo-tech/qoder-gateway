import { parameter, userMetadata } from "../core/request.mjs";

export function toGemini(request) {
  const contents = [];
  const messages = request.messages?.length ? request.messages : responsesInputToMessages(request.input);
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = contentToGeminiParts(message.content);
    if (parts.length) contents.push({ role, parts });
  }

  const payload = {
    contents,
    generationConfig: compact({
      temperature: request.temperature ?? parameter(request, "temperature"),
      topP: request.topP ?? parameter(request, "top_p"),
      maxOutputTokens: request.maxTokens ?? parameter(request, "max_output_tokens"),
      stopSequences: parameter(request, "stop")
    })
  };
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (request.tools?.length) {
    payload.tools = [{
      functionDeclarations: request.tools.map((tool) => {
        const definition = tool.function ?? tool;
        return {
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters ?? definition.input_schema ?? { type: "object", properties: {} }
        };
      }).filter((tool) => tool.name)
    }];
  }
  if (request.tool_choice !== undefined) {
    payload.toolConfig = { functionCallingConfig: { mode: geminiToolMode(request.tool_choice) } };
  }
  const metadata = userMetadata(request);
  if (Object.keys(metadata).length) payload.metadata = metadata;
  return payload;
}

export function geminiToOpenAIChat(value) {
  const candidate = value.candidates?.[0] ?? {};
  const parts = candidate.content?.parts ?? [];
  const text = parts.filter((part) => typeof part.text === "string").map((part) => part.text).join("");
  const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
    id: `gemini-call-${index}`,
    type: "function",
    function: {
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {})
    }
  }));
  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: value.responseId ?? `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: value.modelVersion,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : finishReason(candidate.finishReason)
    }],
    usage: value.usageMetadata ? {
      prompt_tokens: value.usageMetadata.promptTokenCount,
      completion_tokens: value.usageMetadata.candidatesTokenCount,
      total_tokens: value.usageMetadata.totalTokenCount
    } : undefined
  };
}

export function geminiToResponses(value) {
  const chat = geminiToOpenAIChat(value);
  const message = chat.choices[0].message;
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] }];
  for (const call of message.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments
    });
  }
  return {
    id: chat.id,
    object: "response",
    model: chat.model,
    status: "completed",
    output,
    output_text: message.content,
    usage: chat.usage
  };
}

export function geminiUrl(provider, model, stream = false) {
  const template = provider.path_template ?? "models/{model}:generateContent";
  const path = template.replace("{model}", encodeURIComponent(model));
  const suffix = stream ? "?alt=sse" : "";
  return new URL(`${path}${suffix}`, ensureTrailingSlash(provider.base_url)).toString();
}

function contentToGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return content?.text ? [{ text: content.text }] : [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ text: part }];
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      return [{ text: part.text ?? "" }];
    }
    if (part.type === "image_url") return [{ inlineData: { mimeType: "image/*", data: part.image_url?.url ?? part.image_url } }];
    if (part.type === "image" && part.source) {
      return [{ inlineData: { mimeType: part.source.media_type ?? "image/*", data: part.source.data } }];
    }
    if (part.type === "function_call_output" || part.type === "tool_result") {
      return [{ functionResponse: { name: part.name ?? part.tool_use_id, response: part.output ?? part.content } }];
    }
    return [];
  });
}

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) ? input.map((item) => item.type === "message"
    ? { role: item.role, content: item.content }
    : { role: "user", content: item }) : [];
}

function contentToText(content) {
  return Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("")
    : String(content ?? "");
}

function geminiToolMode(choice) {
  if (choice === "none" || choice?.type === "none") return "NONE";
  if (choice === "required" || choice === "any" || choice?.type === "any") return "ANY";
  return "AUTO";
}

function finishReason(value) {
  if (value === "STOP") return "stop";
  if (value === "MAX_TOKENS") return "length";
  if (value === "SAFETY") return "content_filter";
  return value?.toLowerCase?.() ?? "stop";
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
