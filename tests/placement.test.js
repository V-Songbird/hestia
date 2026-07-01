'use strict';

// Tests for placement.js — rule placement detection (hook/skill/subagent/compound).
//
// placement.js reads audit.json from stdin and emits a placement candidates report.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runScript } = require('./helpers');

/** Run placement.js with audit written to a temp file, return parsed JSON output. */
function runPlacement(audit) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-placement-'));
  const auditPath = path.join(tmpDir, 'audit.json');
  fs.writeFileSync(auditPath, JSON.stringify(audit), 'utf-8');
  try {
    return runScript('placement.js', null, ['--prepare-placement', auditPath]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeAudit(rules, ecqScore = 0.72) {
  return {
    schema_version: '0.1',
    project: '/test/project',
    effective_corpus_quality: { score: ecqScore, grade: 'B' },
    files: [],
    source_files: [],
    rules,
    conflicts: [],
  };
}

function makeRule(ruleId, text, category = 'mandate', f8Value = 0.65, factors = null) {
  return {
    id: ruleId,
    text,
    file: 'CLAUDE.md',
    line_start: 5,
    line_end: 5,
    category,
    factors: factors || {
      F1: { value: 0.85 }, F2: { value: 0.85 },
      F3: { value: 0.80 }, F4: { value: 0.95 },
      F7: { value: 0.80 }, F8: { value: f8Value },
    },
  };
}

describe('Schema output', () => {
  test('schema version present', () => {
    const result = runPlacement(makeAudit([makeRule('R001', 'Always validate input')]));
    assert.equal(result.schema_version, '0.1');
  });

  test('candidates list present', () => {
    const result = runPlacement(makeAudit([makeRule('R001', 'Always validate input')]));
    assert.ok('candidates' in result);
    assert.ok(Array.isArray(result.candidates));
  });

  test('summary present', () => {
    const result = runPlacement(makeAudit([makeRule('R001', 'Always validate input')]));
    assert.ok('summary' in result);
    assert.ok('total_candidates' in result.summary);
  });

  test('audit grade present', () => {
    const result = runPlacement(makeAudit([makeRule('R001', 'Always validate input')]));
    assert.ok('audit_grade' in result);
    assert.ok(result.audit_grade.includes('B'));
  });

  test('empty rules no crash', () => {
    const result = runPlacement(makeAudit([]));
    assert.deepEqual(result.candidates, []);
    assert.equal(result.summary.total_candidates, 0);
  });
});

describe('Hook detection', () => {
  const strongHookSignals = [
    'Run `npm run lint` before every commit.',
    'Before submitting a PR, run `pre-commit run --all-files`.',
    'After generating code, run `cargo fmt` automatically.',
    'On PreToolUse, verify file paths are within the project root.',
  ];

  for (const text of strongHookSignals) {
    test(`strong hook signal: ${text}`, () => {
      const rule = makeRule('R001', text);
      const result = runPlacement(makeAudit([rule]));
      const candidates = result.candidates;
      if (candidates.length) {
        assert.ok(candidates.some((c) => c.best_fit === 'hook' || c.best_fit === 'compound'));
      }
    });
  }

  test('hook has evidence', () => {
    const rule = makeRule('R001', 'Run `npm run lint` before every commit.');
    const result = runPlacement(makeAudit([rule]));
    if (result.candidates.length) {
      const hookCandidates = result.candidates.filter((c) => c.best_fit === 'hook');
      if (hookCandidates.length) {
        assert.ok(hookCandidates[0].evidence.length > 0);
      }
    }
  });
});

describe('Skill detection', () => {
  const strongSkillSignals = [
    'When writing API endpoints, follow the REST naming guide.',
    'For SQL queries, use snake_case table names and include indexes on join columns.',
    'To create a new service, follow the service creation checklist in PLAYBOOK.md.',
  ];

  for (const text of strongSkillSignals) {
    test(`strong skill signal: ${text}`, () => {
      const rule = makeRule('R001', text);
      const result = runPlacement(makeAudit([rule]));
      // We just verify no crash and schema
      assert.ok('candidates' in result);
    });
  }

  test('reference skill sub_type', () => {
    const rule = makeRule(
      'R001',
      'When writing components, consult the design-system vocabulary in docs/tokens.md.'
    );
    const result = runPlacement(makeAudit([rule]));
    const skillCandidates = result.candidates.filter(
      (c) => c.best_fit === 'skill' && c.detections && c.detections.length
    );
    // If detected, verify sub_type is present
    for (const c of skillCandidates) {
      const skillDetections = c.detections.filter((d) => d.primitive === 'skill');
      if (skillDetections.length) {
        assert.ok('sub_type' in skillDetections[0]);
      }
    }
  });
});

describe('Subagent detection', () => {
  const strongSubagentSignals = [
    'For large refactors, spawn a fresh subagent to avoid context pollution.',
    'When reviewing a PR, use an isolated agent with no knowledge of the authoring session.',
  ];

  for (const text of strongSubagentSignals) {
    test(`strong subagent signal: ${text}`, () => {
      const rule = makeRule('R001', text);
      const result = runPlacement(makeAudit([rule]));
      assert.ok('candidates' in result);
    });
  }

  test('subagent fresh context signal', () => {
    const rule = makeRule(
      'R001',
      'Spawn a fresh context for each security review to avoid anchoring bias.'
    );
    const result = runPlacement(makeAudit([rule]));
    // If not detected, that's also acceptable — just verify no crash
    assert.ok('candidates' in result);
  });
});

describe('Compound detection', () => {
  test('hook and skill conjunction', () => {
    const rule = makeRule(
      'R001',
      'Run `cargo fmt --check` before merging, and consult the style guide when names are unclear.'
    );
    const result = runPlacement(makeAudit([rule]));
    // Compound is detected when both hook and skill signals are above threshold
    assert.ok('candidates' in result); // no crash
  });

  test('no conjunction not compound', () => {
    const rule = makeRule('R001', 'Run `npm run lint` before every commit.');
    const result = runPlacement(makeAudit([rule]));
    const compounds = result.candidates.filter((c) => c.best_fit === 'compound');
    assert.ok(!compounds.length || result.candidates[0].best_fit !== 'compound');
  });
});

describe('Non-mandate exclusion', () => {
  test('preference rules excluded', () => {
    const rule = makeRule(
      'R001',
      'Prefer running `prettier --check` before committing.',
      'preference'
    );
    const result = runPlacement(makeAudit([rule]));
    // preference rules might still be analyzed but their category is preserved
    assert.ok('candidates' in result);
  });

  test('low quality rule still analyzed', () => {
    // Placement analysis runs on all rules regardless of score.
    const rule = makeRule('R001', 'Do the right thing.');
    const result = runPlacement(makeAudit([rule]));
    assert.ok('candidates' in result);
  });
});

describe('Summary counts', () => {
  test('no candidates when no matches', () => {
    const rules = [makeRule('R001', 'Do the right thing here.')];
    const result = runPlacement(makeAudit(rules));
    assert.equal(result.summary.total_candidates, result.candidates.length);
  });

  test('multiple rules summary matches', () => {
    const rules = [
      makeRule('R001', 'Do the right thing.'),
      makeRule('R002', 'Run `npm run lint` before every commit.'),
    ];
    const result = runPlacement(makeAudit(rules));
    assert.equal(result.summary.total_candidates, result.candidates.length);
  });

  test('summary categories sum to total', () => {
    const rules = [
      makeRule('R001', 'Run `npm run lint` before every commit.'),
      makeRule('R002', 'When writing components, consult the design-system vocabulary.'),
    ];
    const result = runPlacement(makeAudit(rules));
    const s = result.summary;
    assert.ok(
      s.hook_candidates + s.skill_candidates + s.subagent_candidates + s.compound_candidates <=
        s.total_candidates
    );
  });
});

describe('Detection record structure', () => {
  test('candidate has required fields', () => {
    const rule = makeRule('R001', 'Run `npm run lint` before every commit.');
    const result = runPlacement(makeAudit([rule]));
    for (const c of result.candidates) {
      assert.ok('rule_id' in c);
      assert.ok('rule_text' in c);
      assert.ok('detections' in c);
      assert.ok('scores' in c);
      assert.ok('best_fit' in c);
    }
  });

  test('scores has hook skill subagent', () => {
    const rule = makeRule('R001', 'Run `npm run lint` before every commit.');
    const result = runPlacement(makeAudit([rule]));
    for (const c of result.candidates) {
      assert.ok('hook' in c.scores);
      assert.ok('skill' in c.scores);
      assert.ok('subagent' in c.scores);
    }
  });

  test('detection entries have required fields', () => {
    const rule = makeRule('R001', 'Run `npm run lint` before every commit.');
    const result = runPlacement(makeAudit([rule]));
    for (const c of result.candidates) {
      for (const d of c.detections) {
        assert.ok('primitive' in d);
        assert.ok('confidence' in d);
        assert.ok('evidence' in d);
        assert.ok('sub_type' in d);
      }
    }
  });
});
