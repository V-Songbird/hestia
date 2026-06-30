#!/usr/bin/env python3
"""Hestia companion brief injection hook.

Runs on SessionStart, UserPromptSubmit, PreToolUse, and PostToolUse. Reads
`.hestia/lean-mode` (on unless the file says `off`) and injects the companion
doctrine as hidden context, tailored to each moment. Nothing when off.

  - SessionStart  -> the full brief (housekeeping reminder body).
    The SessionStart `source` selects the preamble framing, not the body:
      startup / clear  -> initial preamble (first load)
      resume / compact -> re-anchor preamble (counters post-compaction drift)
    The body is identical either way, so a re-brief after compaction never
    loses detail. Unknown / absent source -> initial preamble.
  - UserPromptSubmit -> ONE line picked at random from the turn-rotation pool.
    Rotating the wording stops Claude pattern-matching a fixed string as
    boilerplate and tuning it out.
  - PreToolUse    -> ONE situational line picked at random from the NUDGES lines
    whose tools= matcher matches the tool about to run. Emits nothing for an
    unmatched tool. Injection only; never gates the tool call.
  - PostToolUse   -> counts tool calls since the last user prompt; once the run
    crosses BOUNDARY_THRESHOLD it re-injects the re-grounding reminder (then again
    every BOUNDARY_THRESHOLD calls), so it lands near the eventual handoff instead
    of hundreds of calls back at SessionStart. Silent below threshold.

Output contract (native Claude Code):
  - SessionStart / UserPromptSubmit -> raw text on stdout is added.
  - PreToolUse / PostToolUse        -> context must be wrapped in
    hookSpecificOutput JSON (raw stdout is ignored for these events).

Best-effort throughout: a stale or missing file must never break the hook.

Standard library only. Python 3.10+.
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
from pathlib import Path

REANCHOR_SOURCES = {"resume", "compact"}
DOCTRINE = Path(__file__).resolve().parent.parent / "skills" / "lean" / "doctrine.md"

FALLBACK = (
    "Keep the workspace tidy — park out-of-scope work as a "
    "`hestia:later <what> — revisit when <trigger>` note, and save decisions "
    "(not code) to memory."
)

TURN_FALLBACK = "[Hestia] " + FALLBACK

# Boundary re-injection: after this many tool calls in one run, re-anchor the
# re-grounding reminder so it lands near the handoff (not back at SessionStart).
BOUNDARY_THRESHOLD = 10
BOUNDARY_NUDGE = (
    "[Hestia] Long run — before wrapping up, park any scope-creep you set aside "
    "as `hestia:later <what> — revisit when <trigger>`, and save any decisions "
    "to memory (not code or file contents)."
)

# id=<bareword> | tools="<quoted>"  — the value is either a quoted string or a bareword.
_ATTR_RE = re.compile(r'(\w+)=(?:"([^"]*)"|([\w-]+))')
# A NUDGES line: a leading run of key=value attributes, then the free-text nudge.
_LEAD_ATTRS = re.compile(r'^((?:\w+=(?:"[^"]*"|[\w-]+)\s*)+)(.+)$')


def project_dir() -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())


def is_off() -> bool:
    """The companion is on unless `.hestia/lean-mode` says `off`."""
    f = project_dir() / ".hestia" / "lean-mode"
    try:
        return f.read_text(encoding="utf-8").strip().lower() == "off"
    except OSError:
        return False


def _load_doctrine() -> str | None:
    try:
        return DOCTRINE.read_text(encoding="utf-8")
    except OSError:
        return None


def _strip_authoring_comment(text: str) -> str:
    """Drop the leading authoring comment block."""
    return re.sub(r"^\s*<!--.*?-->\s*", "", text, count=1, flags=re.DOTALL)


def _attrs(blob: str) -> dict[str, str]:
    return {m.group(1): (m.group(2) if m.group(2) is not None else m.group(3))
            for m in _ATTR_RE.finditer(blob)}


def parse_doctrine(text: str) -> dict:
    """Parse the doctrine into its parts.

    Returns {initial, reanchor, orders, turn, pretool}:
      - initial / reanchor: the two preambles (reanchor may be "").
      - orders: [{id, subagent, terse, full}] in file order.
      - turn:   [(id, text)] — the per-turn rotation pool (NUDGES without tools=).
      - pretool:[(id, regex, text)] — situational PreToolUse lines (with tools=).
    """
    text = _strip_authoring_comment(text)

    # Pull the NUDGES block out first so it is not swallowed into the last order.
    nudges_raw = ""
    halves = re.split(r"<!--\s*NUDGES\s*-->", text, maxsplit=1)
    if len(halves) == 2:
        text, nudges_raw = halves

    parts = re.split(r"<!--\s*ORDER\s+(.*?)\s*-->", text, flags=re.DOTALL)

    # The preamble region holds initial + (optional) re-anchor, split by REANCHOR.
    region = parts[0].strip()
    pre = re.split(r"<!--\s*REANCHOR\s*-->", region, maxsplit=1)
    initial = pre[0].strip()
    reanchor = pre[1].strip() if len(pre) == 2 else ""

    orders: list[dict] = []
    for i in range(1, len(parts) - 1, 2):
        attrs = _attrs(parts[i])
        terse, full_lines = "", []
        for line in parts[i + 1].strip().splitlines():
            s = line.strip()
            if not terse and not full_lines and s.startswith("- "):
                terse = s
            elif s.startswith("## ") or full_lines:
                full_lines.append(line)
        orders.append({
            "id": attrs.get("id", ""),
            "subagent": attrs.get("subagent") == "yes",
            "terse": terse,
            "full": "\n".join(full_lines).strip(),
        })

    turn, pretool = _parse_nudges(nudges_raw)
    return {"initial": initial, "reanchor": reanchor, "orders": orders,
            "turn": turn, "pretool": pretool}


def _parse_nudges(raw: str) -> tuple[list[tuple[str, str]], list[tuple[str, str, str]]]:
    turn: list[tuple[str, str]] = []
    pretool: list[tuple[str, str, str]] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s.startswith("- "):
            continue
        m = _LEAD_ATTRS.match(s[2:].strip())
        if not m:
            continue
        attrs = _attrs(m.group(1))
        text = m.group(2).strip()
        oid = attrs.get("id", "")
        tools = attrs.get("tools")
        if tools:
            pretool.append((oid, tools, text))
        else:
            turn.append((oid, text))
    return turn, pretool


def _assemble(preamble: str, pieces: list[str]) -> str:
    body = "\n\n".join(p for p in pieces if p).strip()
    return f"{preamble}\n\n{body}".strip() if body else preamble


def build_context(reanchor: bool = False) -> str:
    """The full session brief. `reanchor` swaps the preamble framing for
    resume/compact; the reminder bodies are identical across both framings."""
    text = _load_doctrine()
    if text is None:
        return FALLBACK
    d = parse_doctrine(text)
    orders = d["orders"]
    preamble = d["reanchor"] if (reanchor and d["reanchor"]) else d["initial"]
    if not orders:
        return preamble or FALLBACK
    pieces = [o["full"] for o in orders]
    return _assemble(preamble, pieces)


def build_turn_context() -> str:
    """Per-turn nudge for UserPromptSubmit: ONE line at random from the rotation pool."""
    text = _load_doctrine()
    if text is None:
        return TURN_FALLBACK
    turn = parse_doctrine(text)["turn"]
    if not turn:
        return TURN_FALLBACK
    return "[Hestia] " + random.choice([t for _, t in turn])


def build_pretool_context(tool_name: str | None) -> str:
    """Situational nudge for PreToolUse: ONE line at random among the NUDGES lines
    whose tools= regex matches `tool_name`. Empty string when nothing matches."""
    if not tool_name:
        return ""
    text = _load_doctrine()
    if text is None:
        return ""
    matches = []
    for _oid, rgx, line in parse_doctrine(text)["pretool"]:
        try:
            if re.search(rgx, tool_name):
                matches.append(line)
        except re.error:
            continue
    if not matches:
        return ""
    return "[Hestia] " + random.choice(matches)


def read_input() -> tuple[str, str | None, str | None, str | None]:
    """(hook_event_name, source, tool_name, session_id); safe defaults on bad input."""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return "SessionStart", None, None, None
    return (data.get("hook_event_name") or "SessionStart",
            data.get("source"), data.get("tool_name"), data.get("session_id"))


def _wrap(event: str, context: str) -> str:
    return json.dumps({
        "hookSpecificOutput": {"hookEventName": event, "additionalContext": context}
    })


def _run_state_path() -> Path:
    return project_dir() / ".hestia" / ".run-state.json"


def _reset_run(session_id: str | None) -> None:
    """A new user prompt starts a fresh run. Best-effort; never break the hook."""
    try:
        p = _run_state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"session": session_id or "", "count": 0, "fired_at": 0}),
                     encoding="utf-8")
    except OSError:
        pass


def _boundary_due(session_id: str | None) -> bool:
    """Increment this run's tool counter; True when it is time to re-anchor.

    Fires at BOUNDARY_THRESHOLD and every BOUNDARY_THRESHOLD calls after, so the
    last re-anchor is within BOUNDARY_THRESHOLD tool calls of the handoff. A
    changed session id resets the counter. Best-effort; never break the hook."""
    try:
        st = json.loads(_run_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        st = {}
    if st.get("session") != (session_id or ""):
        st = {"session": session_id or "", "count": 0, "fired_at": 0}
    st["count"] = int(st.get("count", 0)) + 1
    due = (st["count"] >= BOUNDARY_THRESHOLD
           and st["count"] - int(st.get("fired_at", 0)) >= BOUNDARY_THRESHOLD)
    if due:
        st["fired_at"] = st["count"]
    try:
        p = _run_state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(st), encoding="utf-8")
    except OSError:
        pass
    return due


def main() -> None:
    event, source, tool_name, session_id = read_input()
    if is_off():
        sys.exit(0)

    if event == "PostToolUse":
        if not _boundary_due(session_id):
            sys.exit(0)  # under threshold -> stay silent
        payload = _wrap("PostToolUse", BOUNDARY_NUDGE)
    elif event == "PreToolUse":
        context = build_pretool_context(tool_name)
        if not context:
            sys.exit(0)  # no nudge for this tool -> stay silent
        payload = _wrap("PreToolUse", context)
    elif event == "UserPromptSubmit":
        _reset_run(session_id)  # a new user prompt starts a fresh run
        payload = build_turn_context()  # raw stdout
    else:
        # SessionStart (and any unexpected event) -> full brief as raw stdout.
        payload = build_context(reanchor=source in REANCHOR_SOURCES)

    try:
        # Force UTF-8 so em dashes etc. survive a non-UTF-8 console locale.
        sys.stdout.buffer.write(payload.encode("utf-8"))
    except OSError:
        # stdout closed/EPIPE at hook exit must not surface as a failure.
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never break the hook over the companion injection.
        sys.exit(0)
