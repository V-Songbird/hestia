'use strict';

// Tests for report.js — markdown rendering and JSON passthrough.
//
// hestia's report.js reads audit.json from stdin. Letter grade thresholds:
//   A >= 0.80, B >= 0.65, C >= 0.50, D >= 0.35, F < 0.35

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// report.js's markdown mode writes plain text, not JSON — runScript() insists
// on parsing stdout as JSON, so call runScriptRaw directly and check success.
const { runScriptRaw } = require('./helpers');

function renderReport(audit, { json = false, verbose = false } = {}) {
  const args = [];
  if (json) args.push('--json');
  if (verbose) args.push('--verbose');
  const result = runScriptRaw('report.js', audit, args);
  assert.equal(result.status, 0, `report.js failed: ${result.stderr}`);
  return result.stdout;
}

function makeAudit() {
  return {
    schema_version: '0.1',
    project: '/test/project',
    date: '2026-04-07',
    methodology: { weights_version: 'quality-heuristic-0.1' },
    files_scanned: 2,
    rules_extracted: 3,
    effective_corpus_quality: {
      score: 0.65,
      grade: 'B',
      methodology: 'file-score weighted aggregate',
    },
    corpus_quality: { rule_mean_score: 0.68, rule_count: 2, note: 'diagnostic' },
    guideline_quality: { score: 0.45, rule_count: 1 },
    rules: [
      {
        id: 'R001', file: 'CLAUDE.md', line_start: 3, line_end: 3,
        text: 'ALWAYS validate user input before processing.',
        category: 'mandate', loading: 'always-loaded',
        score: 0.874, pre_floor_score: 0.874, floor: 1.0, stale: false,
        leverage: 0.13,
        factors: {
          F1: { value: 1.0 }, F2: { value: 0.85 }, F3: { value: 0.80 },
          F4: { value: 0.95 }, F7: { value: 0.80 },
          F8: { value: 0.70 },
        },
        contributions: { F1: 0.221, F2: 0.125, F3: 0.153, F4: 0.140, F7: 0.235 },
        layers: { clarity: 0.83, activation: 0.87 },
        dominant_weakness: 'F7', dominant_weakness_gap: 0.40,
        failure_class: 'ambiguity',
        f8_value: 0.70, is_hook_candidate: false,
        degraded: false, degraded_factors: [],
      },
      {
        id: 'R002', file: 'CLAUDE.md', line_start: 5, line_end: 5,
        text: 'Try to prefer functional components when possible.',
        category: 'mandate', loading: 'always-loaded',
        score: 0.386, pre_floor_score: 0.386, floor: 1.0, stale: false,
        leverage: 0.61,
        factors: {
          F1: { value: 0.20 }, F2: { value: 0.35 }, F3: { value: 0.25 },
          F4: { value: 0.95 }, F7: { value: 0.35 },
          F8: { value: 0.70 },
        },
        contributions: { F1: 0.044, F2: 0.051, F3: 0.048, F4: 0.140, F7: 0.103 },
        layers: { clarity: 0.27, activation: 0.55 },
        dominant_weakness: 'F7', dominant_weakness_gap: 1.30,
        failure_class: 'ambiguity',
        f8_value: 0.70, is_hook_candidate: false,
        degraded: false, degraded_factors: [],
      },
      {
        id: 'R003', file: '.claude/rules/api.md', line_start: 8, line_end: 8,
        text: 'Prefer transactions for queries spanning multiple tables.',
        category: 'preference', loading: 'glob-scoped',
        score: 0.490, pre_floor_score: 0.490, floor: 1.0, stale: false,
        leverage: null,
        factors: {
          F1: { value: 0.50 }, F2: { value: 0.35 }, F3: { value: 0.60 },
          F4: { value: 0.65 }, F7: { value: 0.40 },
          F8: { value: 0.70 },
        },
        contributions: { F1: 0.110, F2: 0.051, F3: 0.115, F4: 0.096, F7: 0.118 },
        layers: { clarity: 0.35, activation: 0.62 },
        dominant_weakness: 'F7', dominant_weakness_gap: 1.20,
        failure_class: 'ambiguity',
        f8_value: 0.70, is_hook_candidate: false,
        degraded: false, degraded_factors: [],
      },
    ],
    files: [
      {
        path: 'CLAUDE.md', file_score: 0.62, grade: 'C',
        line_count: 20, rule_count: 2,
        length_penalty: 1.0, prohibition_ratio: 0.0,
        trigger_scope_coherence: 0.0, concreteness_coverage: 0.50,
        dead_zone_count: 0,
      },
      {
        path: '.claude/rules/api.md', file_score: 0.45, grade: 'D',
        line_count: 15, rule_count: 1,
        length_penalty: 1.0, prohibition_ratio: 0.0,
        trigger_scope_coherence: 0.0, concreteness_coverage: 0.0,
        dead_zone_count: 0,
      },
    ],
    positive_findings: [
      { file: 'CLAUDE.md', line: 3, text: 'ALWAYS validate user input', score: 0.874 },
    ],
    rewrite_candidates: [
      { rule_id: 'R002', score: 0.42, dominant_weakness: 'F7' },
    ],
    conflicts: [],
    hook_opportunities: [],
  };
}

function makeAuditWithScore(ecqScore) {
  const audit = makeAudit();
  audit.effective_corpus_quality.score = ecqScore;
  const letter = ecqScore >= 0.80 ? 'A' : ecqScore >= 0.65 ? 'B' : ecqScore >= 0.50 ? 'C' : ecqScore >= 0.35 ? 'D' : 'F';
  audit.effective_corpus_quality.grade = letter;
  return audit;
}

function makeAuditWithConflicts() {
  const audit = makeAudit();
  audit.conflicts = [
    {
      type: 'polarity_mismatch',
      rule_a: {
        id: 'R001',
        text: 'NEVER edit files in src/main/gen/ directly.',
        file: 'CLAUDE.md',
        line_start: 5,
        polarity: 'prohibition',
      },
      rule_b: {
        id: 'R002',
        text: 'Use src/main/gen/ cached results for faster access.',
        file: '.claude/rules/api.md',
        line_start: 8,
        polarity: 'positive_imperative',
      },
      shared_markers: ['src/main/gen/'],
    },
  ];
  return audit;
}

function folkloreFinding() {
  return {
    severity: 'medium', artifact: 'rule',
    symptom: "rule can't be enforced or self-checked",
    why: 'an unenforceable rule trains Claude the ruleset contains noise, discounting the rules that do matter',
    fix_action: 'rewrite to name a checkable condition — a command, threshold, or concrete construct — or delete it',
    file: 'CLAUDE.md', line: '3', location: 'CLAUDE.md:3',
    advisory: false, fix: 'assess-rules',
    tags: ['folklore', 'quality-word:clean'],
    rule_id: 'R001', text: 'Always write clean, maintainable code.',
    quality_words: ['clean', 'maintainable'],
  };
}

// ---------------------------------------------------------------------------
// Letter grade thresholds
// ---------------------------------------------------------------------------

describe('LetterGrade', () => {
  it('grade a', () => {
    assert.match(renderReport(makeAuditWithScore(0.85)), /Grade: A/);
  });

  it('grade b', () => {
    assert.match(renderReport(makeAuditWithScore(0.70)), /Grade: B/);
  });

  it('grade c', () => {
    assert.match(renderReport(makeAuditWithScore(0.55)), /Grade: C/);
  });

  it('grade d', () => {
    assert.match(renderReport(makeAuditWithScore(0.40)), /Grade: D/);
  });

  it('grade f', () => {
    assert.match(renderReport(makeAuditWithScore(0.25)), /Grade: F/);
  });

  it('grade boundary a/b: 0.80 -> A, 0.799 -> B', () => {
    assert.match(renderReport(makeAuditWithScore(0.80)), /Grade: A/);
    assert.match(renderReport(makeAuditWithScore(0.799)), /Grade: B/);
  });

  it('grade boundary b/c: 0.65 -> B, 0.649 -> C', () => {
    assert.match(renderReport(makeAuditWithScore(0.65)), /Grade: B/);
    assert.match(renderReport(makeAuditWithScore(0.649)), /Grade: C/);
  });

  it('grade boundary c/d: 0.50 -> C, 0.499 -> D', () => {
    assert.match(renderReport(makeAuditWithScore(0.50)), /Grade: C/);
    assert.match(renderReport(makeAuditWithScore(0.499)), /Grade: D/);
  });

  it('grade boundary d/f: 0.35 -> D, 0.349 -> F', () => {
    assert.match(renderReport(makeAuditWithScore(0.35)), /Grade: D/);
    assert.match(renderReport(makeAuditWithScore(0.349)), /Grade: F/);
  });
});

// ---------------------------------------------------------------------------
// Markdown sections
// ---------------------------------------------------------------------------

describe('MarkdownSections', () => {
  it('all sections present', () => {
    const report = renderReport(makeAudit());
    assert.match(report, /# Hestia Rules Audit/);
    assert.match(report, /Grade:/);
  });

  it('what to fix section', () => {
    assert.match(renderReport(makeAudit()), /What to fix first/);
  });

  it('best rules section', () => {
    const report = renderReport(makeAudit());
    assert.ok(report.toLowerCase().includes('best rules') || report.includes('Your best'));
  });

  it('verbose sections present', () => {
    const report = renderReport(makeAudit(), { verbose: true });
    assert.ok(report.includes('Detailed') || report.includes('Per-rule') || report.includes('F1') || report.includes('F7'));
  });
});

// ---------------------------------------------------------------------------
// Failure class summary
// ---------------------------------------------------------------------------

describe('FailureClassSummary', () => {
  it('summary appears for mandate rules with failure class', () => {
    const report = renderReport(makeAudit());
    assert.match(report, /At-risk rules:/);
    assert.match(report, /ambiguity/);
  });

  it('summary counts mandate only (R003 is preference)', () => {
    assert.match(renderReport(makeAudit()), /2 ambiguity/);
  });

  it('summary hidden when no failure class', () => {
    const audit = makeAudit();
    for (const r of audit.rules) r.failure_class = null;
    assert.doesNotMatch(renderReport(audit), /At-risk rules:/);
  });

  it('summary groups by class: drift before ambiguity', () => {
    const audit = makeAudit();
    audit.rules[0].dominant_weakness = 'F3';
    audit.rules[0].failure_class = 'drift';
    const report = renderReport(audit);
    assert.match(report, /At-risk rules:/);
    const atRiskLine = report.split('\n').find((ln) => ln.includes('At-risk rules:'));
    const driftPos = atRiskLine.indexOf('drift');
    const ambiguityPos = atRiskLine.indexOf('ambiguity');
    assert.ok(driftPos >= 0 && driftPos < ambiguityPos);
  });
});

// ---------------------------------------------------------------------------
// Conflict section
// ---------------------------------------------------------------------------

describe('PotentialConflicts', () => {
  it('section appears when conflicts present', () => {
    assert.match(renderReport(makeAuditWithConflicts()), /## Potential conflicts/);
  });

  it('section lists both rules', () => {
    const report = renderReport(makeAuditWithConflicts());
    assert.match(report, /NEVER edit files in src\/main\/gen\//);
    assert.match(report, /Use src\/main\/gen\/ cached results/);
  });

  it('section names shared marker', () => {
    assert.match(renderReport(makeAuditWithConflicts()), /`src\/main\/gen\/`/);
  });

  it('section hidden when empty', () => {
    assert.doesNotMatch(renderReport(makeAudit()), /## Potential conflicts/);
  });

  it('headline appears for conflicts', () => {
    const report = renderReport(makeAuditWithConflicts());
    assert.match(report, /\*\*Potential conflicts:\*\*/);
    assert.match(report, /1 rule pair/);
  });

  it('headline plural for multiple', () => {
    const audit = makeAuditWithConflicts();
    audit.conflicts.push(audit.conflicts[0]);
    assert.match(renderReport(audit), /2 rule pairs/);
  });
});

// ---------------------------------------------------------------------------
// Positive findings
// ---------------------------------------------------------------------------

describe('PositiveFindings', () => {
  it('best rules shown', () => {
    assert.match(renderReport(makeAudit()), /ALWAYS validate/);
  });

  it('best rules why section', () => {
    const report = renderReport(makeAudit());
    assert.ok(report.includes('Why it works') || report.toLowerCase().includes('why'));
  });
});

// ---------------------------------------------------------------------------
// Friendly output
// ---------------------------------------------------------------------------

describe('FriendlyOutput', () => {
  it('no factor codes in default', () => {
    const report = renderReport(makeAudit());
    for (const code of ['F1', 'F2', 'F3', 'F4', 'F7', 'F8']) {
      assert.ok(!report.includes(code), `Factor code ${code} found in default output`);
    }
  });

  it('factor codes in verbose', () => {
    const report = renderReport(makeAudit(), { verbose: true });
    assert.ok(report.includes('F1') || report.includes('F7'));
  });
});

// ---------------------------------------------------------------------------
// Floor display
// ---------------------------------------------------------------------------

describe('FloorDisplay', () => {
  it('floor not shown when 1', () => {
    assert.doesNotMatch(renderReport(makeAudit(), { verbose: true }), /Floor: 1\.00/);
  });

  it('floor shown when active', () => {
    const audit = makeAudit();
    audit.rules[1].floor = 0.50;
    audit.rules[1].pre_floor_score = 0.84;
    assert.match(renderReport(audit, { verbose: true }), /Floor: 0\.50/);
  });
});

// ---------------------------------------------------------------------------
// JSON passthrough
// ---------------------------------------------------------------------------

describe('JsonPassthrough', () => {
  it('json valid', () => {
    const output = renderReport(makeAudit(), { json: true });
    const data = JSON.parse(output);
    assert.equal(data.schema_version, '0.1');
  });

  it('json preserves all fields', () => {
    const audit = makeAudit();
    const output = renderReport(audit, { json: true });
    const data = JSON.parse(output);
    assert.ok('effective_corpus_quality' in data);
    assert.ok('rules' in data);
    assert.equal(data.rules.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Hook opportunities
// ---------------------------------------------------------------------------

describe('HookOpportunitiesRender', () => {
  it('hook section when present', () => {
    const audit = makeAudit();
    audit.hook_opportunities = [{
      id: 'R01', text: 'Run prettier before commit',
      file: 'CLAUDE.md', line_start: 10,
      f8_value: 0.20,
      suggested_enforcement: 'Pre-commit hook',
    }];
    const report = renderReport(audit);
    assert.match(report, /## Hook opportunities/);
    assert.match(report, /Pre-commit hook/);
  });

  it('hook section skipped when empty', () => {
    const audit = makeAudit();
    audit.hook_opportunities = [];
    assert.doesNotMatch(renderReport(audit), /## Hook opportunities/);
  });

  it('hook section missing key safe', () => {
    const audit = makeAudit();
    delete audit.hook_opportunities;
    assert.doesNotMatch(renderReport(audit), /## Hook opportunities/);
  });
});

// ---------------------------------------------------------------------------
// Folklore section (enforceability dimension)
// ---------------------------------------------------------------------------

describe('FolkloreRender', () => {
  it('folklore section when present', () => {
    const audit = makeAudit();
    audit.folklore_findings = [folkloreFinding()];
    audit.enforceability_counts = { enforceable: 1, observable: 1, folklore: 1 };
    const report = renderReport(audit);
    assert.match(report, /## Folklore rules \(rewrite or delete\)/);
    // Triple-shape surfaces: symptom (count), why, fix_action.
    assert.match(report, /discounting the rules that do matter/);
    assert.match(report, /rewrite to name a checkable condition/);
    // Evidence (the unverifiable word) and the location are cited.
    assert.match(report, /`clean`/);
    assert.match(report, /CLAUDE\.md:3/);
  });

  it('folklore section skipped when empty', () => {
    const audit = makeAudit();
    audit.folklore_findings = [];
    assert.doesNotMatch(renderReport(audit), /## Folklore rules/);
  });

  it('folklore section missing key safe', () => {
    const audit = makeAudit();
    delete audit.folklore_findings;
    assert.doesNotMatch(renderReport(audit), /## Folklore rules/);
  });

  it('enforceability mix rendered', () => {
    const audit = makeAudit();
    audit.folklore_findings = [folkloreFinding()];
    audit.enforceability_counts = { enforceable: 4, observable: 2, folklore: 1 };
    const report = renderReport(audit);
    assert.match(report, /4 enforceable/);
    assert.match(report, /2 observable/);
  });
});

// ---------------------------------------------------------------------------
// Degraded rule notice
// ---------------------------------------------------------------------------

describe('DegradedRuleNotice', () => {
  it('degraded notice shown', () => {
    const audit = makeAudit();
    audit.rules[0].degraded = true;
    audit.rules[0].degraded_factors = ['F3'];
    const report = renderReport(audit);
    assert.match(report, /scored on fewer than all factors/);
    assert.match(report, /--verbose/);
  });

  it('degraded notice plural', () => {
    const audit = makeAudit();
    audit.rules[0].degraded = true;
    audit.rules[0].degraded_factors = ['F3'];
    audit.rules[1].degraded = true;
    audit.rules[1].degraded_factors = ['F8'];
    assert.match(renderReport(audit), /2 rules were scored/);
  });

  it('degraded notice absent for clean report', () => {
    assert.doesNotMatch(renderReport(makeAudit()), /scored on fewer than all factors/);
  });
});

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

describe('Disclaimer', () => {
  it('disclaimer present', () => {
    const report = renderReport(makeAudit());
    assert.match(report, /how clearly Claude can parse and apply/);
    assert.match(report, /Actual compliance depends on factors/);
  });

  it('disclaimer at end', () => {
    const report = renderReport(makeAudit());
    const pos = report.indexOf('how clearly Claude can parse and apply');
    assert.ok(pos > report.length / 2);
  });
});

// ---------------------------------------------------------------------------
// Limits section (finding contract — Part C)
// ---------------------------------------------------------------------------

describe('LimitsSection', () => {
  it('limits section always renders', () => {
    assert.match(renderReport(makeAudit()), /## Limits — what this run could not check/);
  });

  it('limits section near end', () => {
    const report = renderReport(makeAudit());
    const limitsPos = report.indexOf('## Limits');
    const fixPos = report.indexOf('What to fix first');
    assert.ok(limitsPos > fixPos && fixPos > 0);
  });

  it('limits renders emitter notes', () => {
    const audit = makeAudit();
    audit.limits = [
      {
        scope: 'rule-extraction', detail: 'Scored 3 rules across 2 files.',
        residual_risk: 'Prose instructions are invisible to the audit.',
      },
    ];
    const report = renderReport(audit);
    assert.match(report, /Scored 3 rules across 2 files\./);
    assert.match(report, /Residual risk: Prose instructions are invisible/);
  });

  it('limits states no conflicts explicitly', () => {
    // empty conflict result is stated, not silenced
    assert.match(renderReport(makeAudit()), /No potential conflicts surfaced/);
  });

  it('limits states no degraded explicitly', () => {
    assert.match(renderReport(makeAudit()).toLowerCase(), /no degraded scores/);
  });

  it('limits counts conflicts when present', () => {
    const report = renderReport(makeAuditWithConflicts());
    const limitsBlock = report.slice(report.indexOf('## Limits'));
    assert.match(limitsBlock, /1 candidate pair/);
  });
});

// ---------------------------------------------------------------------------
// Counted facts, no counterfactual (finding contract — Part D)
// ---------------------------------------------------------------------------

describe('NoCounterfactual', () => {
  it('report makes no improvement pct claim', () => {
    const report = renderReport(makeAudit()).toLowerCase();
    for (const phrase of ['improved setup health', 'improvement of', '% better', 'would improve', 'increase health by']) {
      assert.ok(!report.includes(phrase), `unexpected phrase found: ${phrase}`);
    }
  });

  it('disclaimer states counted not impact', () => {
    assert.match(renderReport(makeAudit()), /observed tallies, not before\/after impact/);
  });
});

// ---------------------------------------------------------------------------
// Emoji / Unicode encoding
// ---------------------------------------------------------------------------

describe('EmojiEncoding', () => {
  it('emoji in rule text does not crash', () => {
    const audit = makeAudit();
    audit.rules[0].text = "Don't use AI-sounding words: ✅ ✨ 🚀 — avoid these.";
    audit.rules[0].score = 0.30;
    assert.match(renderReport(audit), /AI-sounding words/);
  });
});
