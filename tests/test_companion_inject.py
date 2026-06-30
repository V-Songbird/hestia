"""Tests for companion-inject.py — the SessionStart injector.

Covers:
  - SessionStart (on by default) emits the full body of the housekeeping reminder.
  - The companion is on/off only — no verbosity levels. `off` emits nothing;
    anything else (incl. absent file) is on.
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

# Marker tied to the housekeeping reminder (skills/lean/doctrine.md).
HOUSE_TERSE = "- **Keep the workspace tidy:**"
HOUSE_FULL = "## Keep the workspace tidy"


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


def turn_event() -> str:
    return json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "do a thing"})


def pretool_event(tool_name: str) -> str:
    return json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool_name})


def posttool_event(session_id: str = "s", tool_name: str = "Read") -> str:
    return json.dumps({"hook_event_name": "PostToolUse",
                       "tool_name": tool_name, "session_id": session_id})


def userprompt_event(session_id: str = "s") -> str:
    return json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": session_id})


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

    def test_full_brief_includes_housekeeping_reminder(self, project):
        r = run_hook(project, session_event())
        assert "Keep the workspace tidy" in r.stdout
        assert "Talk to the stakeholder" not in r.stdout

    def test_default_mode_is_on(self, project):
        """No lean-mode file -> on -> full body of housekeeping reminder."""
        r = run_hook(project, session_event())
        assert HOUSE_FULL in r.stdout
        assert HOUSE_TERSE not in r.stdout


# ---------------------------------------------------------------------------
# SessionStart source — re-anchor preamble on resume/compact
# ---------------------------------------------------------------------------

class TestSessionStartSource:
    def test_startup_uses_initial_preamble(self, project):
        out = run_hook(project, session_event("startup")).stdout
        assert "sync watchdog" in out           # initial preamble text
        assert "just resumed or compressed" not in out

    def test_compact_uses_reanchor_preamble(self, project):
        out = run_hook(project, session_event("compact")).stdout
        assert "still here" in out                # re-anchor heading
        assert "just resumed or compressed" in out

    def test_resume_uses_reanchor_preamble(self, project):
        out = run_hook(project, session_event("resume")).stdout
        assert "just resumed or compressed" in out

    def test_reanchor_keeps_full_order_body(self, project):
        """Re-anchor changes the framing, never drops detail."""
        out = run_hook(project, session_event("compact")).stdout
        assert HOUSE_FULL in out

    def test_unknown_source_falls_back_to_initial(self, project):
        out = run_hook(project, session_event("wibble")).stdout
        assert "sync watchdog" in out
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

    def test_rotation_covers_multiple_lines(self, project):
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
        """Edit carries no nudge."""
        r = run_hook(project, pretool_event("Edit"))
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_bash_gets_tidy_nudge(self, project):
        r = run_hook(project, pretool_event("Bash"))
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        assert ctx.startswith("[Hestia] Tidy:")

    def test_websearch_emits_nothing(self, project):
        """WebSearch no longer has a nudge after communication pillar removal."""
        r = run_hook(project, pretool_event("WebSearch"))
        assert r.returncode == 0
        assert r.stdout.strip() == ""

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
# off mode
# ---------------------------------------------------------------------------

class TestOffMode:
    def test_session_off_emits_nothing(self, project):
        set_mode(project, "off")
        r = run_hook(project, session_event())
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

    def test_non_off_mode_is_on(self, project):
        """Anything that isn't `off` — garbage or a legacy level word — means on."""
        for mode in ("wibble", "lean", "trim", "bare"):
            set_mode(project, mode)
            r = run_hook(project, session_event())
            assert r.returncode == 0
            assert HOUSE_FULL in r.stdout  # full brief, not off


# ---------------------------------------------------------------------------
# PostToolUse — boundary re-injection (count tool calls, re-anchor near handoff)
# ---------------------------------------------------------------------------

class TestBoundary:
    def _fired_at(self, project, n, session="s"):
        """Run n PostToolUse calls; return the 1-based indices that emitted."""
        return [i for i in range(1, n + 1)
                if run_hook(project, posttool_event(session)).stdout.strip()]

    def test_silent_under_threshold(self, project):
        run_hook(project, userprompt_event())               # reset the run
        assert self._fired_at(project, 9) == []

    def test_fires_at_threshold(self, project):
        run_hook(project, userprompt_event())
        assert self._fired_at(project, 10) == [10]

    def test_refires_every_threshold(self, project):
        run_hook(project, userprompt_event())
        assert self._fired_at(project, 20) == [10, 20]

    def test_payload_is_boundary_nudge(self, project):
        run_hook(project, userprompt_event())
        out = ""
        for _ in range(10):
            out = run_hook(project, posttool_event()).stdout
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert ctx.startswith("[Hestia] Long run")
        assert "hestia:later" in ctx

    def test_user_prompt_resets_counter(self, project):
        run_hook(project, userprompt_event())
        self._fired_at(project, 10)                          # fires at 10
        run_hook(project, userprompt_event())               # new prompt -> reset
        assert self._fired_at(project, 9) == []             # silent again

    def test_session_change_resets(self, project):
        run_hook(project, userprompt_event("a"))
        for _ in range(9):
            run_hook(project, posttool_event("a"))          # count 9 on session a
        # switching session resets to count 1 -> silent (no fire at the 10th-overall call)
        assert run_hook(project, posttool_event("b")).stdout.strip() == ""

    def test_off_silences_post_tool(self, project):
        set_mode(project, "off")
        run_hook(project, userprompt_event())
        for _ in range(12):
            assert run_hook(project, posttool_event()).stdout.strip() == ""
