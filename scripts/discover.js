"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs } = require("util");

const { emit, findProjectRoot, readText, rel } = require("./_lib");

const PRUNE_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
  "dist", "build", "target", "out", ".next", ".idea", ".vscode", "vendor",
  ".hestia", ".hestia-tmp", ".kairoi",
  "worktrees",
]);

const STACK_MARKERS = {
  "package.json": "node",
  "tsconfig.json": "typescript",
  "deno.json": "deno",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pom.xml": "jvm",
  "build.gradle": "jvm",
  "build.gradle.kts": "jvm",
  "Gemfile": "ruby",
  "composer.json": "php",
};

function countLines(p) {
  const text = readText(p);
  if (!text) return 0;
  const nlCount = (text.match(/\n/g) || []).length;
  return nlCount + (text.endsWith("\n") ? 0 : 1);
}

function entry(p, root, extra = {}) {
  return { path: rel(p, root), lines: countLines(p), ...extra };
}

function relParts(p, base) {
  return path.relative(base, p).split(path.sep).filter(Boolean);
}

function isPruned(p, base) {
  return relParts(p, base).some((part) => PRUNE_DIRS.has(part));
}

function walk(dir, onFile) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (PRUNE_DIRS.has(ent.name)) continue;
      walk(full, onFile);
    } else if (ent.isFile()) {
      onFile(full);
    }
  }
}

function findClaudeMd(root) {
  const found = [];
  const seen = new Set();

  for (const [scope, p] of [
    ["project", path.join(root, "CLAUDE.md")],
    ["project-dot", path.join(root, ".claude", "CLAUDE.md")],
    ["project-local", path.join(root, "CLAUDE.local.md")],
  ]) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      found.push(entry(p, root, { scope }));
      seen.add(fs.realpathSync(p));
    }
  }

  // Nested CLAUDE.md / CLAUDE.local.md in subtrees (monorepo packages), skipping pruned dirs.
  const names = new Set(["CLAUDE.md", "CLAUDE.local.md"]);
  walk(root, (full) => {
    if (!names.has(path.basename(full))) return;
    const rp = fs.realpathSync(full);
    if (seen.has(rp)) return;
    found.push(entry(full, root, { scope: "nested" }));
    seen.add(rp);
  });
  return found;
}

function globDir(root, relDir, pattern) {
  const base = path.join(root, relDir);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(base).sort()) {
    if (!name.endsWith(pattern.replace("*", ""))) continue;
    const p = path.join(base, name);
    if (fs.statSync(p).isFile()) out.push(entry(p, root));
  }
  return out;
}

function rglobDir(root, base, suffix, scopeRoot, extraPer = {}) {
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const pathRoot = scopeRoot || root;
  const out = [];
  const collected = [];
  walk(base, (full) => {
    if (!full.endsWith(suffix)) return;
    if (isPruned(full, base)) return;
    collected.push(full);
  });
  collected.sort();
  for (const p of collected) {
    out.push(entry(p, pathRoot, extraPer));
  }
  return out;
}

function findSkills(root) {
  const base = path.join(root, ".claude", "skills");
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const out = [];
  const collected = [];
  walk(base, (full) => {
    if (path.basename(full) === "SKILL.md") collected.push(full);
  });
  collected.sort();
  for (const p of collected) {
    out.push(entry(p, root, { dir: rel(path.dirname(p), root) }));
  }
  return out;
}

function readHooks(root) {
  const result = { settings_files: [], events: {}, parse_errors: [] };
  for (const name of ["settings.json", "settings.local.json"]) {
    const p = path.join(root, ".claude", name);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    result.settings_files.push(rel(p, root));
    let data;
    try {
      data = JSON.parse(readText(p) || "{}");
    } catch {
      result.parse_errors.push(rel(p, root));
      continue;
    }
    const hooks = data.hooks || {};
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
      for (const [event, handlers] of Object.entries(hooks)) {
        const count = Array.isArray(handlers) ? handlers.length : 1;
        result.events[event] = (result.events[event] || 0) + count;
      }
    }
  }
  return result;
}

function readMcp(root) {
  const p = path.join(root, ".mcp.json");
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { present: false, servers: [] };
  }
  try {
    const data = JSON.parse(readText(p) || "{}");
    const servers = Object.keys(data.mcpServers || {}).sort();
    return { present: true, path: rel(p, root), servers };
  } catch {
    return { present: true, path: rel(p, root), servers: [], parse_error: true };
  }
}

function userConfigDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : path.resolve(override);
  }
  return path.join(os.homedir(), ".claude");
}

function findUserScope() {
  const out = { claude_md: [], rules: [] };
  let cfg;
  try {
    cfg = userConfigDir();
  } catch {
    return out;
  }
  if (!fs.existsSync(cfg) || !fs.statSync(cfg).isDirectory()) return out;

  const userMd = path.join(cfg, "CLAUDE.md");
  if (fs.existsSync(userMd) && fs.statSync(userMd).isFile()) {
    out.claude_md.push(entry(userMd, cfg, { scope: "user" }));
  }

  out.rules = rglobDir(cfg, path.join(cfg, "rules"), ".md", cfg, { scope: "user" });
  return out;
}

function detectStack(root) {
  const stack = new Set();
  for (const [marker, label] of Object.entries(STACK_MARKERS)) {
    if (fs.existsSync(path.join(root, marker))) stack.add(label);
  }
  const entries = fs.readdirSync(root);
  if (entries.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) {
    stack.add("dotnet");
  }
  return [...stack].sort();
}

function discover(projectRoot, { includeUserScope = false } = {}) {
  const root = projectRoot === undefined || projectRoot === null
    ? findProjectRoot()
    : path.resolve(projectRoot);

  const artifacts = {
    claude_md: findClaudeMd(root),
    rules: rglobDir(root, path.join(root, ".claude", "rules"), ".md"),
    agents: globDir(root, ".claude/agents", "*.md"),
    skills: findSkills(root),
    commands: rglobDir(root, path.join(root, ".claude", "commands"), ".md"),
  };

  if (includeUserScope) {
    const user = findUserScope();
    for (const md of user.claude_md) artifacts.claude_md.push(md);
    for (const rule of user.rules) artifacts.rules.push(rule);
  }

  const hooks = readHooks(root);
  const mcp = readMcp(root);
  const stack = detectStack(root);

  const summary = {};
  for (const [kind, items] of Object.entries(artifacts)) {
    summary[kind] = items.length;
  }
  summary.hook_events = Object.values(hooks.events).reduce((a, b) => a + b, 0);
  summary.mcp_servers = (mcp.servers || []).length;

  return {
    status: "ok",
    project_root: root,
    artifacts,
    hooks,
    mcp,
    stack,
    summary,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string", default: undefined },
      "include-user-scope": { type: "boolean", default: false },
    },
  });
  emit(discover(values["project-root"], { includeUserScope: values["include-user-scope"] }));
}

if (require.main === module) {
  main();
}

module.exports = { discover, PRUNE_DIRS };
