'use strict';

// Tests for score_semi.js — F3/F8 confidence gating.
//
// hestia's score_semi.js reads a JSON payload from stdin where F3 and F8 have
// already been set (by the LLM judgment step) and adds factor_confidence_low
// flags for borderline scores.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./helpers');

/**
 * Run a single rule through score_semi and return the scored rule.
 *
 * Pre-populates F3 and F8 so that shouldFlagF3 / shouldFlagF8 can fire.
 */
function scoreRule(text, f3Value = 0.55, f8Value = 0.55) {
  const data = {
    source_files: [
      {
        path: 'test.md',
        globs: [],
        glob_match_count: null,
        default_category: 'mandate',
        line_count: 10,
        always_loaded: true,
      },
    ],
    rules: [
      {
        id: 'R001',
        file_index: 0,
        text,
        line_start: 1,
        line_end: 1,
        category: 'mandate',
        staleness: { gated: false, missing_entities: [] },
        factors: {
          F1: { value: 0.85, method: 'lookup' },
          F2: { value: 0.85, method: 'classify' },
          F4: { value: 0.95, method: 'glob_match' },
          F3: { value: f3Value, level: 2, method: 'judgment' },
          F8: { value: f8Value, level: 2, method: 'judgment' },
        },
      },
    ],
  };
  const result = runScript('score_semi.js', data);
  return result.rules[0];
}

describe('F3 confidence gating', () => {
  it('borderline F3 value flagged', () => {
    const rule = scoreRule('Use strict TypeScript', 0.55);
    const flags = rule.factor_confidence_low || [];
    assert.ok(flags.includes('F3'));
  });

  it('clear F3 value not flagged', () => {
    const rule = scoreRule('Use strict TypeScript', 0.9);
    const flags = rule.factor_confidence_low || [];
    assert.ok(!flags.includes('F3'));
  });

  it('clear low F3 value not flagged', () => {
    const rule = scoreRule('Use strict TypeScript', 0.1);
    const flags = rule.factor_confidence_low || [];
    assert.ok(!flags.includes('F3'));
  });

  it('F3 value of null flagged (uncertain)', () => {
    const rule = scoreRule('Use strict TypeScript', null);
    const flags = rule.factor_confidence_low || [];
    assert.ok(flags.includes('F3'));
  });
});

describe('F8 confidence gating', () => {
  it('borderline F8 value flagged', () => {
    const rule = scoreRule('Use strict TypeScript', 0.55, 0.55);
    const flags = rule.factor_confidence_low || [];
    assert.ok(flags.includes('F8'));
  });

  it('clear F8 value not flagged', () => {
    const rule = scoreRule('Use strict TypeScript', 0.55, 0.9);
    const flags = rule.factor_confidence_low || [];
    assert.ok(!flags.includes('F8'));
  });

  it('F8 value of null flagged (uncertain)', () => {
    const rule = scoreRule('Use strict TypeScript', 0.55, null);
    const flags = rule.factor_confidence_low || [];
    assert.ok(flags.includes('F8'));
  });
});

describe('pipeline integration', () => {
  it('prior factors preserved', () => {
    const rule = scoreRule('ALWAYS validate input');
    assert.ok('F1' in rule.factors);
    assert.ok('F2' in rule.factors);
    assert.ok('F4' in rule.factors);
  });

  it('schema carried forward: top-level extra fields survive pass-through', () => {
    const data = {
      custom_field: 'preserved',
      source_files: [
        {
          path: 'test.md',
          globs: [],
          glob_match_count: null,
          default_category: 'mandate',
          line_count: 10,
          always_loaded: true,
        },
      ],
      rules: [
        {
          id: 'R001',
          file_index: 0,
          text: 'Always test',
          line_start: 1,
          line_end: 1,
          category: 'mandate',
          staleness: { gated: false, missing_entities: [] },
          factors: {
            F1: { value: 0.85 },
            F2: { value: 0.85 },
            F4: { value: 0.95 },
            F3: { value: 0.55, level: 2, method: 'judgment' },
            F8: { value: 0.55, level: 2, method: 'judgment' },
          },
        },
      ],
    };
    const result = runScript('score_semi.js', data);
    assert.equal(result.custom_field, 'preserved');
  });

  it('no crash when F3/F8 absent from factors', () => {
    const data = {
      source_files: [
        {
          path: 'test.md',
          globs: [],
          glob_match_count: null,
          default_category: 'mandate',
          line_count: 10,
          always_loaded: true,
        },
      ],
      rules: [
        {
          id: 'R001',
          file_index: 0,
          text: 'Always test',
          line_start: 1,
          line_end: 1,
          category: 'mandate',
          staleness: { gated: false, missing_entities: [] },
          factors: { F1: { value: 0.85 }, F2: { value: 0.85 }, F4: { value: 0.95 } },
        },
      ],
    };
    const result = runScript('score_semi.js', data);
    assert.ok('rules' in result);
  });
});
