import fs from "node:fs/promises";
import path from "node:path";
import { validateToolCall, resolveWorkspacePath } from "./tool-policy.mjs";

export async function executeToolCall(policy, call, { requestId } = {}) {
  const validation = validateToolCall(policy, call);
  if (!validation.ok) return toolResult(call, validation.reason, requestId, false);
  if (policy.executionMode === "dry-run") {
    return toolResult(call, {
      dry_run: true,
      tool: call.function.name,
      arguments: validation.arguments
    }, requestId, true);
  }

  try {
    const result = await executeAllowlisted(policy, call.function.name, validation.arguments);
    return toolResult(call, result, requestId, true);
  } catch (error) {
    return toolResult(call, error.message, requestId, false);
  }
}

async function executeAllowlisted(policy, name, args) {
  if (name === "read_file") {
    const resolved = await resolveRealWorkspacePath(policy, args.path);
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) throw new Error("path is not a file");
    if (stat.size > policy.maxReadBytes) throw new Error("file exceeds the read limit");
    return {
      path: path.relative(resolved.root, resolved.path),
      content: await fs.readFile(resolved.path, "utf8")
    };
  }
  if (name === "list_files") {
    const requestedPath = args.path ?? ".";
    const resolved = await resolveRealWorkspacePath(policy, requestedPath);
    const entries = await fs.readdir(resolved.path, { withFileTypes: true });
    return {
      path: path.relative(resolved.root, resolved.path) || ".",
      entries: entries.slice(0, policy.maxResults).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file"
      }))
    };
  }
  if (name === "search_text") {
    const resolved = await resolveRealWorkspacePath(policy, args.path);
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) throw new Error("search_text currently requires a file path");
    if (stat.size > policy.maxReadBytes) throw new Error("file exceeds the search limit");
    const text = await fs.readFile(resolved.path, "utf8");
    const query = String(args.query ?? "");
    return {
      path: path.relative(resolved.root, resolved.path),
      matches: text.split(/\r?\n/)
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter((item) => item.text.includes(query))
        .slice(0, policy.maxResults)
    };
  }
  throw new Error(`tool ${name} is not implemented`);
}

async function resolveRealWorkspacePath(policy, requestedPath) {
  const lexical = resolveWorkspacePath(policy, requestedPath);
  if (!lexical) throw new Error("tool path is outside the allowed workspace");
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(lexical.root),
    fs.realpath(lexical.path)
  ]);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("tool path resolves outside the allowed workspace");
  }
  return { root: realRoot, path: realPath };
}

function toolResult(call, content, requestId, ok) {
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  return {
    id: call?.id,
    type: "tool_result",
    tool_use_id: call?.id,
    ok,
    request_id: requestId,
    content: serialized
  };
}
