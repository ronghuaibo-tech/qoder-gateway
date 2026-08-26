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
    const visibleEntries = entries.slice(0, policy.maxResults);
    return {
      path: path.relative(resolved.root, resolved.path) || ".",
      total: entries.length,
      truncated: entries.length > visibleEntries.length,
      entries: visibleEntries.map((entry) => ({
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
    const allMatches = text.split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter((item) => item.text.includes(query));
    return {
      path: path.relative(resolved.root, resolved.path),
      total: allMatches.length,
      truncated: allMatches.length > policy.maxResults,
      matches: allMatches.slice(0, policy.maxResults)
    };
  }
  if (name === "list_qoder_plugins") {
    const plugins = await discoverQoderPlugins(policy);
    const query = normalizeSearch(args.query);
    const filtered = query
      ? plugins.filter((plugin) => pluginMatches(plugin, query))
      : plugins;
    return {
      total: filtered.length,
      truncated: filtered.length > policy.maxResults,
      plugins: filtered.slice(0, policy.maxResults).map(publicPluginInfo)
    };
  }
  if (name === "list_qoder_plugin_files") {
    const plugin = await resolveQoderPlugin(policy, args.plugin);
    const relativeDir = normalizeRelativePath(args.path ?? ".");
    const resolved = await resolveRealPluginPath(plugin, relativeDir);
    const stat = await fs.stat(resolved.path);
    if (!stat.isDirectory()) throw new Error("plugin path is not a directory");
    const entries = await fs.readdir(resolved.path, { withFileTypes: true });
    const visibleEntries = entries.slice(0, policy.maxResults);
    return {
      plugin: plugin.id,
      path: path.relative(plugin.root, resolved.path) || ".",
      total: entries.length,
      truncated: entries.length > visibleEntries.length,
      entries: visibleEntries.map((entry) => ({
        name: entry.name,
        path: path.posix.join(toPosix(path.relative(plugin.root, resolved.path)), entry.name).replace(/^\.\//, ""),
        type: entry.isDirectory() ? "directory" : "file"
      }))
    };
  }
  if (name === "read_qoder_plugin_file") {
    const plugin = await resolveQoderPlugin(policy, args.plugin);
    const relativeFile = normalizeRelativePath(args.path);
    const resolved = await resolveRealPluginPath(plugin, relativeFile);
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) throw new Error("plugin path is not a file");
    if (stat.size > policy.maxReadBytes) throw new Error("plugin file exceeds the read limit");
    return {
      plugin: plugin.id,
      path: path.relative(plugin.root, resolved.path),
      content: await fs.readFile(resolved.path, "utf8")
    };
  }
  if (name === "search_qoder_plugins") {
    const plugins = await discoverQoderPlugins(policy);
    const query = normalizeSearch(args.query);
    if (!query) throw new Error("plugin query is required");
    const matches = [];
    for (const plugin of plugins) {
      const files = await listPluginTextFiles(plugin, policy.maxResults);
      for (const file of files) {
        if (matches.length >= policy.maxResults) break;
        const content = await fs.readFile(file.path, "utf8").catch(() => "");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < policy.maxResults; index += 1) {
          if (lines[index].toLowerCase().includes(query)) {
            matches.push({
              plugin: plugin.id,
              path: path.relative(plugin.root, file.path),
              line: index + 1,
              text: lines[index].slice(0, 500)
            });
          }
        }
      }
    }
    return {
      query: args.query,
      total: matches.length,
      truncated: matches.length >= policy.maxResults,
      matches
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

async function discoverQoderPlugins(policy) {
  const plugins = [];
  const seen = new Set();
  for (const cacheRoot of policy.qoderPluginRoots ?? []) {
    const realCacheRoot = await fs.realpath(cacheRoot).catch(() => null);
    if (!realCacheRoot) continue;
    const sourceEntries = await fs.readdir(realCacheRoot, { withFileTypes: true }).catch(() => []);
    for (const sourceEntry of sourceEntries.filter((entry) => entry.isDirectory())) {
      const sourceRoot = path.join(realCacheRoot, sourceEntry.name);
      const pluginEntries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
      for (const pluginEntry of pluginEntries.filter((entry) => entry.isDirectory())) {
        const directRoot = path.join(sourceRoot, pluginEntry.name);
        const direct = await pluginCandidate(realCacheRoot, sourceEntry.name, pluginEntry.name, "", directRoot);
        if (direct) {
          addPlugin(plugins, seen, direct);
          continue;
        }
        const versionEntries = await fs.readdir(directRoot, { withFileTypes: true }).catch(() => []);
        for (const versionEntry of versionEntries.filter((entry) => entry.isDirectory())) {
          const versionRoot = path.join(directRoot, versionEntry.name);
          const versioned = await pluginCandidate(
            realCacheRoot,
            sourceEntry.name,
            pluginEntry.name,
            versionEntry.name,
            versionRoot
          );
          if (versioned) addPlugin(plugins, seen, versioned);
        }
      }
    }
  }
  return plugins.sort((left, right) => left.id.localeCompare(right.id));
}

function addPlugin(plugins, seen, plugin) {
  const key = plugin.root;
  if (seen.has(key)) return;
  seen.add(key);
  plugins.push(plugin);
}

async function pluginCandidate(cacheRoot, source, id, version, root) {
  const manifestPath = path.join(root, ".qoder-plugin", "plugin.json");
  const manifest = await readJsonFile(manifestPath);
  const rootSkill = await fileExists(path.join(root, "SKILL.md"));
  const skillsDir = await directoryExists(path.join(root, "skills"));
  const commandsDir = await directoryExists(path.join(root, "commands"));
  const agentsDir = await directoryExists(path.join(root, "agents"));
  const mcpDir = await directoryExists(path.join(root, "mcp"));
  const nestedSkillDirs = await findNestedSkillDirs(root, 2);
  if (!manifest && !rootSkill && !skillsDir && !commandsDir && !agentsDir && !mcpDir) {
    return null;
  }
  return {
    id: String(manifest?.name || id),
    version: String(manifest?.version || version || ""),
    description: String(manifest?.description || ""),
    source,
    root,
    cache_root: cacheRoot,
    manifest_path: manifest ? path.relative(root, manifestPath) : "",
    capabilities: {
      skills: rootSkill || skillsDir || nestedSkillDirs.length > 0,
      mcp: mcpDir || hasManifestArray(manifest, "mcp") || hasManifestArray(manifest, "mcpServers"),
      agents: agentsDir || hasManifestArray(manifest, "agents"),
      commands: commandsDir || hasManifestArray(manifest, "commands")
    },
    skill_paths: [...new Set([
      ...(rootSkill ? ["SKILL.md"] : []),
      ...(skillsDir ? await listImmediateSkillPaths(path.join(root, "skills"), root) : []),
      ...nestedSkillDirs.map((item) => path.relative(root, item))
    ])].sort()
  };
}

async function resolveQoderPlugin(policy, pluginName) {
  const requested = String(pluginName || "").trim().toLowerCase();
  const plugins = await discoverQoderPlugins(policy);
  const match = plugins.find((plugin) => plugin.id.toLowerCase() === requested)
    || plugins.find((plugin) => plugin.id.toLowerCase().includes(requested));
  if (!match) throw new Error(`Qoder plugin ${pluginName} was not found`);
  return match;
}

async function resolveRealPluginPath(plugin, requestedPath) {
  const relative = normalizeRelativePath(requestedPath);
  let lexical = path.resolve(plugin.root, relative);
  if (!isWithin(plugin.root, lexical)) throw new Error("plugin file path is outside the plugin directory");
  if (isSimpleFileName(relative) && !await pathExists(lexical)) {
    const files = await listPluginTextFiles(plugin, 500);
    const basenameMatches = files.filter((file) => path.basename(file.path) === relative);
    if (basenameMatches.length === 1) {
      lexical = basenameMatches[0].path;
    }
  }
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(plugin.root),
    fs.realpath(lexical)
  ]);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("plugin file path resolves outside the plugin directory");
  }
  return { root: realRoot, path: realPath };
}

async function listPluginTextFiles(plugin, maxFiles) {
  const results = [];
  async function walk(directory, depth) {
    if (depth > 4 || results.length >= maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".qoder-plugin") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile() && /\.(?:md|txt|json|ya?ml)$/i.test(entry.name)) {
        results.push({ path: entryPath });
      }
    }
  }
  await walk(plugin.root, 0);
  return results;
}

async function listImmediateSkillPaths(skillsRoot, pluginRoot) {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    if (await fileExists(skillFile)) paths.push(path.relative(pluginRoot, skillFile));
  }
  return paths;
}

async function findNestedSkillDirs(root, maxDepth) {
  const results = [];
  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    if (directory !== root && await fileExists(path.join(directory, "SKILL.md"))) {
      results.push(path.join(directory, "SKILL.md"));
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return results;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasManifestArray(manifest, key) {
  return Array.isArray(manifest?.[key]) && manifest[key].length > 0;
}

async function fileExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function pathExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat);
}

async function directoryExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

function publicPluginInfo(plugin) {
  return {
    id: plugin.id,
    version: plugin.version,
    source: plugin.source,
    description: plugin.description,
    capabilities: plugin.capabilities,
    manifest_path: plugin.manifest_path,
    skill_paths: plugin.skill_paths
  };
}

function pluginMatches(plugin, query) {
  return [
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.description,
    ...plugin.skill_paths
  ].some((value) => String(value || "").toLowerCase().includes(query));
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRelativePath(value) {
  const normalized = path.normalize(String(value || ".")).replace(/^(\.\.(?:\/|\\|$))+/, "");
  return normalized === "." ? "." : normalized;
}

function toPosix(value) {
  return String(value || ".").split(path.sep).join("/");
}

function isSimpleFileName(value) {
  return String(value || "") === path.basename(String(value || ""));
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
