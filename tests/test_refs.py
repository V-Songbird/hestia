"""Tests for refs.py — path reference extraction and resolution."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import refs as refs_mod


# ---------------------------------------------------------------------------
# _looks_like_path
# ---------------------------------------------------------------------------

class TestLooksLikePath:
    def test_dot_slash_prefix(self):
        assert refs_mod._looks_like_path("./src/foo.ts")

    def test_dotdot_slash_prefix(self):
        assert refs_mod._looks_like_path("../lib/bar.py")

    def test_dotclaude_prefix(self):
        assert refs_mod._looks_like_path(".claude/rules/api.md")

    def test_slash_with_extension(self):
        assert refs_mod._looks_like_path("knowledge/sdk/ReadAction.kt")

    def test_http_url_ignored(self):
        assert not refs_mod._looks_like_path("https://example.com/foo.js")

    def test_template_placeholder_ignored(self):
        assert not refs_mod._looks_like_path("references/<file>.md")

    def test_bare_word_ignored(self):
        assert not refs_mod._looks_like_path("just-a-word")

    # Class 3 — prose ellipsis
    def test_prose_ellipsis_with_slash_ignored(self):
        assert not refs_mod._looks_like_path(".../tasks/GenerateLexerTask.kt")

    def test_prose_ellipsis_bare_ignored(self):
        assert not refs_mod._looks_like_path("...foo/bar.kt")

    def test_double_dot_without_slash_not_prose(self):
        # ../foo is a real relative path, not prose
        assert refs_mod._looks_like_path("../foo/bar.kt")


# ---------------------------------------------------------------------------
# resolve — Class 1: ./knowledge/... from a skill subdir
# ---------------------------------------------------------------------------

class TestResolveKnowledgePathFromSkillDir:
    """prepare skill writes ./knowledge/<lib>/... into skill SKILL.md files.
    Those files live at .claude/skills/<domain>/<skill>/SKILL.md.
    The scanner must find <root>/knowledge/<lib>/... via root-relative fallback.
    """

    def test_dot_slash_knowledge_finds_root_relative(self, tmp_path):
        # Arrange: project root has knowledge/sdk/File.kt
        knowledge_file = tmp_path / "knowledge" / "sdk" / "File.kt"
        knowledge_file.parent.mkdir(parents=True)
        knowledge_file.write_text("// content", encoding="utf-8")

        # Skill file lives at .claude/skills/domain/skill/SKILL.md
        skill_dir = tmp_path / ".claude" / "skills" / "domain" / "skill"
        skill_dir.mkdir(parents=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "→ `./knowledge/sdk/File.kt:10` (the contract)\n",
            encoding="utf-8",
        )

        broken = refs_mod.broken_refs(skill_file, tmp_path)
        assert broken == [], f"Expected no broken refs, got: {broken}"

    def test_dot_slash_genuinely_missing_still_flagged(self, tmp_path):
        skill_dir = tmp_path / ".claude" / "skills" / "domain" / "skill"
        skill_dir.mkdir(parents=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "→ `./knowledge/sdk/NoSuchFile.kt:10`\n",
            encoding="utf-8",
        )
        broken = refs_mod.broken_refs(skill_file, tmp_path)
        assert "./knowledge/sdk/NoSuchFile.kt:10" in broken

    def test_bare_knowledge_path_resolves_from_root(self, tmp_path):
        # prepare now writes bare knowledge/... — verify it resolves
        knowledge_file = tmp_path / "knowledge" / "sdk" / "File.kt"
        knowledge_file.parent.mkdir(parents=True)
        knowledge_file.write_text("// content", encoding="utf-8")

        skill_dir = tmp_path / ".claude" / "skills" / "domain" / "skill"
        skill_dir.mkdir(parents=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "→ `knowledge/sdk/File.kt:10` (the contract)\n",
            encoding="utf-8",
        )

        broken = refs_mod.broken_refs(skill_file, tmp_path)
        assert broken == [], f"Expected no broken refs, got: {broken}"


# ---------------------------------------------------------------------------
# resolve — Class 2: bare references/xxx.md inside skill subdir
# ---------------------------------------------------------------------------

class TestResolveReferencesInSkillDir:
    """Skill SKILL.md files cite references/commands.md (file-relative).
    The scanner must find <skill_dir>/references/commands.md via the
    file-relative fallback when root-relative lookup fails.
    """

    def test_bare_references_path_finds_file_relative(self, tmp_path):
        skill_dir = tmp_path / ".claude" / "skills" / "rathena-scripting"
        refs_dir = skill_dir / "references"
        refs_dir.mkdir(parents=True)
        (refs_dir / "commands.md").write_text("# Commands\n", encoding="utf-8")

        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "See `references/commands.md` for the full list.\n",
            encoding="utf-8",
        )

        broken = refs_mod.broken_refs(skill_file, tmp_path)
        assert broken == [], f"Expected no broken refs, got: {broken}"

    def test_bare_references_path_missing_everywhere_flagged(self, tmp_path):
        skill_dir = tmp_path / ".claude" / "skills" / "rathena-scripting"
        skill_dir.mkdir(parents=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(
            "See `references/no-such-file.md` for the full list.\n",
            encoding="utf-8",
        )

        broken = refs_mod.broken_refs(skill_file, tmp_path)
        assert "references/no-such-file.md" in broken

    def test_root_relative_bare_path_still_works(self, tmp_path):
        # A bare path that exists at the root should still resolve correctly
        (tmp_path / "CLAUDE.md").write_text("# root\n", encoding="utf-8")
        rule_dir = tmp_path / ".claude" / "rules"
        rule_dir.mkdir(parents=True)
        rule_file = rule_dir / "style.md"
        rule_file.write_text(
            "See `CLAUDE.md` for context.\n",
            encoding="utf-8",
        )

        broken = refs_mod.broken_refs(rule_file, tmp_path)
        assert broken == [], f"Expected no broken refs, got: {broken}"


# ---------------------------------------------------------------------------
# resolve — Class 3: prose ellipsis not flagged
# ---------------------------------------------------------------------------

class TestProseEllipsisNotFlagged:
    def test_ellipsis_path_not_extracted(self, tmp_path):
        rule_file = tmp_path / "CLAUDE.md"
        rule_file.write_text(
            "See `.../tasks/GenerateLexerTask.kt` for the pattern.\n",
            encoding="utf-8",
        )
        # extract_refs should not include the ellipsis token
        refs = refs_mod.extract_refs(rule_file.read_text(encoding="utf-8"))
        assert not any("..." in r for r in refs), f"Ellipsis ref leaked: {refs}"

    def test_ellipsis_path_not_broken(self, tmp_path):
        rule_file = tmp_path / "CLAUDE.md"
        rule_file.write_text(
            "See `.../tasks/GenerateLexerTask.kt` for the pattern.\n",
            encoding="utf-8",
        )
        broken = refs_mod.broken_refs(rule_file, tmp_path)
        assert broken == [], f"Expected no broken refs, got: {broken}"


# ---------------------------------------------------------------------------
# resolve — existing correct behaviours preserved
# ---------------------------------------------------------------------------

class TestExistingBehaviourPreserved:
    def test_dot_slash_file_relative_when_exists(self, tmp_path):
        # ./README.md exists file-relatively — should resolve correctly
        readme = tmp_path / "README.md"
        readme.write_text("# readme\n", encoding="utf-8")
        rule_file = tmp_path / "CLAUDE.md"
        rule_file.write_text("See `./README.md`.\n", encoding="utf-8")
        broken = refs_mod.broken_refs(rule_file, tmp_path)
        assert broken == []

    def test_at_import_resolved(self, tmp_path):
        target = tmp_path / "docs" / "style.md"
        target.parent.mkdir()
        target.write_text("# style\n", encoding="utf-8")
        rule_file = tmp_path / "CLAUDE.md"
        rule_file.write_text("See @docs/style.md.\n", encoding="utf-8")
        broken = refs_mod.broken_refs(rule_file, tmp_path)
        assert broken == []

    def test_missing_ref_flagged(self, tmp_path):
        rule_file = tmp_path / "CLAUDE.md"
        rule_file.write_text("See `./no-such-file.md`.\n", encoding="utf-8")
        broken = refs_mod.broken_refs(rule_file, tmp_path)
        assert broken  # should be flagged
