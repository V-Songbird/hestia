"""Tests for companion-inject.py — the SessionStart / SubagentStart injector.

Covers:
  - SessionStart at the default (lean) emits the full body of both reminders.
  - The verbosity dial is real: trim = terse of both reminders, lean = full
    bodies, bare = terse of the critical reminder only (bare < trim < lean).
  - SubagentStart emits the terse subagent=yes subset (communication only),
    wrapped in the hookSpecificOutput JSON contract — not housekeeping, not full.
  - mode "off" emits nothing.
  - The hook never crashes on missing / empty / malformed stdin.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).parent.parent / "hooks" / "companion-inject.py"
PYTHON = sys.executable

# Markers tied to the two-pillar doctrine (skills/lean/doctrine.md).
COMMS_TERSE = "- **Talk to the stakeholder:**"
HOUSE_TERSE = "- **Keep the workspace tidy:**"
COMMS_FULL = "Lead with the outcome"          # appears only in the full body
HOUSE_FULL = "## Keep the workspace tidy"      # full-body heading


def run_hook(project: Path, stdin_data: str | None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["CLAUDE_PROJECT_DIR"] = str(project)
    return subprocess.run(
        [PYTHON, str(HOOK)],
        input=stdin_data,
        capture_output=True,
        text=True,
        timeout=30,
        encoding="utf-8",
        env=env,
    )


def session_event(source: str | None = None) -> str:
    d = {"hook_event_name": "SessionStart"}
    if source is not None:
        d["source"] = source
    return json.dumps(d)


def subagent_event() -> str:
    return json.dumps({"hook_event_name": "SubagentStart"})


def turn_event() -> str:
    return json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "do a thing"})


def pretool_event(tool_name: str) -> str:
    return json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool_name})


@pytest.fixture
def project(tmp_path):
    p = tmp_path / "project"
    p.mkdir()
    return p


def set_mode(project: Path, mode: str) -> None:
    d = project / ".hestia"
    d.mkdir(exist_ok=True)
    (d / "lean-mode").write_text(mode, encoding="utf-8")


# ---------------------------------------------------------------------------
# SessionStart — full brief, raw stdout
# ---------------------------------------------------------------------------

class TestSessionStart:
    def test_emits_full_brief_raw(self, project):
        r = run_hook(project, session_event())
        assert r.returncode == 0
        # Raw text, not JSON-wrapped.
        with pytest.raises(json.JSONDecodeError):
            json.loads(r.stdout)
        assert "# Hestia" in r.stdout

    def test_full_brief_includes_both_reminders(self, project):
        r = run_hook(project, session_event())
        assert "Talk to the stakeholder" in r.stdout
        assert "Keep the workspace tidy" in r.stdout

    def test_default_mode_is_lean(self, project):
        """No lean-mode file -> default level = lean = full bodies of both reminders."""
        r = run_hook(project, session_event())
        # COMMS_FULL appears only in the full communication body, never terse.
        assert COMMS_FULL in r.stdout


# ---------------------------------------------------------------------------
# SessionStart source — re-anchor preamble on resume/compact
# ---------------------------------------------------------------------------

class TestSessionStartSource:
    def test_startup_uses_initial_preamble(self, project):
        out = run_hook(project, session_event("startup")).stdout
        assert "calm companion" in out           # initial preamble text
        assert "just resumed or compressed" not in out

    def test_compact_uses_reanchor_preamble(self, project):
        out = run_hook(project, session_event("compact")).stdout
        assert "still here" in out                # re-anchor heading
        assert "just resumed or compressed" in out

    def test_resume_uses_reanchor_preamble(self, project):
        out = run_hook(project, session_event("resume")).stdout
        assert "just resumed or compressed" in out

    def test_reanchor_keeps_full_order_bodies(self, project):
        """Re-anchor changes the framing, never drops detail."""
        out = run_hook(project, session_event("compact")).stdout
        assert COMMS_FULL in out                  # full communication body still present
        assert HOUSE_FULL in out

    def test_unknown_source_falls_back_to_initial(self, project):
        out = run_hook(project, session_event("wibble")).stdout
        assert "calm companion" in out
        assert "just resumed or compressed" not in out


# ---------------------------------------------------------------------------
# UserPromptSubmit — one rotating line, raw stdout
# ---------------------------------------------------------------------------

class TestTurnNudge:
    def test_emits_single_hestia_line(self, project):
        r = run_hook(project, turn_event())
        assert r.returncode == 0
        out = r.stdout.strip()
        assert out.startswith("[Hestia]")
        assert out.count("[Hestia]") == 1        # one line, not the old 4-in-one
        with pytest.raises(json.JSONDecodeError):
            json.loads(r.stdout)                  # raw, not JSON-wrapped

    def test_rotation_covers_multiple_orders(self, project):
        """Across many turns the pool yields more than one distinct line."""
        seen = {run_hook(project, turn_event()).stdout.strip() for _ in range(40)}
        assert len(seen) > 1

    def test_off_emits_nothing(self, project):
        set_mode(project, "off")
        r = run_hook(project, turn_event())
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# PreToolUse — situational, JSON-wrapped, silent for unmatched tools
# ---------------------------------------------------------------------------

class TestPreToolUse:
    def test_edit_emits_nothing(self, project):
        """Edit no longer carries a nudge — code craft is ceded."""
        r = run_hook(project, pretool_event("Edit"))
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_bash_gets_tidy_nudge(self, project):
        r = run_hook(project, pretool_event("Bash"))
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert ctx.startswith("[Hestia] Tidy:")

    def test_websearch_gets_honesty_nudge(self, project):
        r = run_hook(project, pretool_event("WebSearch"))
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "Be honest" in ctx

    def test_mcp_sql_matches_regex_group(self, project):
        r = run_hook(project, pretool_event("mcp__webstorm__execute_sql_query"))
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert ctx.startswith("[Hestia] Tidy:")

    def test_unmatched_tool_emits_nothing(self, project):
        r = run_hook(project, pretool_event("Read"))
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_off_emits_nothing(self, project):
        set_mode(project, "off")
        r = run_hook(project, pretool_event("Bash"))
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# SubagentStart — compact subset, JSON-wrapped
# ---------------------------------------------------------------------------

class TestSubagentStart:
    def test_emits_valid_json_contract(self, project):
        r = run_hook(project, subagent_event())
        assert r.returncode == 0
        payload = json.loads(r.stdout)
        hso = payload["hookSpecificOutput"]
        assert hso["hookEventName"] == "SubagentStart"
        assert isinstance(hso["additionalContext"], str)
        assert hso["additionalContext"]

    def test_includes_communication_reminder(self, project):
        r = run_hook(project, subagent_event())
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert COMMS_TERSE in ctx

    def test_excludes_housekeeping(self, project):
        """Housekeeping is the parent session's job, not a subagent's."""
        r = run_hook(project, subagent_event())
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert HOUSE_TERSE not in ctx

    def test_subagent_brief_is_smaller_than_full(self, project):
        full = run_hook(project, session_event()).stdout
        sub = json.loads(
            run_hook(project, subagent_event()).stdout
        )["hookSpecificOutput"]["additionalContext"]
        assert len(sub) < len(full)

    def test_subagent_uses_terse_not_full(self, project):
        """Subagent gets the terse one-liner, not the full body."""
        r = run_hook(project, subagent_event())
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert COMMS_TERSE in ctx       # terse bullet form
        assert COMMS_FULL not in ctx    # full body NOT included


# ---------------------------------------------------------------------------
# off mode
# ---------------------------------------------------------------------------

class TestOffMode:
    def test_session_off_emits_nothing(self, project):
        set_mode(project, "off")
        r = run_hook(project, session_event())
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_subagent_off_emits_nothing(self, project):
        set_mode(project, "off")
        r = run_hook(project, subagent_event())
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# Robustness — never crash
# ---------------------------------------------------------------------------

class TestRobustness:
    def test_empty_stdin_defaults_to_session(self, project):
        r = run_hook(project, "")
        assert r.returncode == 0
        # Empty stdin -> treated as SessionStart -> raw full brief.
        assert "# Hestia" in r.stdout

    def test_malformed_stdin_does_not_crash(self, project):
        r = run_hook(project, "not json at all {{{")
        assert r.returncode == 0

    def test_no_stdin_does_not_crash(self, project):
        r = run_hook(project, None)
        assert r.returncode == 0

    def test_garbage_mode_falls_back_to_default(self, project):
        set_mode(project, "wibble")
        r = run_hook(project, session_event())
        assert r.returncode == 0
        assert COMMS_FULL in r.stdout  # fell back to lean (full bodies)


# ---------------------------------------------------------------------------
# The verbosity dial — trim / lean / bare genuinely differ
# ---------------------------------------------------------------------------

class TestLevels:
    TERSE_LABELS = (COMMS_TERSE, HOUSE_TERSE)

    def test_trim_is_all_orders_terse(self, project):
        set_mode(project, "trim")
        out = run_hook(project, session_event()).stdout
        for label in self.TERSE_LABELS:
            assert label in out          # both reminders present, terse
        assert COMMS_FULL not in out     # but no full bodies
        assert HOUSE_FULL not in out

    def test_lean_is_all_orders_full(self, project):
        set_mode(project, "lean")
        out = run_hook(project, session_event()).stdout
        assert COMMS_FULL in out         # full bodies
        assert HOUSE_FULL in out
        assert COMMS_TERSE not in out    # not the terse bullets

    def test_bare_is_critical_orders_only(self, project):
        set_mode(project, "bare")
        out = run_hook(project, session_event()).stdout
        assert COMMS_TERSE in out
        # non-critical housekeeping is dropped at bare
        assert HOUSE_TERSE not in out

    def test_size_ordering_bare_lt_trim_lt_lean(self, project):
        def size(mode):
            set_mode(project, mode)
            return len(run_hook(project, session_event()).stdout)
        assert size("bare") < size("trim") < size("lean")
