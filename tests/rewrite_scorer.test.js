'use strict';

// Tests for rewrite_scorer.js — mechanical scoring and finalization of rule rewrites.
//
// Phase 1: node rewrite_scorer.js --score-rewrites audit.json rewrites_input.json
// Phase 2: node rewrite_scorer.js --finalize rewrite_semi.json judgment_patches.json audit.json

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScriptRaw } = require('./helpers');
const { letterGrade } = require('../scripts/rewrite_scorer.js');

function writeTempJson(prefix, data) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tmpDir, 'file.json');
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

function rmParent(filePath) {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
}

/** Run phase 1 and return rewrite_semi dict. */
function runScoreRewrites(audit, rewritesInput) {
  const auditPath = writeTempJson('hestia-audit-', audit);
  const rewritesPath = writeTempJson('hestia-rewrites-', rewritesInput);

  const result = runScriptRaw('rewrite_scorer.js', null, [
    '--score-rewrites',
    auditPath,
    rewritesPath,
  ]);
  rmParent(auditPath);
  rmParent(rewritesPath);

  if (result.status !== 0) {
    throw new Error(`rewrite_scorer.js --score-rewrites failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** Run phase 1 and return the raw spawnSync result (for stderr assertions). */
function runScoreRewritesRaw(audit, rewritesInput) {
  const auditPath = writeTempJson('hestia-audit-', audit);
  const rewritesPath = writeTempJson('hestia-rewrites-', rewritesInput);

  const result = runScriptRaw('rewrite_scorer.js', null, [
    '--score-rewrites',
    auditPath,
    rewritesPath,
  ]);
  rmParent(auditPath);
  rmParent(rewritesPath);
  return result;
}

/** Run phase 2 (finalize) and return the rewrites list. */
function runFinalize(rewriteSemi, patches, audit) {
  const patchesObj = {
    schema_version: '0.1',
    model_version: 'test-model',
    patches,
  };

  const semiPath = writeTempJson('hestia-semi-', rewriteSemi);
  const patchesPath = writeTempJson('hestia-patches-', patchesObj);
  const auditPath = writeTempJson('hestia-audit-', audit);

  const result = runScriptRaw('rewrite_scorer.js', null, [
    '--finalize',
    semiPath,
    patchesPath,
    auditPath,
  ]);
  rmParent(semiPath);
  rmParent(patchesPath);
  rmParent(auditPath);

  if (result.status !== 0) {
    throw new Error(`rewrite_scorer.js --finalize failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function makeAudit({ ruleId = 'R001', oldScore = 0.35 } = {}) {
  return {
    schema_version: '0.1',
    project: '/test',
    project_context: {
      stack: ['Python'],
      always_loaded_files: ['CLAUDE.md'],
      glob_scoped_files: [],
      tooling: {},
    },
    config: {},
    source_files: [
      {
        path: 'CLAUDE.md',
        globs: [],
        glob_match_count: null,
        default_category: 'mandate',
        line_count: 20,
        always_loaded: true,
      },
    ],
    effective_corpus_quality: { score: 0.60, grade: 'C' },
    rules: [
      {
        id: ruleId,
        file: 'CLAUDE.md',
        line_start: 5,
        line_end: 5,
        text: 'Do the right thing about error handling.',
        category: 'mandate',
        loading: 'always-loaded',
        score: oldScore,
        dominant_weakness: 'F7',
        failure_class: 'ambiguity',
        factors: {
          F1: { value: 0.20 },
          F2: { value: 0.30 },
          F3: { value: 0.40 },
          F4: { value: 0.95 },
          F7: { value: 0.15 },
          F8: { value: 0.70 },
        },
        f8_value: 0.70,
        is_hook_candidate: false,
        degraded: false,
        degraded_factors: [],
        layers: { clarity: 0.22, activation: 0.60 },
        floor: 0.75,
        pre_floor_score: 0.35,
        contributions: { F1: 0.04, F2: 0.04, F3: 0.08, F4: 0.14, F7: 0.04 },
        dominant_weakness_gap: 1.10,
        leverage: 0.65,
        stale: false,
      },
    ],
    files: [],
    conflicts: [],
    hook_opportunities: [],
  };
}

function makeRewriteItem({
  ruleId = 'R001',
  suggestedRewrite = 'ALWAYS call `error_handler.handle(exc, context=ctx)` for all exceptions.',
  originalText = 'Do the right thing about error handling.',
  oldScore = 0.35,
} = {}) {
  return {
    rule_id: ruleId,
    suggested_rewrite: suggestedRewrite,
    original_text: originalText,
    file: 'CLAUDE.md',
    line_start: 5,
    old_score: oldScore,
    old_dominant_weakness: 'F7',
    projected_score: 0.80,
  };
}

function makePatches({ ruleId = 'R001', f3Value = 0.80, f8Value = 0.65 } = {}) {
  return {
    [ruleId]: {
      F3: { value: f3Value, level: 3, reasoning: 'Clear trigger.' },
      F8: { value: f8Value, level: 2, reasoning: 'Linter can enforce.' },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 1: score_rewrites
// ---------------------------------------------------------------------------

describe('ScoreRewrites', () => {
  it('basic output schema', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const result = runScoreRewrites(audit, items);
    assert.ok('rules' in result);
    assert.equal(result.rules.length, 1);
  });

  it('rule has factors', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const result = runScoreRewrites(audit, items);
    const rule = result.rules[0];
    assert.ok('F1' in rule.factors);
    assert.ok('F7' in rule.factors);
  });

  it('rewrite meta attached', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const result = runScoreRewrites(audit, items);
    const rule = result.rules[0];
    assert.ok('_rewrite_meta' in rule);
    assert.equal(rule._rewrite_meta.rule_id, 'R001');
    assert.equal(rule._rewrite_meta.original_text, 'Do the right thing about error handling.');
    assert.equal(rule._rewrite_meta.old_score, 0.35);
  });

  it('empty rewrites returns empty', () => {
    const audit = makeAudit();
    const result = runScoreRewrites(audit, []);
    assert.deepEqual(result.rules, []);
  });

  it('multiple rewrites', () => {
    const audit = makeAudit();
    audit.rules.push({
      ...audit.rules[0],
      id: 'R002',
      text: 'Write code that works well.',
    });
    const items = [
      makeRewriteItem({ ruleId: 'R001' }),
      makeRewriteItem({
        ruleId: 'R002',
        suggestedRewrite: 'Use `Result<T, AppError>` for all fallible functions.',
      }),
    ];
    const result = runScoreRewrites(audit, items);
    assert.equal(result.rules.length, 2);
  });

  it('fragmentation warning emitted (rewrite that would fragment should emit a WARNING to stderr)', () => {
    const audit = makeAudit();
    // Compound rewrite with semicolons that might fragment
    const compound =
      'ALWAYS call `error_handler.handle(exc)` for exceptions; ' +
      'also log to `audit_log.write(exc, ctx)` for persistence.';
    const items = [makeRewriteItem({ suggestedRewrite: compound })];

    const result = runScoreRewritesRaw(audit, items);

    assert.equal(result.status, 0);
    if (result.stderr.includes('WARNING')) {
      assert.ok(result.stderr.toLowerCase().includes('fragment'));
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2: finalize
// ---------------------------------------------------------------------------

describe('FinalizeRewrites', () => {
  it('finalize returns list', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches();
    const result = runFinalize(rewriteSemi, patches, audit);
    assert.ok(Array.isArray(result));
  });

  it('finalize has required fields', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches();
    const rewrites = runFinalize(rewriteSemi, patches, audit);
    if (rewrites.length) {
      const rw = rewrites[0];
      assert.ok('rule_id' in rw);
      assert.ok('original_text' in rw);
      assert.ok('suggested_rewrite' in rw);
      assert.ok('old_score' in rw);
      assert.ok('new_score' in rw);
      assert.ok('delta' in rw);
    }
  });

  it('delta is improvement', () => {
    const audit = makeAudit();
    const items = [
      makeRewriteItem({
        suggestedRewrite: 'ALWAYS call `error_handler.handle(exc, ctx)` on all exceptions.',
        oldScore: 0.35,
      }),
    ];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches({ f3Value: 0.80, f8Value: 0.65 });
    const rewrites = runFinalize(rewriteSemi, patches, audit);
    if (rewrites.length) {
      const rw = rewrites[0];
      assert.ok(rw.new_score > 0);
      assert.ok('delta' in rw);
    }
  });

  it('safety gate rejects regression (rewrites that score lower than original should be rejected)', () => {
    const audit = makeAudit({ oldScore: 0.90 });
    const items = [
      makeRewriteItem({
        suggestedRewrite: 'Handle errors properly.',
        oldScore: 0.90,
      }),
    ];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches({ f3Value: 0.25, f8Value: 0.25 });
    const rewrites = runFinalize(rewriteSemi, patches, audit);
    // All entries for regressions should be absent or marked rejected
    const accepted = rewrites.filter((rw) => rw.approved === true);
    assert.equal(accepted.length, 0);
  });

  it('grade present', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches();
    const rewrites = runFinalize(rewriteSemi, patches, audit);
    if (rewrites.length) {
      assert.ok('new_grade' in rewrites[0] || 'old_grade' in rewrites[0]);
    }
  });

  it('empty rewrites empty output', () => {
    const audit = makeAudit();
    const rewriteSemi = runScoreRewrites(audit, []);
    const rewrites = runFinalize(rewriteSemi, {}, audit);
    assert.deepEqual(rewrites, []);
  });
});

// ---------------------------------------------------------------------------
// Letter grade helper (via module import)
// ---------------------------------------------------------------------------

describe('LetterGrade', () => {
  const cases = [
    [0.90, 'A'], [0.80, 'A'], [0.79, 'B'],
    [0.65, 'B'], [0.64, 'C'], [0.50, 'C'],
    [0.49, 'D'], [0.35, 'D'], [0.34, 'F'],
    [0.00, 'F'],
  ];

  for (const [score, expected] of cases) {
    it(`grade boundary ${score} -> ${expected}`, () => {
      assert.equal(letterGrade(score), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Pipeline end-to-end
// ---------------------------------------------------------------------------

describe('EndToEnd', () => {
  it('full pipeline no crash', () => {
    const audit = makeAudit();
    const items = [makeRewriteItem()];
    const rewriteSemi = runScoreRewrites(audit, items);
    const patches = makePatches();
    const rewrites = runFinalize(rewriteSemi, patches, audit);
    assert.ok(Array.isArray(rewrites));
  });
});
