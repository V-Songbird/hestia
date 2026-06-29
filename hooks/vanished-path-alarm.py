#!/usr/bin/env python3
"""PostToolUse watchdog — a destructive shell command just removed a path that
the project's instruction files still cite. Flag it in the SAME turn.

Spike for Hestia's "Vanished-path citation alarm". Where the freshness skill
forward-scans every instruction file at session start, this pivots the other way:
it takes the now-gone SOURCE path of a move/rename/delete and reverse-looks-up
every CLAUDE.md / rule / agent / skill / command reference that named it — exact
match for a vanished file, prefix match for a vanished directory (one
`git mv scripts/ tools/` invalidates every `scripts/*` citation at once).

Reuses scripts/discover.py (the artifact inventory) and scripts/refs.py
(reference extraction). It deliberately does NOT use refs.resolve(): that helper
chooses between a root-relative and a file-relative interpretation by which one
currently EXISTS — but the path we are matching has just been deleted, so that
existence-based choice is exactly wrong for a reverse lookup. We resolve both
interpretations ourselves instead (see _candidate_targets).

Native PostToolUse output contract: raw stdout is ignored; advisory context must
be wrapped in hookSpecificOutput JSON. This hook never blocks the tool and never
breaks the session — any error exits 0 silently.

Standard library only. Python 3.10+.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import sys
from pathlib import Path

# Reuse Hestia's existing plumbing in scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import discover as discover_mod  # noqa: E402
import refs as refs_mod  # noqa: E402
from _lib import find_project_root, rel  # noqa: E402

WATCHED_TOOLS = {"Bash", "PowerShell"}
INSTRUCTION_KINDS = ("claude_md", "rules", "agents", "skills", "commands")

# Sub-command separators: && || ; | and newline. A quoted operator inside a
# destructive command is rare enough that a textual split stays conservative.
_SEP = re.compile(r"\s*(?:&&|\|\||[;|\n])\s*")

# Verbs that DELETE or MOVE a path away from where it was. We pivot only on the
# fact that an argument no longer exists on disk, so we never have to tell a
# source from a destination — the existence check does that for us.
_BASH_VERBS = {"rm", "rmdir", "unlink", "mv", "shred"}
_PS_VERBS = {
    "remove-item", "ri", "del", "erase", "rd",
    "move-item", "mi", "move", "rename-item", "rni", "ren",
}
_GIT_VERBS = {"rm", "mv"}
# Leading words that wrap a still-destructive command; stripped before the verb.
_BASH_PREFIXES = {"sudo", "env"}
_ASSIGN = re.compile(r"^\w+=")  # an env-var assignment prefix, e.g. FOO=bar rm x

_LINE_SUFFIX = re.compile(r":\d+$")
MAX_VANISHED = 5   # cap distinct vanished paths reported in one message
MAX_CITES = 8      # cap citations listed per vanished path


def project_dir() -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())


def read_input() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return {}


def _tokenize(part: str, powershell: bool) -> list[str]:
    """Lex one sub-command into tokens. POSIX lexing for Bash; for PowerShell we
    keep backslashes (Windows paths) and strip surrounding quotes by hand."""
    try:
        if powershell:
            toks = shlex.split(part, posix=False)
            return [
                t[1:-1] if len(t) >= 2 and t[0] in "\"'" and t[-1] == t[0] else t
                for t in toks
            ]
        return shlex.split(part, posix=True)
    except ValueError:
        return []


def _strip_bash_prefixes(toks: list[str]) -> list[str]:
    """Drop leading `sudo` / `env` wrappers and env-var assignments so the real
    verb surfaces (`sudo rm x`, `FOO=bar rm x` are still destructive)."""
    out = list(toks)
    while out and (out[0] in _BASH_PREFIXES or _ASSIGN.match(out[0])):
        out = out[1:]
    return out


def _git_positionals(rest: list[str]) -> list[str] | None:
    """Positional args of a `git rm|mv`, skipping leading global options. Bails
    (returns None) on an option that relocates git's working tree or alters
    config (`-C`, `-c`, `--work-tree`, `--git-dir`): those change the base a path
    resolves against, and resolving against the wrong base is a false alarm — a
    miss is preferred. Detection still works for the common `git rm|mv <path>`."""
    i = 0
    while i < len(rest) and rest[i].startswith("-"):
        t = rest[i]
        if t in ("-C", "-c", "--git-dir", "--work-tree") or t.startswith(
                ("-C", "-c", "--git-dir=", "--work-tree=")):
            return None
        i += 1
    if i < len(rest) and rest[i].lower() in _GIT_VERBS:
        return rest[i + 1:]
    return None


def _positional_paths(toks: list[str], powershell: bool) -> list[str] | None:
    """If this sub-command's verb is destructive, return its positional path
    arguments (flags / params / globs / var-expansions removed). Otherwise None."""
    if not toks:
        return None
    if powershell:
        head = toks[0].lower()
        rest = toks[1:]
        if head not in _PS_VERBS:
            return None
    else:
        toks = _strip_bash_prefixes(toks)
        if not toks:
            return None
        head = toks[0].lower()
        rest = toks[1:]
        if head == "git":
            rest = _git_positionals(rest)
            if rest is None:
                return None
        elif head not in _BASH_VERBS:
            return None
    args: list[str] = []
    for t in rest:
        if not t or t.startswith("-"):
            continue  # flag (bash) or named parameter (powershell)
        if any(c in t for c in "*?$"):
            continue  # glob or shell/var expansion — can't resolve reliably
        if powershell:
            t = t.replace("\\", "/")  # PowerShell path separator -> POSIX, so the
            # reverse lookup resolves the same way on every OS the suite runs on
        args.append(t)
    return args


def _candidate_targets(ref: str, file_dir: Path, root: Path) -> set[Path]:
    """Every absolute path a reference could denote — resolved BOTH root-relative
    and file-relative. Both are computed on purpose: refs.resolve() would pick
    between them by which one currently exists, and our target was just deleted."""
    r = ref[1:] if ref.startswith("@") else ref
    r = r.split("#", 1)[0]
    r = _LINE_SUFFIX.sub("", r).strip()
    if not r or r in (".", "./", "~/"):
        return set()
    out: set[Path] = set()
    try:
        if r.startswith("~/"):
            out.add((Path.home() / r[2:]).resolve())
        elif r.startswith(("./", "../")):
            out.add((file_dir / r).resolve())
            out.add((root / r.lstrip("./")).resolve())
        else:
            out.add((root / r).resolve())
            out.add((file_dir / r).resolve())
    except (OSError, ValueError):
        return set()
    return out


def _line_of(text: str, ref: str) -> int | None:
    needle = (ref[1:] if ref.startswith("@") else ref).split("#", 1)[0]
    for i, line in enumerate(text.splitlines(), 1):
        if needle and needle in line:
            return i
    return None


def _is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def find_citations(vanished: Path, root: Path, inv: dict) -> list[dict]:
    """Every instruction-file reference that pointed at ``vanished`` (exact for a
    file, or under it for a directory)."""
    cites: list[dict] = []
    for kind in INSTRUCTION_KINDS:
        for item in inv["artifacts"].get(kind, []):
            fpath = root / item["path"]
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for ref in refs_mod.extract_refs(text):
                for cand in _candidate_targets(ref, fpath.parent, root):
                    if cand == vanished or vanished in cand.parents:
                        cites.append({"file": item["path"], "ref": ref,
                                      "line": _line_of(text, ref)})
                        break
    return cites


def collect_vanished(command: str, cwd: Path, root: Path, powershell: bool) -> list[Path]:
    """Path arguments of destructive sub-commands that no longer exist on disk and
    sit inside the project tree."""
    vanished: list[Path] = []
    seen: set[Path] = set()
    for part in _SEP.split(command):
        args = _positional_paths(_tokenize(part, powershell), powershell)
        if not args:
            continue
        for tok in args:
            try:
                p = (cwd / tok).resolve()
            except (OSError, ValueError):
                continue
            if p in seen or p.exists():
                continue  # still on disk -> not actually removed (e.g. a move's destination)
            if not _is_under(p, root):
                continue  # outside the project -> no instruction file cites it
            seen.add(p)
            vanished.append(p)
    return vanished


def _signature(groups: list[tuple[Path, list[dict]]], root: Path) -> str:
    """A stable fingerprint of the finding set (vanished paths + their citations).

    Signature-only throttle, no time component: unlike the SessionStart freshness
    nudge — which re-sees the same stale set every launch and so throttles by days
    — this fires on a discrete destructive command, a genuine new event each time.
    The only repeat worth suppressing is the *identical* alarm landing twice in a
    row (a re-run command, or two edits that leave the same citations dangling)."""
    basis = "|".join(sorted(
        rel(v, root) + "::" + ",".join(sorted(f"{c['file']}:{c['ref']}" for c in cites))
        for v, cites in groups
    ))
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]


def _already_announced(marker: Path, signature: str) -> bool:
    """True if this exact alarm was the most recent one emitted (best-effort)."""
    try:
        prev = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return bool(signature) and prev.get("signature") == signature


def _record(marker: Path, signature: str) -> None:
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"signature": signature}), encoding="utf-8")
    except OSError:
        pass


def build_message(groups: list[tuple[Path, list[dict]]], root: Path) -> str:
    lines: list[str] = []
    for vanished, cites in groups[:MAX_VANISHED]:
        shown = cites[:MAX_CITES]
        lines.append(f"removed `{rel(vanished, root)}` — still cited by "
                     f"{len(cites)} reference(s):")
        for c in shown:
            loc = f"{c['file']}:{c['line']}" if c["line"] else c["file"]
            lines.append(f"  • {loc} — `{c['ref']}`")
        extra = len(cites) - len(shown)
        if extra > 0:
            lines.append(f"  • (+{extra} more)")
    return (
        "[Hestia] Vanished-path alarm — a command in this turn deleted or moved "
        "paths the project's instruction files still name:\n"
        + "\n".join(lines)
        + "\nThose references now point at paths that no longer exist. At a natural "
        "moment, tell the user plainly and offer to update or remove them; "
        "/hestia:freshness shows the full picture. Mention once; do not nag."
    )


def main() -> None:
    data = read_input()
    if data.get("tool_name") not in WATCHED_TOOLS:
        return
    powershell = data.get("tool_name") == "PowerShell"
    command = ((data.get("tool_input") or {}).get("command") or "").strip()
    if not command:
        return

    cwd = Path(data.get("cwd") or project_dir())
    root = find_project_root(str(cwd))

    vanished = collect_vanished(command, cwd, root, powershell)
    if not vanished:
        return

    inv = discover_mod.discover(str(root))
    groups = [(v, find_citations(v, root, inv)) for v in vanished]
    groups = [(v, c) for v, c in groups if c]
    if not groups:
        return

    # Throttle: stay silent if this exact alarm was the one just emitted.
    marker = root / ".hestia" / "vanished-alarm.json"
    signature = _signature(groups, root)
    if _already_announced(marker, signature):
        return
    _record(marker, signature)

    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": build_message(groups, root),
        }
    }
    try:
        sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A watchdog must never break the tool call it observes.
        sys.exit(0)
