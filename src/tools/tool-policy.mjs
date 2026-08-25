import path from "node:path";

const DEFAULT_TOOLS = new Set(["read_file", "list_files", "search_text"]);

export function createToolPolicy(options = {}) {
  const roots = (options.workspaceRoots ?? [])
    .map((root) => path.resolve(root))
    .filter(Boolean);
  return {
    workspaceRoots: roots,
    allowedTools: new Set(options.allowedTools ?? DEFAULT_TOOLS),
    executionMode: options.executionMode ?? "dry-run",
    maxReadBytes: options.maxReadBytes ?? 512 * 1024,
    maxResults: options.maxResults ?? 100
  };
}

export function validateToolCall(policy, call) {
  if (!call?.function?.name) {
    return { ok: false, reason: "tool name is missing" };
  }
  if (!policy.allowedTools.has(call.function.name)) {
    return { ok: false, reason: `tool ${call.function.name} is not allowlisted` };
  }
  let args;
  try { args = JSON.parse(call.function.arguments ?? "{}"); } catch {
    return { ok: false, reason: "tool arguments must be valid JSON" };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "tool arguments must be a JSON object" };
  }
  if (call.function.name !== "list_files" && typeof args.path !== "string") {
    return { ok: false, reason: "tool path is required" };
  }
  if (!policy.workspaceRoots.length) {
    return { ok: false, reason: "no workspace root is configured" };
  }
  if (args.path && !isPathAllowed(policy, args.path)) {
    return { ok: false, reason: "tool path is outside the allowed workspace" };
  }
  return { ok: true, arguments: args };
}

export function resolveWorkspacePath(policy, requestedPath = ".") {
  const requested = String(requestedPath);
  const candidates = path.isAbsolute(requested)
    ? policy.workspaceRoots.map((root) => ({ root, candidate: path.resolve(requested) }))
    : policy.workspaceRoots.map((root) => ({
      root,
      candidate: path.resolve(root, requested)
    }));
  const match = candidates.find(({ root, candidate }) => isWithin(root, candidate));
  if (!match) return null;
  return { root: match.root, path: match.candidate };
}

function isPathAllowed(policy, requestedPath) {
  return Boolean(resolveWorkspacePath(policy, requestedPath));
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
