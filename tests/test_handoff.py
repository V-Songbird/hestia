"""Tests for handoff.py — the detect-and-route orchestration stager.

Covers the four modes (routes / stage / list / clear), routed vs unrouted
handling, the deterministic id (re-staging the same finding overwrites rather
than duplicates), the owner-grouped listing, and the team-local hookify caveat.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "handoff.py"
PYTHON = sys.executable


def run(mode: str, project=None, stdin=None) -> dict:
    args = [PYTHON, str(SCRIPT), mode]
    if project is not None:
        args += ["--project-root", str(project)]
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run(
        args,
        input=(json.dumps(stdin) if stdin is not None else None),
        capture_output=True, text=True, encoding="utf-8", env=env, timeout=30,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture
def project(tmp_path):
    p = tmp_path / "proj"
    p.mkdir()
    return p


class TestRoutes:
    def test_routes_present_and_unique(self):
        classes = [r["drift_class"] for r in run("routes")["routes"]]
        assert "claude_md_content_drift" in classes
        assert "rule_should_be_hook" in classes
        assert len(classes) == len(set(classes))  # no duplicate drift classes

    def test_every_route_has_owner_target_action(self):
        for r in run("routes")["routes"]:
            assert r["owner_plugin"] and r["target"] and r["action"], r


class TestStage:
    def test_routed_handoff_written(self, project):
        out = run("stage", project, {
            "drift_class": "claude_md_content_drift",
            "locator": "CLAUDE.md:12", "items": ["scripts/old.py gone"],
            "correct_values": ["scripts/drift.py"],
        })
        assert out["status"] == "staged"
        rec = out["record"]
        assert rec["routed"] is True
        assert rec["owner_plugin"] == "claude-md-management"
        assert rec["target"] == "claude-md-improver skill"
        assert (project / out["path"]).is_file()

    def test_unrouted_class_is_graceful(self, project):
        rec = run("stage", project, {"drift_class": "made_up", "locator": "x"})["record"]
        assert rec["routed"] is False
        assert rec["owner_plugin"] is None
        assert "surface" in rec["action"].lower()

    def test_deterministic_id_overwrites_not_duplicates(self, project):
        p = {"drift_class": "skill_internal_ref_broken", "locator": "a/SKILL.md", "items": ["r"]}
        first = run("stage", project, p)["record"]["id"]
        second = run("stage", project, p)["record"]["id"]
        assert first == second
        assert run("list", project)["count"] == 1  # identical finding did not duplicate

    def test_hook_route_surfaces_team_local_caveat(self, project):
        rec = run("stage", project, {
            "drift_class": "rule_should_be_hook", "locator": "rules/api.md", "items": ["x"],
        })["record"]
        assert rec["caveat"]  # gitignored *.local.md -> not team-shared


class TestListClear:
    def test_list_groups_by_owner(self, project):
        run("stage", project, {"drift_class": "claude_md_content_drift", "locator": "a", "items": ["1"]})
        run("stage", project, {"drift_class": "absence_gap", "locator": "b", "items": ["2"]})
        d = run("list", project)
        assert d["count"] == 2
        assert d["by_owner"]["claude-md-management"] == 1
        assert d["by_owner"]["claude-code-setup"] == 1

    def test_clear_by_id(self, project):
        rec = run("stage", project, {"drift_class": "absence_gap", "locator": "b", "items": ["2"]})["record"]
        assert run("clear", project, {"id": rec["id"]})["removed"] == 1
        assert run("list", project)["count"] == 0

    def test_clear_all(self, project):
        run("stage", project, {"drift_class": "absence_gap", "locator": "b", "items": ["2"]})
        run("stage", project, {"drift_class": "claude_md_content_drift", "locator": "a", "items": ["1"]})
        assert run("clear", project, {"all": True})["removed"] == 2
        assert run("list", project)["count"] == 0

    def test_list_empty_project(self, project):
        d = run("list", project)
        assert d["count"] == 0 and d["handoffs"] == []
