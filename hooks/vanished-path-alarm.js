"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { findProjectRoot, rel } = require("../scripts/_lib");
const { discover } = require("../scripts/discover");
const { extractRefs } = require("../scripts/refs");

const WATCHED_TOOLS = new Set(["Bash", "PowerShell"]);
const INSTRUCTION_KINDS = ["claude_md", "rules", "agents", "skills", "commands"];

const SEP = /\s*(?:&&|\|\||[;|\n])\s*/;

const BASH_VERBS = new Set(["rm", "rmdir", "unlink", "mv", "shred"]);
const PS_VERBS = new Set([
  "remove-item", "ri", "del", "erase", "rd",
  "move-item", "mi", "move", "rename-item", "rni", "ren",
]);
const GIT_VERBS = new Set(["rm", "mv"]);
const BASH_PREFIXES = new Set(["sudo", "env"]);
const ASSIGN = /^\w+=/;

const LINE_SUFFIX = /:\d+$/;
const MAX_VANISHED = 5;
const MAX_CITES = 8;

function projectDir() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function readInput() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

// Minimal POSIX/Windows-ish shell lexer standing in for Python's shlex.split.
function tokenize(part, powershell) {
  const toks = [];
  let cur = "";
  let has = false;
  let quote = null;
  let i = 0;
  while (i < part.length) {
    const c = part[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (!powershell && c === "\\" && i + 1 < part.length && quote === '"') {
        // POSIX: backslash escapes within double quotes for \, $, `, ", newline
        const n = part[i + 1];
        if (n === "\\" || n === "$" || n === "`" || n === '"' || n === "\n") {
          cur += n;
          i += 2;
          continue;
        }
        cur += c;
      } else {
        cur += c;
      }
      has = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      i += 1;
      continue;
    }
    if (!powershell && c === "\\" && i + 1 < part.length) {
      cur += part[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        toks.push(cur);
        cur = "";
        has = false;
      }
      i += 1;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  if (quote) return []; // unterminated quote -> ValueError equivalent
  if (has) toks.push(cur);
  return toks;
}

function stripBashPrefixes(toks) {
  const out = toks.slice();
  while (out.length && (BASH_PREFIXES.has(out[0]) || ASSIGN.test(out[0]))) {
    out.shift();
  }
  return out;
}

function gitPositionals(rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    const t = rest[i];
    if (
      t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" ||
      t.startsWith("-C") || t.startsWith("-c") ||
      t.startsWith("--git-dir=") || t.startsWith("--work-tree=")
    ) {
      return null;
    }
    i += 1;
  }
  if (i < rest.length && GIT_VERBS.has(rest[i].toLowerCase())) {
    return rest.slice(i + 1);
  }
  return null;
}

function positionalPaths(toks, powershell) {
  if (!toks.length) return null;
  let head;
  let rest;
  if (powershell) {
    head = toks[0].toLowerCase();
    rest = toks.slice(1);
    if (!PS_VERBS.has(head)) return null;
  } else {
    toks = stripBashPrefixes(toks);
    if (!toks.length) return null;
    head = toks[0].toLowerCase();
    rest = toks.slice(1);
    if (head === "git") {
      rest = gitPositionals(rest);
      if (rest === null) return null;
    } else if (!BASH_VERBS.has(head)) {
      return null;
    }
  }
  const args = [];
  for (let t of rest) {
    if (!t || t.startsWith("-")) continue;
    if ([...t].some((c) => "*?$".includes(c))) continue;
    if (powershell) t = t.replace(/\\/g, "/");
    args.push(t);
  }
  return args;
}

function candidateTargets(ref, fileDir, root) {
  let r = ref.startsWith("@") ? ref.slice(1) : ref;
  r = r.split("#", 1)[0];
  r = r.replace(LINE_SUFFIX, "").trim();
  if (!r || r === "." || r === "./" || r === "~/") return new Set();
  const out = new Set();
  try {
    if (r.startsWith("~/")) {
      out.add(path.resolve(path.join(require("os").homedir(), r.slice(2))));
    } else if (r.startsWith("./") || r.startsWith("../")) {
      out.add(path.resolve(fileDir, r));
      out.add(path.resolve(root, r.replace(/^\.\/+/, "")));
    } else {
      out.add(path.resolve(root, r));
      out.add(path.resolve(fileDir, r));
    }
  } catch {
    return new Set();
  }
  return out;
}

function lineOf(text, ref) {
  const needle = (ref.startsWith("@") ? ref.slice(1) : ref).split("#", 1)[0];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (needle && lines[i].includes(needle)) return i + 1;
  }
  return null;
}

// True if `p` is `root` itself or a descendant of it (root is one of p's parents).
function isUnder(p, root) {
  if (p === root) return true;
  let cur = path.dirname(p);
  while (true) {
    if (cur === root) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// True if `child` is a strict descendant of `ancestor` (ancestor in child.parents).
function isStrictDescendant(child, ancestor) {
  let cur = path.dirname(child);
  while (true) {
    if (cur === ancestor) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function findCitations(vanished, root, inv) {
  const cites = [];
  for (const kind of INSTRUCTION_KINDS) {
    for (const item of inv.artifacts[kind] || []) {
      const fpath = path.join(root, item.path);
      let text;
      try {
        text = fs.readFileSync(fpath, "utf-8");
      } catch {
        continue;
      }
      for (const ref of extractRefs(text)) {
        for (const cand of candidateTargets(ref, path.dirname(fpath), root)) {
          if (cand === vanished || isStrictDescendant(cand, vanished)) {
            cites.push({ file: item.path, ref, line: lineOf(text, ref) });
            break;
          }
        }
      }
    }
  }
  return cites;
}

function collectVanished(command, cwd, root, powershell) {
  const vanished = [];
  const seen = new Set();
  for (const part of command.split(SEP)) {
    const args = positionalPaths(tokenize(part, powershell), powershell);
    if (!args) continue;
    for (const tok of args) {
      let p;
      try {
        p = path.resolve(cwd, tok);
      } catch {
        continue;
      }
      if (seen.has(p) || fs.existsSync(p)) continue;
      if (!isUnder(p, root)) continue;
      seen.add(p);
      vanished.push(p);
    }
  }
  return vanished;
}

function signature(groups, root) {
  const basis = groups
    .map(
      ([v, cites]) =>
        rel(v, root) +
        "::" +
        cites.map((c) => `${c.file}:${c.ref}`).sort().join(",")
    )
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(basis, "utf-8").digest("hex").slice(0, 12);
}

function alreadyAnnounced(marker, sig) {
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(marker, "utf-8"));
  } catch {
    return false;
  }
  return Boolean(sig) && prev.signature === sig;
}

function record(marker, sig) {
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ signature: sig }), "utf-8");
  } catch {
    // best-effort
  }
}

function buildMessage(groups, root) {
  const lines = [];
  for (const [vanished, cites] of groups.slice(0, MAX_VANISHED)) {
    const shown = cites.slice(0, MAX_CITES);
    lines.push(
      `removed \`${rel(vanished, root)}\` — still cited by ${cites.length} reference(s):`
    );
    for (const c of shown) {
      const loc = c.line ? `${c.file}:${c.line}` : c.file;
      lines.push(`  • ${loc} — \`${c.ref}\``);
    }
    const extra = cites.length - shown.length;
    if (extra > 0) lines.push(`  • (+${extra} more)`);
  }
  return (
    "[Hestia] Vanished-path alarm — a command in this turn deleted or moved " +
    "paths the project's instruction files still name:\n" +
    lines.join("\n") +
    "\nThose references now point at paths that no longer exist. At a natural " +
    "moment, tell the user plainly and offer to update or remove them; " +
    "/hestia:freshness shows the full picture. Mention once; do not nag."
  );
}

function main() {
  const data = readInput();
  if (!WATCHED_TOOLS.has(data.tool_name)) return;
  const powershell = data.tool_name === "PowerShell";
  const command = ((data.tool_input || {}).command || "").trim();
  if (!command) return;

  const cwd = path.resolve(data.cwd || projectDir());
  const root = findProjectRoot(cwd);

  const vanished = collectVanished(command, cwd, root, powershell);
  if (!vanished.length) return;

  const inv = discover(root);
  let groups = vanished.map((v) => [v, findCitations(v, root, inv)]);
  groups = groups.filter(([, c]) => c.length);
  if (!groups.length) return;

  const marker = path.join(root, ".hestia", "vanished-alarm.json");
  const sig = signature(groups, root);
  if (alreadyAnnounced(marker, sig)) return;
  record(marker, sig);

  const payload = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: buildMessage(groups, root),
    },
  };
  try {
    process.stdout.write(Buffer.from(JSON.stringify(payload), "utf-8"));
  } catch {
    // stdout write failure -> mirror Python's OSError swallow
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = {
  projectDir,
  readInput,
  tokenize,
  stripBashPrefixes,
  gitPositionals,
  positionalPaths,
  candidateTargets,
  lineOf,
  isUnder,
  findCitations,
  collectVanished,
  signature,
  alreadyAnnounced,
  record,
  buildMessage,
  main,
};
