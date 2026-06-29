"""Tests for vanished-path-alarm.py — the PostToolUse vanished-path citation alarm.

Covers:
  - A destructive command (rm / mv / git mv|rm / Remove-Item) that deletes a path
    an instruction file still cites fires an advisory in the same turn.
  - A vanished DIRECTORY prefix-matches a nested bare reference inside it — the
    case the existence-dependent refs.resolve() would mis-resolve and miss.
  - A move flags the vanished SOURCE only, never the surviving destination.
  - Silence when: the path still exists, nothing cites it, the tool isn't
    Bash/PowerShell, the path is outside the project tree, or the arg is a glob.
  - The signature throttle suppresses an identical back-to-back alarm but lets a
    different one through.
  - The hookSpecificOutput JSON contract, and never-crash robustness.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).parent.parent / "hooks" / "vanished-path-alarm.py"
PYTHON = sys.executable


def run_hook(project: Path, tool_name: str, command: str) -> subprocess.CompletedProcess:
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": tool_name,
        "cwd": str(project),
        "tool_input": {"command": command},
        "tool_response": {"stdout": "", "stderr": "", "exit_code": 0},
    }
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["CLAUDE_PROJECT_DIR"] = str(project)
    return subprocess.run(
        [PYTHON, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        encoding="utf-8",
        env=env,
    )


def context_of(result: subprocess.CompletedProcess) -> str:
    """The injected advisory text, or '' when the hook stayed silent."""
    out = result.stdout.strip()
    if not out:
        return ""
    return json.loads(out)["hookSpecificOutput"]["additionalContext"]


@pytest.fixture
def project(tmp_path):
    """A temp project root. The empty .git makes find_project_root() stop here,
    deterministically, regardless of any ambient repo above the temp dir."""
    p = tmp_path / "project"
    p.mkdir()
    (p / ".git").mkdir()
    return p


def write(project: Path, relpath: str, text: str) -> None:
    f = project / relpath
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Fires — the path vanished and something still cites it
# ---------------------------------------------------------------------------

class TestFires:
    def test_file_delete_names_the_citation(self, project):
        write(project, "CLAUDE.md", "Run the scan in `scripts/old.py` first.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        ctx = context_of(run_hook(project, "Bash", "rm scripts/old.py"))
        assert "CLAUDE.md" in ctx
        assert "scripts/old.py" in ctx

    def test_dir_rename_prefix_matches_nested_bare_ref(self, project):
        """git mv of a directory must flag a bare ref inside it cited from a
        NESTED rule file — the resolve() existence-fallback gotcha."""
        write(project, ".claude/rules/api.md", "Always run `scripts/drift.py` before a commit.\n")
        write(project, "scripts/drift.py", "x\n")
        (project / "scripts").rename(project / "tools")  # git mv scripts tools
        ctx = context_of(run_hook(project, "Bash", "git mv scripts tools"))
        assert ".claude/rules/api.md" in ctx
        assert "scripts/drift.py" in ctx

    def test_git_rm_fires(self, project):
        write(project, "CLAUDE.md", "See `docs/spec.md`.\n")
        write(project, "docs/spec.md", "x\n")
        (project / "docs" / "spec.md").unlink()
        ctx = context_of(run_hook(project, "Bash", "git rm docs/spec.md"))
        assert "docs/spec.md" in ctx

    def test_powershell_remove_item_fires(self, project):
        write(project, "CLAUDE.md", "The agent reads `references/legacy.md`.\n")
        write(project, "references/legacy.md", "x\n")
        (project / "references" / "legacy.md").unlink()
        ctx = context_of(run_hook(project, "PowerShell", r"Remove-Item -Force .\references\legacy.md"))
        assert "references/legacy.md" in ctx

    def test_compound_command_destructive_part_parsed(self, project):
        write(project, "CLAUDE.md", "Style: `docs/style.md`.\n")
        write(project, "docs/style.md", "x\n")
        (project / "docs" / "style.md").unlink()
        ctx = context_of(run_hook(project, "Bash", "echo cleaning && rm docs/style.md"))
        assert "docs/style.md" in ctx

    def test_reports_line_number(self, project):
        write(project, "CLAUDE.md", "# Title\n\nfiller\n\nSee `scripts/old.py` here.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        ctx = context_of(run_hook(project, "Bash", "rm scripts/old.py"))
        assert "CLAUDE.md:5" in ctx  # the ref is on line 5


# ---------------------------------------------------------------------------
# Command shapes — prefixes, flags, and the deliberate git base-change bail
# ---------------------------------------------------------------------------

class TestCommandShapes:
    def _gone_cited(self, project):
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()

    def test_sudo_prefix(self, project):
        self._gone_cited(project)
        assert context_of(run_hook(project, "Bash", "sudo rm scripts/old.py")) != ""

    def test_env_var_prefix(self, project):
        self._gone_cited(project)
        assert context_of(run_hook(project, "Bash", "FOO=bar rm scripts/old.py")) != ""

    def test_env_wrapper_prefix(self, project):
        self._gone_cited(project)
        assert context_of(run_hook(project, "Bash", "env FOO=bar rm scripts/old.py")) != ""

    def test_flags_after_git_verb(self, project):
        self._gone_cited(project)
        assert context_of(run_hook(project, "Bash", "git rm -f scripts/old.py")) != ""

    def test_git_dash_C_bails_safely(self, project):
        """git -C relocates the base a path resolves against; we deliberately bail
        rather than resolve against the wrong cwd (prefer a miss to a false alarm)."""
        self._gone_cited(project)
        assert context_of(run_hook(project, "Bash", "git -C scripts rm old.py")) == ""


# ---------------------------------------------------------------------------
# Silent — no false alarms
# ---------------------------------------------------------------------------

class TestSilent:
    def test_path_still_exists(self, project):
        """Command claimed a delete but the path is still on disk (no-op / copy)."""
        write(project, "CLAUDE.md", "Keeper `scripts/keep.py`.\n")
        write(project, "scripts/keep.py", "x\n")  # NOT removed
        assert context_of(run_hook(project, "Bash", "rm scripts/keep.py")) == ""

    def test_uncited_deletion(self, project):
        write(project, "CLAUDE.md", "Nothing references the build dir.\n")
        write(project, "build/artifact.bin", "x\n")
        (project / "build" / "artifact.bin").unlink()
        assert context_of(run_hook(project, "Bash", "rm build/artifact.bin")) == ""

    def test_non_watched_tool(self, project):
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        assert context_of(run_hook(project, "Read", "rm scripts/old.py")) == ""

    def test_non_destructive_command(self, project):
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        # cat of a missing file references it but removes nothing -> not destructive.
        assert context_of(run_hook(project, "Bash", "cat scripts/old.py")) == ""

    def test_move_does_not_flag_destination(self, project):
        write(project, "CLAUDE.md", "See `docs/old.md` and `docs/new.md`.\n")
        write(project, "docs/old.md", "x\n")
        (project / "docs" / "old.md").rename(project / "docs" / "new.md")
        ctx = context_of(run_hook(project, "Bash", "mv docs/old.md docs/new.md"))
        assert "docs/old.md" in ctx          # vanished source flagged
        assert "docs/new.md" not in ctx      # surviving destination not flagged

    def test_glob_argument_skipped(self, project):
        """A globbed delete can't be resolved to concrete paths -> conservative skip."""
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        assert context_of(run_hook(project, "Bash", "rm scripts/*.py")) == ""

    def test_deletion_outside_project_tree(self, project):
        write(project, "CLAUDE.md", "Local only.\n")
        # An absolute path outside the project: nothing in-tree cites it.
        assert context_of(run_hook(project, "Bash", "rm /tmp/nonexistent-xyz.txt")) == ""


# ---------------------------------------------------------------------------
# Throttle — identical alarm suppressed, different alarm allowed
# ---------------------------------------------------------------------------

class TestThrottle:
    def test_identical_alarm_suppressed_second_time(self, project):
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        first = context_of(run_hook(project, "Bash", "rm scripts/old.py"))
        second = context_of(run_hook(project, "Bash", "rm scripts/old.py"))
        assert first != ""
        assert second == ""

    def test_different_alarm_still_fires(self, project):
        write(project, "CLAUDE.md", "See `a/one.py` and `b/two.py`.\n")
        write(project, "a/one.py", "x\n")
        write(project, "b/two.py", "x\n")
        (project / "a" / "one.py").unlink()
        assert context_of(run_hook(project, "Bash", "rm a/one.py")) != ""
        (project / "b" / "two.py").unlink()
        assert context_of(run_hook(project, "Bash", "rm b/two.py")) != ""


# ---------------------------------------------------------------------------
# JSON contract + robustness — never crash
# ---------------------------------------------------------------------------

class TestContractAndRobustness:
    def test_json_contract(self, project):
        write(project, "CLAUDE.md", "See `scripts/old.py`.\n")
        write(project, "scripts/old.py", "x\n")
        (project / "scripts" / "old.py").unlink()
        r = run_hook(project, "Bash", "rm scripts/old.py")
        payload = json.loads(r.stdout)
        hso = payload["hookSpecificOutput"]
        assert hso["hookEventName"] == "PostToolUse"
        assert isinstance(hso["additionalContext"], str) and hso["additionalContext"]

    def test_empty_stdin_does_not_crash(self, project):
        r = subprocess.run([PYTHON, str(HOOK)], input="", capture_output=True,
                           text=True, timeout=30, encoding="utf-8")
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_malformed_stdin_does_not_crash(self, project):
        r = subprocess.run([PYTHON, str(HOOK)], input="not json {{{", capture_output=True,
                           text=True, timeout=30, encoding="utf-8")
        assert r.returncode == 0

    def test_missing_command_does_not_crash(self, project):
        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash"})
        r = subprocess.run([PYTHON, str(HOOK)], input=payload, capture_output=True,
                           text=True, timeout=30, encoding="utf-8")
        assert r.returncode == 0
        assert r.stdout.strip() == ""
