export function parseSimulatedToolCalls(text, tools = []) {
  const allowlisted = new Set(tools.map((tool) => (tool.function ?? tool)?.name).filter(Boolean));
  if (!allowlisted.size || typeof text !== "string") return [];

  const matches = [
    ...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi),
    ...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)
  ];
  const calls = [];
  for (const match of matches) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    const name = value?.name ?? value?.tool;
    const argumentsValue = value?.arguments ?? value?.input;
    if (typeof name !== "string" || !allowlisted.has(name)) continue;
    if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) continue;
    calls.push({
      id: `simulated-${calls.length + 1}`,
      type: "function",
      function: { name, arguments: JSON.stringify(argumentsValue) },
      raw: match[0],
      simulated: true
    });
  }
  return calls;
}

export function normalizeToolCall(call) {
  if (!call || typeof call !== "object") return null;
  const functionValue = call.function ?? call;
  const name = functionValue.name ?? call.name;
  if (typeof name !== "string" || !name) return null;
  const args = functionValue.arguments ?? call.arguments ?? call.input ?? {};
  return {
    id: call.id ?? call.call_id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args)
    }
  };
}

