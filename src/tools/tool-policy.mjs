import path from "node:path";

const WORKSPACE_TOOLS = new Set(["read_file", "list_files", "search_text"]);
const QODER_PLUGIN_TOOLS = new Set([
  "list_qoder_plugins",
  "list_qoder_plugin_files",
  "read_qoder_plugin_file",
  "search_qoder_plugins"
]);
const DEFAULT_TOOLS = new Set([...WORKSPACE_TOOLS, ...QODER_PLUGIN_TOOLS]);

export function createToolPolicy(options = {}) {
  const roots = (options.workspaceRoots ?? [])
    .map((root) => path.resolve(root))
    .filter(Boolean);
  return {
    workspaceRoots: roots,
    qoderPluginRoots: (options.qoderPluginRoots ?? [])
      .map((root) => path.resolve(root))
      .filter(Boolean),
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
  try { args = parseToolArguments(call.function.arguments); } catch {
    return { ok: false, reason: "tool arguments must be valid JSON" };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "tool arguments must be a JSON object" };
  }
  if (QODER_PLUGIN_TOOLS.has(call.function.name)) {
    return validateQoderPluginTool(policy, call.function.name, args);
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

function validateQoderPluginTool(policy, name, args) {
  if (!policy.qoderPluginRoots.length) {
    return { ok: false, reason: "no Qoder plugin cache root is configured" };
  }
  if (name === "list_qoder_plugins" || name === "search_qoder_plugins") {
    if (args.query !== undefined && typeof args.query !== "string") {
      return { ok: false, reason: "plugin query must be a string" };
    }
    return { ok: true, arguments: args };
  }
  if (typeof args.plugin !== "string" || !args.plugin.trim()) {
    return { ok: false, reason: "plugin name is required" };
  }
  if (name === "read_qoder_plugin_file" && typeof args.path !== "string") {
    return { ok: false, reason: "plugin file path is required" };
  }
  if (args.path !== undefined && typeof args.path !== "string") {
    return { ok: false, reason: "plugin file path must be a string" };
  }
  if (args.path !== undefined && !isSafeRelativePath(args.path)) {
    return { ok: false, reason: "plugin file path must stay inside the plugin directory" };
  }
  return { ok: true, arguments: args };
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
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

function isSafeRelativePath(value) {
  const requested = String(value || ".");
  if (requested.includes("\0") || path.isAbsolute(requested)) return false;
  return !requested.split(/[\\/]+/).some((part) => part === "..");
}
