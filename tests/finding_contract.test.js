'use strict';

// Tests for the FINDING CONTRACT (Phase 1 epistemics upgrade).
//
// Covers the four parts of the contract:
//   A. Cite-or-drop — a normal finding requires a `file` locator; a locator-less
//      claim must go through the advisory bucket or not be emitted at all.
//   B. Triple-shape — every finding carries symptom / why / fix_action.
//   C. Honest limits — checkup and drift always emit a `limits` section, and
//      empty results are stated explicitly (never silent).
//   D. Counted facts, no counterfactual — no API emits a counterfactual % impact.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runScript, makeSampleProject } = require('./helpers');
const _lib = require('../scripts/_lib');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SAMPLE_PROJECT = path.join(FIXTURES_DIR, 'sample_project');

// ---------------------------------------------------------------------------
// Part A — Cite-or-drop
// ---------------------------------------------------------------------------

describe('CiteOrDrop', () => {
  it('cited() refuses an empty file locator', () => {
    assert.throws(() => {
      _lib.Finding.cited({
        severity: 'high', artifact: 'rule',
        symptom: 's', why: 'w', fixAction: 'f', file: '',
      });
    });
  });

  it('bare constructor drops a locator-less finding', () => {
    assert.throws(() => {
      new _lib.Finding({ severity: 'low', artifact: 'rule', symptom: 'ungrounded' });
    });
  });

  it('cited() with file succeeds', () => {
    const f = _lib.Finding.cited({
      severity: 'high', artifact: 'rule',
      symptom: 's', why: 'w', fixAction: 'f', file: 'CLAUDE.md', line: 12,
    });
    assert.equal(f.file, 'CLAUDE.md');
    assert.equal(f.location, 'CLAUDE.md:12');
    assert.equal(f.advisory, false);
  });

  it('a file-level finding has no line — locator still satisfied', () => {
    const f = _lib.Finding.cited({
      severity: 'medium', artifact: 'claude-md',
      symptom: 'too long', why: 'w', fixAction: 'f', file: 'CLAUDE.md',
    });
    assert.equal(f.line, null);
    assert.equal(f.location, 'CLAUDE.md');
  });

  it('advisory is the only locator-less path', () => {
    const a = _lib.Finding.advisoryNote({
      severity: 'low', artifact: 'rule', symptom: 'unverified hunch',
    });
    assert.equal(a.advisory, true);
    assert.equal(a.file, '');
    assert.equal(a.location, '');
  });

  it('advisory is flagged in the dict', () => {
    const a = _lib.Finding.advisoryNote({ severity: 'low', artifact: 'rule', symptom: 'x' });
    assert.equal(a.toDict().advisory, true);
  });

  it('checkup findings all carry a locator', () => {
    const out = runScript('checkup.js', null, ['--project-root', makeSampleProject()]);
    for (const f of out.findings) {
      assert.ok(f.file, `finding has no file locator: ${JSON.stringify(f)}`);
      assert.ok(f.location, `finding has no location: ${JSON.stringify(f)}`);
      assert.equal(f.advisory, false);
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — Triple-shape
// ---------------------------------------------------------------------------

function runCheckupOnBrokenProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-broken-'));
  fs.mkdirSync(path.join(base, '.git'));
  fs.writeFileSync(
    path.join(base, 'CLAUDE.md'),
    '# P\n\nSee `./docs/gone.md`.\nRead @./missing.md first.\n',
    'utf-8'
  );
  const agents = path.join(base, '.claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'bad.md'), 'no frontmatter here\njust prose\n', 'utf-8');
  return runScript('checkup.js', null, ['--project-root', base]);
}

describe('TripleShape', () => {
  it('dict carries all three', () => {
    const f = _lib.Finding.cited({
      severity: 'high', artifact: 'rule',
      symptom: 'weak verb', why: "claude can't tell command from suggestion",
      fixAction: 'start with a clear action verb', file: 'CLAUDE.md', line: 3,
    });
    const d = f.toDict();
    assert.equal(d.symptom, 'weak verb');
    assert.ok(d.why);
    assert.ok(d.fix_action);
  });

  it('checkup findings are triple-shaped (no bare wrong)', () => {
    const out = runCheckupOnBrokenProject();
    assert.ok(out.findings.length, 'expected at least one finding');
    for (const f of out.findings) {
      assert.ok(f.symptom, `missing symptom: ${JSON.stringify(f)}`);
      assert.ok(f.why, `missing why (rationale): ${JSON.stringify(f)}`);
      assert.ok(f.fix_action, `missing fix_action (corrective action): ${JSON.stringify(f)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Part C — Honest limits
// ---------------------------------------------------------------------------

describe('HonestLimits', () => {
  it('limit_note shape', () => {
    const n = _lib.limitNote('freshness', 'no stale refs', 'prose not checked');
    assert.equal(n.scope, 'freshness');
    assert.equal(n.detail, 'no stale refs');
    assert.equal(n.residual_risk, 'prose not checked');
  });

  it('limit_note omits empty residual_risk', () => {
    const n = _lib.limitNote('scope', 'read-only scan');
    assert.ok(!('residual_risk' in n));
  });

  it('checkup always emits limits', () => {
    const out = runScript('checkup.js', null, ['--project-root', makeSampleProject()]);
    assert.ok('limits' in out);
    assert.ok(out.limits.length >= 1);
    for (const n of out.limits) {
      assert.ok(n.detail);
    }
  });

  it('drift always emits limits', () => {
    const out = runScript('drift.js', null, ['--project-root', SAMPLE_PROJECT]);
    assert.ok('limits' in out);
    assert.ok(out.limits.length >= 1);
  });

  it('drift states an empty result explicitly (never silence)', () => {
    const out = runScript('drift.js', null, ['--project-root', SAMPLE_PROJECT]);
    assert.deepEqual(out.stale_files, []);
    const details = out.limits.map((n) => n.detail || '').join(' ').toLowerCase();
    assert.ok(details.includes('no stale references found'));
  });
});

// ---------------------------------------------------------------------------
// Part D — Counted facts, no counterfactual
// ---------------------------------------------------------------------------

describe('NoCounterfactual', () => {
  it('_lib has no counterfactual emitter', () => {
    const names = Object.keys(_lib).map((n) => n.toLowerCase());
    for (const n of names) {
      assert.ok(!n.includes('improvement_pct'));
      assert.ok(!n.includes('impact_pct'));
      assert.ok(!n.includes('counterfactual'));
    }
  });

  it('checkup counts are plain tallies', () => {
    const out = runScript('checkup.js', null, ['--project-root', makeSampleProject()]);
    assert.deepEqual(new Set(Object.keys(out.counts)), new Set(['high', 'medium', 'low', 'info']));
    for (const v of Object.values(out.counts)) {
      assert.equal(Number.isInteger(v), true);
    }
  });
});
