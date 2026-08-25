import { createToolPolicy } from "../src/tools/tool-policy.mjs";
import { executeToolCall } from "../src/tools/tool-runtime.mjs";

export function createBridgeToolRuntime(options = {}) {
  const policy = createToolPolicy({
    workspaceRoots: options.workspaceRoots ?? [],
    allowedTools: options.allowedTools,
    executionMode: options.executionMode ?? "dry-run"
  });
  return {
    policy,
    execute(call, context) {
      return executeToolCall(policy, call, context);
    }
  };
}
