'use strict';

// Tests for compose.js — formula verification, regressions, edge cases.
//
// hestia's compose.js reads a single JSON payload from stdin. The payload has
// {rules, source_files, project_root, config}. F3/F8 factors must already be
// in rule.factors before calling compose — hestia's pipeline pipes them in
// from parse_judgment.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScript, runScriptRaw } = require('./helpers');

/** Build a minimal rule with all factors pre-populated. */
function makeRule({
  ruleId = 'R001',
  factors = null,
  category = 'mandate',
  fileIndex = 0,
  lineStart = 5,
  staleness = null,
} = {}) {
  const defaultFactors = {
    F1: { value: 0.85, method: 'lookup' },
    F2: { value: 0.85, method: 'classify' },
    F3: { value: 0.80, method: 'judgment', level: 3 },
    F4: { value: 0.95, method: 'glob_match' },
    F7: { value: 0.80, method: 'count' },
    F8: { value: 0.65, method: 'judgment', level: 2 },
  };
  if (factors) Object.assign(defaultFactors, factors);
  return {
    id: ruleId,
    file_index: fileIndex,
    text: 'Test rule.',
    line_start: lineStart,
    line_end: lineStart,
    category,
    staleness: staleness || { gated: false, missing_entities: [] },
    factors: defaultFactors,
  };
}

/** Build a minimal compose input payload. */
function makeScored(rules, sourceFiles = null) {
  return {
    project_root: '/test',
    config: { load_prob_overrides: {}, severity_overrides: {} },
    source_files: sourceFiles || [
      {
        path: 'CLAUDE.md',
        globs: [],
        glob_match_count: null,
        default_category: 'mandate',
        line_count: 50,
        always_loaded: true,
      },
    ],
    rules,
  };
}

/** Run compose.js with payload on stdin and return parsed output. */
function runCompose(payload) {
  return runScript('compose.js', payload);
}

// ---------------------------------------------------------------------------
// Per-rule formula tests
// ---------------------------------------------------------------------------

describe('TestPerRuleFormula', () => {
  test('worked example: F1=0.85, F2=0.85, F3=0.80, F4=0.95, F7=0.80 -> ~0.840; F8 is parallel signal, not composite', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.85 }, F2: { value: 0.85 },
        F3: { value: 0.80 }, F4: { value: 0.95 },
        F7: { value: 0.80 }, F8: { value: 0.65 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.ok(Math.abs(r.score - 0.840) <= 0.02, `Expected ~0.840, got ${r.score}`);
    assert.ok(Math.abs(r.pre_floor_score - 0.840) <= 0.02);
    assert.equal(r.floor, 1.0);
    assert.equal(r.f8_value, 0.65);
    assert.equal(r.is_hook_candidate, false); // 0.65 > 0.40
  });

  test('contributions should sum to approximately pre_floor_score', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    const contribSum = Object.values(r.contributions).filter((v) => v !== null).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(contribSum - r.pre_floor_score) < 0.01);
  });

  test('score between zero and one', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.ok(r.score >= 0.0 && r.score <= 1.0);
  });
});

// ---------------------------------------------------------------------------
// Soft floors
// ---------------------------------------------------------------------------

describe('TestSoftFloors', () => {
  test('soft floor F7: F7=0.10 -> floor = 0.50 (= 0.10 / 0.2)', () => {
    const rule = makeRule({ factors: { F7: { value: 0.10 } } });
    const result = runCompose(makeScored([rule]));
    assert.equal(result.rules[0].floor, 0.5);
  });

  test('soft floor F4: F4=0.05 -> floor = 0.25 (= 0.05 / 0.2)', () => {
    const rule = makeRule({ factors: { F4: { value: 0.05 } } });
    const result = runCompose(makeScored([rule]));
    assert.equal(result.rules[0].floor, 0.25);
  });

  test('staleness gate: stale entities -> floor multiplied by 0.05', () => {
    const rule = makeRule({ staleness: { gated: true, missing_entities: ['src/old/'] } });
    const result = runCompose(makeScored([rule]));
    assert.equal(result.rules[0].floor, 0.05);
  });

  test('floor smooth zero: F7=0.0 -> floor = 0.0, no NaN', () => {
    const rule = makeRule({ factors: { F7: { value: 0.0 } } });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.floor, 0.0);
    assert.equal(r.score, 0.0);
    assert.ok(!Number.isNaN(r.score));
  });
});

// ---------------------------------------------------------------------------
// Layer overlay
// ---------------------------------------------------------------------------

describe('TestLayerOverlay', () => {
  test('layer keys present', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    const layers = result.rules[0].layers;
    assert.ok('clarity' in layers);
    assert.ok('activation' in layers);
  });

  test('worked example clarity layer: clarity = weighted mean of F1/F2/F7', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.85 }, F2: { value: 0.85 },
        F3: { value: 0.80 }, F4: { value: 0.95 },
        F7: { value: 0.80 }, F8: { value: 0.65 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const layers = result.rules[0].layers;
    // clarity = (1.5*0.85 + 1.0*0.85 + 2.0*0.80) / 4.5 ≈ 0.828
    assert.ok(Math.abs(layers.clarity - 0.828) <= 0.02);
  });

  test('layer division safety: all clarity inputs at 0.0 -> clarity = 0.0, no NaN', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.0 }, F2: { value: 0.0 },
        F3: { value: 0.0 }, F4: { value: 0.0 },
        F7: { value: 0.0 }, F8: { value: 0.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const layers = result.rules[0].layers;
    assert.equal(layers.clarity, 0.0);
    assert.ok(!Number.isNaN(layers.clarity));
  });
});

// ---------------------------------------------------------------------------
// Dominant weakness
// ---------------------------------------------------------------------------

describe('TestDominantWeakness', () => {
  test('F7=0.80 is weakest composite when others are higher', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.85 }, F2: { value: 0.85 },
        F3: { value: 0.80 }, F4: { value: 0.95 },
        F7: { value: 0.80 }, F8: { value: 0.65 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.dominant_weakness, 'F7');
    assert.ok(r.dominant_weakness_gap > 0);
  });

  test('all factors at 1.0 -> dominant_weakness is null', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    assert.equal(result.rules[0].dominant_weakness, null);
  });

  test('F8 is parallel — must never appear as dominant_weakness', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 0.50 },
        F8: { value: 0.05 }, // drastically lower, but parallel
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.notEqual(r.dominant_weakness, 'F8');
    assert.equal(r.dominant_weakness, 'F7');
  });

  test('F4 at 0.85 via implicit_scope_trust cannot dominate other weak factors', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 },
        F4: {
          value: 0.85, method: 'keyword_overlap', loading: 'glob-scoped',
          trigger_match: 'implicit_scope_trust',
        },
        F7: { value: 0.90 },
        F8: { value: 0.80 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.notEqual(r.dominant_weakness, 'F4');
    assert.equal(r.dominant_weakness, 'F7');
  });

  test('F4 with explicit_mismatch remains eligible as dominant', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 },
        F4: {
          value: 0.25, method: 'wrong_scope', loading: 'glob-scoped',
          trigger_match: 'explicit_mismatch',
        },
        F7: { value: 0.90 },
        F8: { value: 0.80 },
      },
    });
    const result = runCompose(makeScored([rule]));
    assert.equal(result.rules[0].dominant_weakness, 'F4');
  });
});

// ---------------------------------------------------------------------------
// Failure class
// ---------------------------------------------------------------------------

describe('TestFailureClass', () => {
  test('F7 weakness maps to ambiguity', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.85 }, F2: { value: 0.85 },
        F3: { value: 0.80 }, F4: { value: 0.95 },
        F7: { value: 0.50 }, F8: { value: 0.65 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.dominant_weakness, 'F7');
    assert.equal(r.failure_class, 'ambiguity');
  });

  test('F3 weakness maps to drift', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 0.30 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.dominant_weakness, 'F3');
    assert.equal(r.failure_class, 'drift');
  });

  test('F4 weakness maps to drift', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 0.30 },
        F7: { value: 1.0 }, F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.dominant_weakness, 'F4');
    assert.equal(r.failure_class, 'drift');
  });

  test('perfect rule -> null failure_class', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.dominant_weakness, null);
    assert.equal(r.failure_class, null);
  });
});

// ---------------------------------------------------------------------------
// Null factor handling (degraded rules)
// ---------------------------------------------------------------------------

describe('TestNullFactorHandling', () => {
  test('null F3 excluded from score: should give a different score than F3=0.50', () => {
    const ruleWith = makeRule({ factors: { F3: { value: 0.50, level: 2 } } });
    const ruleNull = makeRule({ factors: { F3: { value: null, level: null } } });
    const rWith = runCompose(makeScored([ruleWith])).rules[0];
    const rNull = runCompose(makeScored([ruleNull])).rules[0];
    assert.notEqual(rWith.score, rNull.score);
  });

  test('degraded flag set for null factor', () => {
    const rule = makeRule({ factors: { F3: { value: null, level: null } } });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.degraded, true);
    assert.ok(r.degraded_factors.includes('F3'));
  });

  test('non-degraded rule', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.degraded, false);
    assert.deepEqual(r.degraded_factors, []);
  });

  test('null F3 not dominant weakness', () => {
    const rule = makeRule({
      factors: {
        F3: { value: null, level: null },
        F7: { value: 0.30 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.notEqual(r.dominant_weakness, 'F3');
    assert.equal(r.dominant_weakness, 'F7');
  });

  test('null factor contribution is null', () => {
    const rule = makeRule({ factors: { F3: { value: null, level: null } } });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.contributions.F3, null);
  });

  test('F8 not in contributions', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.ok(!('F8' in r.contributions));
    assert.notEqual(r.f8_value, null);
  });

  test('value: 0.0 is a legitimate score, NOT null', () => {
    const rule = makeRule({ factors: { F3: { value: 0.0, level: 0 } } });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.degraded, false);
    assert.equal(r.contributions.F3, 0.0);
  });

  test('null F7 skips the F7 soft floor (no penalty for unmeasured)', () => {
    const ruleLowF7 = makeRule({ factors: { F7: { value: 0.10 } } });
    const ruleNullF7 = makeRule({ factors: { F7: { value: null } } });
    const rLow = runCompose(makeScored([ruleLowF7])).rules[0];
    const rNull = runCompose(makeScored([ruleNullF7])).rules[0];
    assert.equal(rLow.floor, 0.5);
    assert.equal(rNull.floor, 1.0);
    assert.ok((rNull.skipped_floors || []).includes('F7'));
  });

  test('all null edge case: score=0.0, no crash, degraded=true', () => {
    const rule = makeRule({
      factors: {
        F1: { value: null }, F2: { value: null },
        F3: { value: null }, F4: { value: null },
        F7: { value: null }, F8: { value: null },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.score, 0.0);
    assert.equal(r.degraded, true);
    assert.equal(r.scored_count, 0);
  });

  test('mechanical_score is computed from F1+F2+F4+F7 only', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.85 }, F2: { value: 0.85 },
        F3: { value: null }, F4: { value: 0.95 },
        F7: { value: 0.80 }, F8: { value: null },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.notEqual(r.mechanical_score, null);
    assert.ok(r.mechanical_score > 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('TestEdgeCases', () => {
  test('all factors 1.0 -> score=1.0, floor=1.0, no NaN', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.score, 1.0);
    assert.equal(r.floor, 1.0);
    assert.equal(r.dominant_weakness, null);
  });

  test('all factors 0.0 -> score=0.0, floor=0.0, no NaN', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.0 }, F2: { value: 0.0 },
        F3: { value: 0.0 }, F4: { value: 0.0 },
        F7: { value: 0.0 }, F8: { value: 0.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.equal(r.score, 0.0);
    assert.equal(r.floor, 0.0);
    assert.ok(!Number.isNaN(r.score));
  });

  test('length penalty boundary: lines=120 -> penalty=1.0; lines=121 -> penalty=0.995', () => {
    const rule = makeRule();
    const sf120 = [{
      path: 'a.md', globs: [], glob_match_count: null,
      default_category: 'mandate', line_count: 120, always_loaded: true,
    }];
    const sf121 = [{
      path: 'a.md', globs: [], glob_match_count: null,
      default_category: 'mandate', line_count: 121, always_loaded: true,
    }];
    const r120 = runCompose(makeScored([rule], sf120));
    const r121 = runCompose(makeScored([rule], sf121));
    const f120 = r120.files.find((f) => f.path === 'a.md');
    const f121 = r121.files.find((f) => f.path === 'a.md');
    assert.equal(f120.length_penalty, 1.0);
    assert.equal(f121.length_penalty, 0.995);
  });

  test('length penalty floor: lines=200 -> penalty=0.6; lines=1000 -> still 0.6 (floor)', () => {
    const rule = makeRule();
    const sf200 = [{
      path: 'a.md', globs: [], glob_match_count: null,
      default_category: 'mandate', line_count: 200, always_loaded: true,
    }];
    const sf1000 = [{
      path: 'a.md', globs: [], glob_match_count: null,
      default_category: 'mandate', line_count: 1000, always_loaded: true,
    }];
    const r200 = runCompose(makeScored([rule], sf200));
    const r1000 = runCompose(makeScored([rule], sf1000));
    const f200 = r200.files.find((f) => f.path === 'a.md');
    const f1000 = r1000.files.find((f) => f.path === 'a.md');
    assert.equal(f200.length_penalty, 0.6);
    assert.equal(f1000.length_penalty, 0.6);
  });
});

// ---------------------------------------------------------------------------
// Position weight
// ---------------------------------------------------------------------------

describe('TestPositionWeightSmooth', () => {
  test('positions 0.19 and 0.21 differ by less than 0.02', () => {
    const rule19 = makeRule({ ruleId: 'R001', lineStart: 19 });
    const rule21 = makeRule({ ruleId: 'R002', lineStart: 21 });
    const scored = makeScored(
      [rule19, rule21],
      [{
        path: 'CLAUDE.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 100, always_loaded: true,
      }],
    );
    const result = runCompose(scored);
    const scores = Object.fromEntries(result.rules.map((r) => [r.id, r.score]));
    assert.ok(Math.abs(scores.R001 - scores.R002) < 0.02);
  });

  test('position 0.10 and 0.90 should produce identical scores', () => {
    const rule10 = makeRule({ ruleId: 'R001', lineStart: 10 });
    const rule90 = makeRule({ ruleId: 'R002', lineStart: 90 });
    const rule30 = makeRule({ ruleId: 'R003', lineStart: 30 });
    const rule70 = makeRule({ ruleId: 'R004', lineStart: 70 });
    const scored = makeScored(
      [rule10, rule90, rule30, rule70],
      [{
        path: 'CLAUDE.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 100, always_loaded: true,
      }],
    );
    const result = runCompose(scored);
    const scores = Object.fromEntries(result.rules.map((r) => [r.id, r.score]));
    assert.equal(scores.R001, scores.R002);
    assert.equal(scores.R003, scores.R004);
  });
});

// ---------------------------------------------------------------------------
// Corpus scoring
// ---------------------------------------------------------------------------

describe('TestCorpusScoring', () => {
  test('effective_corpus_quality key present', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.ok('effective_corpus_quality' in result);
    assert.ok('score' in result.effective_corpus_quality);
  });

  test('corpus_quality key present', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.ok('corpus_quality' in result);
    assert.ok('rule_mean_score' in result.corpus_quality);
    assert.ok('note' in result.corpus_quality);
  });

  test('non-mandate excluded from corpus', () => {
    const mandate = makeRule({ ruleId: 'R001', category: 'mandate' });
    const pref = makeRule({ ruleId: 'R002', category: 'preference' });
    const result = runCompose(makeScored([mandate, pref]));
    assert.equal(result.corpus_quality.rule_count, 1);
    assert.equal(result.guideline_quality.rule_count, 1);
  });

  test('rules must be sorted by leverage descending', () => {
    const rules = [
      makeRule({ ruleId: 'R001', factors: { F1: { value: 0.85 }, F7: { value: 0.80 } }, lineStart: 5 }),
      makeRule({ ruleId: 'R002', factors: { F1: { value: 0.20 }, F7: { value: 0.30 } }, lineStart: 10 }),
      makeRule({ ruleId: 'R003', factors: { F1: { value: 0.50 }, F7: { value: 0.60 } }, lineStart: 15 }),
    ];
    const result = runCompose(makeScored(rules));
    const mandateRules = result.rules.filter((r) => r.category === 'mandate');
    const leverages = mandateRules.map((r) => r.leverage);
    const sorted = [...leverages].sort((a, b) => b - a);
    assert.deepEqual(leverages, sorted);
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

function makeConflictRule(ruleId, polarity, markers, text = 'Test rule.', lineStart = 5) {
  const rule = makeRule({
    ruleId,
    lineStart,
    factors: {
      F1: { value: 0.85, method: 'lookup' },
      F2: { value: 0.85, method: 'classify', matched_category: polarity },
      F3: { value: 0.80, method: 'judgment' },
      F4: { value: 0.95, method: 'glob_match' },
      F7: {
        value: 0.80, method: 'count',
        concrete_markers: markers,
        concrete_count: markers.length,
        abstract_count: 0,
      },
      F8: { value: 0.65, method: 'judgment' },
    },
  });
  rule.text = text;
  return rule;
}

describe('TestConflictDetection', () => {
  test('prohibit plus assert on shared marker flags conflict', () => {
    const rules = [
      makeConflictRule('R001', 'prohibition', ['src/main/gen/'],
        'NEVER edit files in src/main/gen/ directly.'),
      makeConflictRule('R002', 'positive_imperative', ['src/main/gen/'],
        'Use src/main/gen/ cached results for speed.'),
    ];
    const result = runCompose(makeScored(rules));
    const conflicts = result.conflicts;
    assert.equal(conflicts.length, 1);
    const c = conflicts[0];
    assert.equal(c.type, 'polarity_mismatch');
    assert.equal(c.rule_a.polarity, 'prohibition');
    assert.equal(c.rule_b.polarity, 'positive_imperative');
    assert.deepEqual(c.shared_markers, ['src/main/gen/']);
  });

  test('two positives do not conflict', () => {
    const rules = [
      makeConflictRule('R001', 'positive_imperative', ['src/main/gen/']),
      makeConflictRule('R002', 'positive_imperative', ['src/main/gen/']),
    ];
    const result = runCompose(makeScored(rules));
    assert.deepEqual(result.conflicts, []);
  });

  test('no shared marker means no conflict', () => {
    const rules = [
      makeConflictRule('R001', 'prohibition', ['src/main/gen/']),
      makeConflictRule('R002', 'positive_imperative', ['src/test/utils/']),
    ];
    const result = runCompose(makeScored(rules));
    assert.deepEqual(result.conflicts, []);
  });

  test('stoplist markers do not trigger conflicts', () => {
    const rules = [
      makeConflictRule('R001', 'prohibition', ['use', 'code']),
      makeConflictRule('R002', 'positive_imperative', ['use', 'code']),
    ];
    const result = runCompose(makeScored(rules));
    assert.deepEqual(result.conflicts, []);
  });

  test('short markers do not trigger conflicts', () => {
    const rules = [
      makeConflictRule('R001', 'prohibition', ['x', 'io']),
      makeConflictRule('R002', 'positive_imperative', ['x', 'io']),
    ];
    const result = runCompose(makeScored(rules));
    assert.deepEqual(result.conflicts, []);
  });

  test('non-mandate excluded from conflicts', () => {
    const rules = [
      makeConflictRule('R001', 'prohibition', ['src/main/gen/']),
      makeConflictRule('R002', 'positive_imperative', ['src/main/gen/']),
    ];
    rules[1].category = 'override';
    const result = runCompose(makeScored(rules));
    assert.deepEqual(result.conflicts, []);
  });

  test('conflicts sorted by rule ids', () => {
    const rules = [
      makeConflictRule('R003', 'positive_imperative', ['apiClient']),
      makeConflictRule('R001', 'prohibition', ['apiClient']),
      makeConflictRule('R002', 'positive_imperative', ['apiClient']),
    ];
    const result = runCompose(makeScored(rules));
    const conflicts = result.conflicts;
    assert.equal(conflicts.length, 2);
    const ids = conflicts.map((c) => [c.rule_a.id, c.rule_b.id]);
    const sortedIds = [...ids].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    assert.deepEqual(ids, sortedIds);
  });

  test('empty conflicts on clean corpus', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0, matched_category: 'positive_imperative' },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0, concrete_markers: ['fooBar'], concrete_count: 1, abstract_count: 0 },
        F8: { value: 1.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    assert.deepEqual(result.conflicts, []);
  });
});

// ---------------------------------------------------------------------------
// F8 parallel signal
// ---------------------------------------------------------------------------

describe('TestF8ParallelSignal', () => {
  test('composite score excludes F8: F8=0.0 does not drag it down', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 0.0 },
      },
    });
    const result = runCompose(makeScored([rule]));
    const r = result.rules[0];
    assert.ok(r.score >= 0.99);
  });

  test('hook_opportunities populated for low F8', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 1.0 }, F2: { value: 1.0 },
        F3: { value: 1.0 }, F4: { value: 1.0 },
        F7: { value: 1.0 }, F8: { value: 0.30 },
      },
    });
    const result = runCompose(makeScored([rule]));
    assert.equal((result.hook_opportunities || []).length, 1);
    assert.equal(result.hook_opportunities[0].id, 'R001');
    assert.equal(result.rules[0].is_hook_candidate, true);
  });

  test('hook_opportunities empty when all high F8', () => {
    const rule = makeRule({
      factors: {
        F1: { value: 0.80 }, F2: { value: 0.80 },
        F3: { value: 0.80 }, F4: { value: 0.80 },
        F7: { value: 0.80 }, F8: { value: 0.90 },
      },
    });
    const result = runCompose(makeScored([rule]));
    assert.deepEqual(result.hook_opportunities || [], []);
    assert.equal(result.rules[0].is_hook_candidate, false);
  });
});

// ---------------------------------------------------------------------------
// Schema output
// ---------------------------------------------------------------------------

describe('TestSchemaOutput', () => {
  test('schema_version in output', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.equal(result.schema_version, '0.1');
  });

  test('methodology present', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.ok('methodology' in result);
    assert.ok('weights_version' in result.methodology);
  });

  test('date present', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.ok('date' in result);
  });

  test('headline is effective_corpus_quality', () => {
    const rule = makeRule();
    const result = runCompose(makeScored([rule]));
    assert.ok('effective_corpus_quality' in result);
    assert.ok('score' in result.effective_corpus_quality);
  });

  test('empty stdin is fatal', () => {
    const proc = runScriptRaw('compose.js', '');
    assert.notEqual(proc.status, 0);
  });
});
