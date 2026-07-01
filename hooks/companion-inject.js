const fs = require("fs");
const path = require("path");

const REANCHOR_SOURCES = new Set(["resume", "compact"]);
const DOCTRINE = path.join(__dirname, "..", "skills", "lean", "doctrine.md");

const FALLBACK =
  "Keep the workspace tidy — park out-of-scope work as a " +
  "`hestia:later <what> — revisit when <trigger>` note, and save decisions " +
  "(not code) to memory.";

const TURN_FALLBACK = "[Hestia] " + FALLBACK;

const BOUNDARY_THRESHOLD = 10;
const BOUNDARY_NUDGE =
  "[Hestia] Long run — before wrapping up, park any scope-creep you set aside " +
  "as `hestia:later <what> — revisit when <trigger>`, and save any decisions " +
  "to memory (not code or file contents).";

const _ATTR_RE = /(\w+)=(?:"([^"]*)"|([\w-]+))/g;
const _LEAD_ATTRS = /^((?:\w+=(?:"[^"]*"|[\w-]+)\s*)+)(.+)$/s;

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function isOff() {
  const f = path.join(projectDir(), ".hestia", "lean-mode");
  try {
    return fs.readFileSync(f, "utf-8").trim().toLowerCase() === "off";
  } catch {
    return false;
  }
}

function _loadDoctrine() {
  try {
    return fs.readFileSync(DOCTRINE, "utf-8");
  } catch {
    return null;
  }
}

function _stripAuthoringComment(text) {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}

function _attrs(blob) {
  const out = {};
  for (const m of blob.matchAll(_ATTR_RE)) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function parseDoctrine(text) {
  text = _stripAuthoringComment(text);

  let nudgesRaw = "";
  const halves = text.split(/<!--\s*NUDGES\s*-->/);
  if (halves.length >= 2) {
    text = halves[0];
    nudgesRaw = halves.slice(1).join("");
  }

  const parts = text.split(/<!--\s*ORDER\s+(.*?)\s*-->/s);

  const region = parts[0].trim();
  const pre = region.split(/<!--\s*REANCHOR\s*-->/);
  const initial = pre[0].trim();
  const reanchor = pre.length === 2 ? pre[1].trim() : "";

  const orders = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const attrs = _attrs(parts[i]);
    let terse = "";
    const fullLines = [];
    for (const line of parts[i + 1].trim().split("\n")) {
      const s = line.trim();
      if (!terse && fullLines.length === 0 && s.startsWith("- ")) {
        terse = s;
      } else if (s.startsWith("## ") || fullLines.length) {
        fullLines.push(line);
      }
    }
    orders.push({
      id: attrs.id || "",
      subagent: attrs.subagent === "yes",
      terse,
      full: fullLines.join("\n").trim(),
    });
  }

  const { turn, pretool } = _parseNudges(nudgesRaw);
  return { initial, reanchor, orders, turn, pretool };
}

function _parseNudges(raw) {
  const turn = [];
  const pretool = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("- ")) continue;
    const m = _LEAD_ATTRS.exec(s.slice(2).trim());
    if (!m) continue;
    const attrs = _attrs(m[1]);
    const text = m[2].trim();
    const oid = attrs.id || "";
    const tools = attrs.tools;
    if (tools) {
      pretool.push([oid, tools, text]);
    } else {
      turn.push([oid, text]);
    }
  }
  return { turn, pretool };
}

function _assemble(preamble, pieces) {
  const body = pieces.filter(Boolean).join("\n\n").trim();
  return body ? `${preamble}\n\n${body}`.trim() : preamble;
}

function buildContext(reanchor = false) {
  const text = _loadDoctrine();
  if (text === null) return FALLBACK;
  const d = parseDoctrine(text);
  const orders = d.orders;
  const preamble = reanchor && d.reanchor ? d.reanchor : d.initial;
  if (!orders.length) return preamble || FALLBACK;
  const pieces = orders.map((o) => o.full);
  return _assemble(preamble, pieces);
}

function buildTurnContext() {
  const text = _loadDoctrine();
  if (text === null) return TURN_FALLBACK;
  const turn = parseDoctrine(text).turn;
  if (!turn.length) return TURN_FALLBACK;
  const choice = turn[Math.floor(Math.random() * turn.length)][1];
  return "[Hestia] " + choice;
}

function buildPretoolContext(toolName) {
  if (!toolName) return "";
  const text = _loadDoctrine();
  if (text === null) return "";
  const matches = [];
  for (const [, rgx, line] of parseDoctrine(text).pretool) {
    try {
      if (new RegExp(rgx).test(toolName)) matches.push(line);
    } catch {
      continue;
    }
  }
  if (!matches.length) return "";
  return "[Hestia] " + matches[Math.floor(Math.random() * matches.length)];
}

function readInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    raw = "";
  }
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return { event: "SessionStart", source: null, toolName: null, sessionId: null };
  }
  return {
    event: data.hook_event_name || "SessionStart",
    source: data.source ?? null,
    toolName: data.tool_name ?? null,
    sessionId: data.session_id ?? null,
  };
}

function _wrap(event, context) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  });
}

function _runStatePath() {
  return path.join(projectDir(), ".hestia", ".run-state.json");
}

function _resetRun(sessionId) {
  try {
    const p = _runStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ session: sessionId || "", count: 0, fired_at: 0 }),
      "utf-8"
    );
  } catch {
    // best-effort
  }
}

function _boundaryDue(sessionId) {
  let st = {};
  try {
    st = JSON.parse(fs.readFileSync(_runStatePath(), "utf-8"));
  } catch {
    st = {};
  }
  if (st.session !== (sessionId || "")) {
    st = { session: sessionId || "", count: 0, fired_at: 0 };
  }
  st.count = (parseInt(st.count, 10) || 0) + 1;
  const due =
    st.count >= BOUNDARY_THRESHOLD &&
    st.count - (parseInt(st.fired_at, 10) || 0) >= BOUNDARY_THRESHOLD;
  if (due) st.fired_at = st.count;
  try {
    const p = _runStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st), "utf-8");
  } catch {
    // best-effort
  }
  return due;
}

function main() {
  const { event, source, toolName, sessionId } = readInput();
  if (isOff()) process.exit(0);

  let payload;
  if (event === "PostToolUse") {
    if (!_boundaryDue(sessionId)) process.exit(0);
    payload = _wrap("PostToolUse", BOUNDARY_NUDGE);
  } else if (event === "PreToolUse") {
    const context = buildPretoolContext(toolName);
    if (!context) process.exit(0);
    payload = _wrap("PreToolUse", context);
  } else if (event === "UserPromptSubmit") {
    _resetRun(sessionId);
    payload = buildTurnContext();
  } else {
    payload = buildContext(REANCHOR_SOURCES.has(source));
  }

  try {
    process.stdout.write(Buffer.from(payload, "utf-8"));
  } catch {
    // stdout closed/EPIPE at hook exit must not surface as a failure.
  }
}

try {
  main();
} catch {
  process.exit(0);
}

module.exports = {
  projectDir,
  isOff,
  parseDoctrine,
  buildContext,
  buildTurnContext,
  buildPretoolContext,
  readInput,
};
