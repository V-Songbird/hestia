"""Tests for drift.py --check — the CI drift gate (exit non-zero on stale refs)."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "drift.py"
PYTHON = sys.executable


def run(project, *flags) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [PYTHON, str(SCRIPT), "--project-root", str(project), *flags],
        capture_output=True, text=True, encoding="utf-8", env=env, timeout=30,
    )


@pytest.fixture
def project(tmp_path):
    p = tmp_path / "proj"
    p.mkdir()
    return p


def test_clean_exits_zero(project):
    (project / "CLAUDE.md").write_text("No file references here.\n", encoding="utf-8")
    assert run(project, "--check").returncode == 0


def test_dead_ref_exits_nonzero(project):
    (project / "CLAUDE.md").write_text("Run the scan in `scripts/gone.py`.\n", encoding="utf-8")
    assert run(project, "--check").returncode == 1


def test_check_is_opt_in(project):
    """Without --check, a plain scan exits 0 even when drift exists."""
    (project / "CLAUDE.md").write_text("Run the scan in `scripts/gone.py`.\n", encoding="utf-8")
    assert run(project).returncode == 0
