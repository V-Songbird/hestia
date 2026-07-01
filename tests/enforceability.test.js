'use strict';

// Tests for the enforceability classifier — the "folklore check" (feature #1).
//
// The classifier (scripts/enforceability.js) assigns each rule one of three
// classes by HOW a violation could be detected:
//
//   - enforceable — a hook / linter / test / build gate could mechanically catch it
//   - observable  — Claude can self-check it at edit time (concrete construct + verb)
//   - folklore    — an unverifiable quality word with no checkable referent
//
// Contract checks:
//   * Known examples classify correctly (enforceable / observable / folklore).
//   * Conservative tie-breaking: ambiguous -> observable, never folklore.
//   * Folklore requires a quality-word evidence token (evidence-driven).
//   * Folklore rules surface as cited triple-shape findings (Phase-1 contract).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const enf = require('../scripts/enforceability');
const compose = require('../scripts/compose');

function classify(text, ruleFields) {
  const rule = { text, ...(ruleFields || {}) };
  return enf.classifyRule(rule);
}

// ---------------------------------------------------------------------------
// Enforceable — names a runnable check / command / threshold / gate
// ---------------------------------------------------------------------------

describe('TestEnforceable', () => {
  const cases = [
    'Run `npm test` before committing.',
    'Coverage must be >= 80%.',
    'Ensure no TypeScript errors exist before pushing.',
    'Run prettier on modified files before committing.',
    'All tests pass in CI before merge.',
    'Run `tsc --noEmit` before pushing.',
  ];
  for (const text of cases) {
    it(`classifies as enforceable: ${text}`, () => {
      const r = classify(text);
      assert.equal(r.class, 'enforceable', JSON.stringify({ text, r }));
    });
  }

  it('records evidence', () => {
    const r = classify('Coverage must be >= 80%.');
    assert.ok(r.evidence.length, 'enforceable verdict must record its evidence token(s)');
  });

  it('command backtick drives enforceable', () => {
    const r = classify('Run `eslint --max-warnings 0` on staged files.');
    assert.equal(r.class, 'enforceable');
    assert.ok(r.evidence.some((e) => e.includes('eslint')));
  });

  it('F8 low ceiling corroborates', () => {
    // A rule scored fully-enforceable by F8 (rubric_F8.md Level 0/1) is
    // enforceable even without an explicit command phrase in the text.
    const r = classify('Files in the generated directory stay untouched.', {
      factors: { F8: { value: 0.15 } },
    });
    assert.equal(r.class, 'enforceable');
    assert.ok(r.evidence.some((e) => e.startsWith('F8=')));
  });
});

// ---------------------------------------------------------------------------
// Observable — concrete construct + directive verb, but no external check
// ---------------------------------------------------------------------------

describe('TestObservable', () => {
  const cases = [
    'Use named exports for top-level modules.',
    'Put tests next to source.',
    'Use functional components for all new React files.',
    'Validate request bodies at the handler boundary using Zod.',
    'Place the migration in `src/db/migrations`.',
  ];
  for (const text of cases) {
    it(`classifies as observable: ${text}`, () => {
      const r = classify(text);
      assert.equal(r.class, 'observable', JSON.stringify({ text, r }));
    });
  }
});

// ---------------------------------------------------------------------------
// Folklore — unverifiable quality word, no checkable referent
// ---------------------------------------------------------------------------

describe('TestFolklore', () => {
  const cases = [
    'Always write clean, maintainable code.',
    'Handle errors properly.',
    'Write robust, sensible code.',
    'Keep functions small and readable.',
    'Use appropriate naming.',
    'Write good code.',
  ];
  for (const text of cases) {
    it(`classifies as folklore: ${text}`, () => {
      const r = classify(text);
      assert.equal(r.class, 'folklore', JSON.stringify({ text, r }));
    });
  }

  it('folklore requires quality-word evidence', () => {
    // Evidence-driven: a folklore verdict always carries the quality
    // word(s) that drove it — no folklore without an evidence token.
    const r = classify('Handle errors properly.');
    assert.equal(r.class, 'folklore');
    assert.ok(r.evidence.length, 'folklore must record the quality-word evidence');
    assert.ok(r.quality_words.length, 'folklore must name the unverifiable word(s)');
    assert.ok(r.quality_words.includes('properly'));
  });
});

// ---------------------------------------------------------------------------
// Conservative tie-breaking — ambiguous -> observable, never folklore
// ---------------------------------------------------------------------------

describe('TestConservative', () => {
  it('quality word plus concrete is observable not folklore', () => {
    // A quality word AND a concrete construct -> observable. A single
    // checkable referent is enough to make the rule self-checkable.
    const r = classify('Keep `UserService` clean and small.');
    assert.equal(r.class, 'observable', JSON.stringify(r));
    // The quality word is still recorded, but it did not drive a folklore
    // verdict because a concrete construct is present.
    assert.ok(r.quality_words.includes('clean'));
    assert.ok(r.concrete_markers.length);
  });

  it('no signal rule is observable not folklore', () => {
    // A rule with neither a quality word nor a concrete construct is left
    // observable (the safe default) — we never over-flag as folklore.
    const r = classify('Prefer composition.');
    assert.equal(r.class, 'observable', JSON.stringify(r));
  });

  it('folklore never emitted without quality word', () => {
    // No input without a matched quality word can be classed folklore.
    for (const text of ['Use the helper.', 'Add the field.', 'Prefer composition.']) {
      const r = classify(text);
      assert.notEqual(r.class, 'folklore', JSON.stringify({ text, r }));
    }
  });
});

// ---------------------------------------------------------------------------
// Folklore findings — cited triple-shape (Phase-1 Finding contract)
// ---------------------------------------------------------------------------

describe('TestFolkloreFindings', () => {
  function rules() {
    const rs = [
      { id: 'R1', text: 'Always write clean, maintainable code.', file: 'CLAUDE.md', line_start: 3 },
      { id: 'R2', text: 'Run `npm test` before committing.', file: 'CLAUDE.md', line_start: 5 },
      { id: 'R3', text: 'Use named exports for top-level modules.', file: 'CLAUDE.md', line_start: 7 },
    ];
    enf.classifyRules(rs);
    return rs;
  }

  it('only folklore rules become findings', () => {
    const findings = compose.buildFolkloreFindings(rules());
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule_id, 'R1');
  });

  it('findings are cited', () => {
    // Cite-or-drop: every folklore finding carries a file:line locator.
    const f = compose.buildFolkloreFindings(rules())[0];
    assert.equal(f.file, 'CLAUDE.md');
    assert.equal(f.location, 'CLAUDE.md:3');
    assert.equal(f.advisory, false);
  });

  it('findings are triple-shaped', () => {
    // symptom / why / fix_action all present (no bare 'this is wrong').
    const f = compose.buildFolkloreFindings(rules())[0];
    assert.equal(f.symptom, "rule can't be enforced or self-checked");
    assert.ok(f.why.includes('noise'));
    assert.ok(f.fix_action.includes('checkable condition'));
  });

  it('findings carry evidence word', () => {
    // The unverifiable word(s) ride along as evidence (in tags + inline).
    const f = compose.buildFolkloreFindings(rules())[0];
    assert.ok(f.tags.some((t) => t.startsWith('quality-word:')));
    assert.ok(f.tags.includes('folklore'));
    assert.ok(f.quality_words.length);
  });

  it('locatorless folklore rule is dropped', () => {
    // A folklore rule with no file is dropped, not emitted locator-less.
    const rs = [{ id: 'R9', text: 'Write clean code.', file: '', line_start: 1 }];
    enf.classifyRules(rs);
    assert.equal(rs[0].enforceability.class, 'folklore');
    assert.deepEqual(compose.buildFolkloreFindings(rs), []);
  });
});
