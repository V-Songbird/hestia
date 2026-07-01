'use strict';

// Tests for refs.js — path reference extraction and resolution.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const refs = require('../scripts/refs');
const { makeTmpProject } = require('./helpers');

// ---------------------------------------------------------------------------
// looksLikePath (module-private _looks_like_path in the Python original;
// refs.js does not export it, so we exercise it via extractRefs instead).
// ---------------------------------------------------------------------------

describe('looksLikePath (via extractRefs)', () => {
  it('dot-slash prefix', () => {
    assert.deepEqual(refs.extractRefs('`./src/foo.ts`'), ['./src/foo.ts']);
  });

  it('dotdot-slash prefix', () => {
    assert.deepEqual(refs.extractRefs('`../lib/bar.py`'), ['../lib/bar.py']);
  });

  it('.claude/ prefix', () => {
    assert.deepEqual(refs.extractRefs('`.claude/rules/api.md`'), ['.claude/rules/api.md']);
  });

  it('slash with extension', () => {
    assert.deepEqual(refs.extractRefs('`knowledge/sdk/ReadAction.kt`'), ['knowledge/sdk/ReadAction.kt']);
  });

  it('http url ignored', () => {
    assert.deepEqual(refs.extractRefs('`https://example.com/foo.js`'), []);
  });

  it('template placeholder ignored', () => {
    assert.deepEqual(refs.extractRefs('`references/<file>.md`'), []);
  });

  it('bare word ignored', () => {
    assert.deepEqual(refs.extractRefs('`just-a-word`'), []);
  });

  it('prose ellipsis with slash ignored', () => {
    assert.deepEqual(refs.extractRefs('`.../tasks/GenerateLexerTask.kt`'), []);
  });

  it('prose ellipsis bare ignored', () => {
    assert.deepEqual(refs.extractRefs('`...foo/bar.kt`'), []);
  });

  it('double-dot without slash is a real relative path, not prose', () => {
    assert.deepEqual(refs.extractRefs('`../foo/bar.kt`'), ['../foo/bar.kt']);
  });
});

// ---------------------------------------------------------------------------
// resolve — Class 1: ./knowledge/... from a skill subdir
// ---------------------------------------------------------------------------

describe('resolve knowledge path from skill dir', () => {
  // prepare skill writes ./knowledge/<lib>/... into skill SKILL.md files.
  // Those files live at .claude/skills/<domain>/<skill>/SKILL.md.
  // The scanner must find <root>/knowledge/<lib>/... via root-relative fallback.

  it('dot-slash knowledge finds root-relative', () => {
    const root = makeTmpProject();
    const knowledgeFile = path.join(root, 'knowledge', 'sdk', 'File.kt');
    fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
    fs.writeFileSync(knowledgeFile, '// content', 'utf-8');

    const skillDir = path.join(root, '.claude', 'skills', 'domain', 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '→ `./knowledge/sdk/File.kt:10` (the contract)\n', 'utf-8');

    const broken = refs.brokenRefs(skillFile, root);
    assert.deepEqual(broken, []);
  });

  it('dot-slash genuinely missing still flagged', () => {
    const root = makeTmpProject();
    const skillDir = path.join(root, '.claude', 'skills', 'domain', 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '→ `./knowledge/sdk/NoSuchFile.kt:10`\n', 'utf-8');

    const broken = refs.brokenRefs(skillFile, root);
    assert.ok(broken.includes('./knowledge/sdk/NoSuchFile.kt:10'));
  });

  it('bare knowledge path resolves from root', () => {
    // prepare now writes bare knowledge/... — verify it resolves
    const root = makeTmpProject();
    const knowledgeFile = path.join(root, 'knowledge', 'sdk', 'File.kt');
    fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
    fs.writeFileSync(knowledgeFile, '// content', 'utf-8');

    const skillDir = path.join(root, '.claude', 'skills', 'domain', 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '→ `knowledge/sdk/File.kt:10` (the contract)\n', 'utf-8');

    const broken = refs.brokenRefs(skillFile, root);
    assert.deepEqual(broken, []);
  });
});

// ---------------------------------------------------------------------------
// resolve — Class 2: bare references/xxx.md inside skill subdir
// ---------------------------------------------------------------------------

describe('resolve references in skill dir', () => {
  // Skill SKILL.md files cite references/commands.md (file-relative).
  // The scanner must find <skill_dir>/references/commands.md via the
  // file-relative fallback when root-relative lookup fails.

  it('bare references path finds file-relative', () => {
    const root = makeTmpProject();
    const skillDir = path.join(root, '.claude', 'skills', 'rathena-scripting');
    const refsDir = path.join(skillDir, 'references');
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(refsDir, 'commands.md'), '# Commands\n', 'utf-8');

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, 'See `references/commands.md` for the full list.\n', 'utf-8');

    const broken = refs.brokenRefs(skillFile, root);
    assert.deepEqual(broken, []);
  });

  it('bare references path missing everywhere flagged', () => {
    const root = makeTmpProject();
    const skillDir = path.join(root, '.claude', 'skills', 'rathena-scripting');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, 'See `references/no-such-file.md` for the full list.\n', 'utf-8');

    const broken = refs.brokenRefs(skillFile, root);
    assert.ok(broken.includes('references/no-such-file.md'));
  });

  it('root-relative bare path still works', () => {
    // A bare path that exists at the root should still resolve correctly
    const root = makeTmpProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n', 'utf-8');
    const ruleDir = path.join(root, '.claude', 'rules');
    fs.mkdirSync(ruleDir, { recursive: true });
    const ruleFile = path.join(ruleDir, 'style.md');
    fs.writeFileSync(ruleFile, 'See `CLAUDE.md` for context.\n', 'utf-8');

    const broken = refs.brokenRefs(ruleFile, root);
    assert.deepEqual(broken, []);
  });
});

// ---------------------------------------------------------------------------
// resolve — Class 3: prose ellipsis not flagged
// ---------------------------------------------------------------------------

describe('prose ellipsis not flagged', () => {
  it('ellipsis path not extracted', () => {
    const root = makeTmpProject();
    const ruleFile = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(ruleFile, 'See `.../tasks/GenerateLexerTask.kt` for the pattern.\n', 'utf-8');

    const extracted = refs.extractRefs(fs.readFileSync(ruleFile, 'utf-8'));
    assert.ok(!extracted.some((r) => r.includes('...')), `Ellipsis ref leaked: ${extracted}`);
  });

  it('ellipsis path not broken', () => {
    const root = makeTmpProject();
    const ruleFile = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(ruleFile, 'See `.../tasks/GenerateLexerTask.kt` for the pattern.\n', 'utf-8');

    const broken = refs.brokenRefs(ruleFile, root);
    assert.deepEqual(broken, []);
  });
});

// ---------------------------------------------------------------------------
// resolve — existing correct behaviours preserved
// ---------------------------------------------------------------------------

describe('existing behaviour preserved', () => {
  it('dot-slash file-relative when exists', () => {
    // ./README.md exists file-relatively — should resolve correctly
    const root = makeTmpProject();
    fs.writeFileSync(path.join(root, 'README.md'), '# readme\n', 'utf-8');
    const ruleFile = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(ruleFile, 'See `./README.md`.\n', 'utf-8');

    const broken = refs.brokenRefs(ruleFile, root);
    assert.deepEqual(broken, []);
  });

  it('@import resolved', () => {
    const root = makeTmpProject();
    const target = path.join(root, 'docs', 'style.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# style\n', 'utf-8');
    const ruleFile = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(ruleFile, 'See @docs/style.md.\n', 'utf-8');

    const broken = refs.brokenRefs(ruleFile, root);
    assert.deepEqual(broken, []);
  });

  it('missing ref flagged', () => {
    const root = makeTmpProject();
    const ruleFile = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(ruleFile, 'See `./no-such-file.md`.\n', 'utf-8');

    const broken = refs.brokenRefs(ruleFile, root);
    assert.ok(broken.length > 0);
  });
});
