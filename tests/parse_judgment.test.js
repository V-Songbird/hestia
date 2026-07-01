'use strict';

// Tests for parse_judgment.js — model output parsing, level validation, tolerances.
//
// parse_judgment.js takes:
//   - positional arg: <scored_semi.json> (has list of rules with ids)
//   - stdin (or --input file): raw model output (JSON array, possibly with fences)
//   - optional --output file
//
// Output: {schema_version, model_version, patches: {rule_id: {F3: {...}, F8: {...}}}}

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScriptRaw } = require('./helpers');

function writeScoredSemi(ruleIds) {
  const scoredSemi = {
    schema_version: '0.1',
    rules: ruleIds.map((rid) => ({ id: rid })),
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-semi-'));
  const semiPath = path.join(tmpDir, 'scored_semi.json');
  fs.writeFileSync(semiPath, JSON.stringify(scoredSemi), 'utf-8');
  return semiPath;
}

/** Run parse_judgment.js, return [parsed output, stderr]. */
function runParse(ruleIds, modelOutput, { expectedIds } = {}) {
  const semiPath = writeScoredSemi(ruleIds);
  const args = [semiPath];
  if (expectedIds !== undefined) {
    args.push('--expected-ids', expectedIds.join(','));
  }
  const result = runScriptRaw('parse_judgment.js', modelOutput, args);
  fs.rmSync(path.dirname(semiPath), { recursive: true, force: true });
  if (result.status !== 0) {
    const err = new Error(`parse_judgment.js exited ${result.status}\n${result.stderr}`);
    err.result = result;
    throw err;
  }
  return [JSON.parse(result.stdout), result.stderr];
}

/** Run parse_judgment.js and return the raw spawnSync result. */
function runParseRaw(ruleIds, modelOutput) {
  const semiPath = writeScoredSemi(ruleIds);
  const result = runScriptRaw('parse_judgment.js', modelOutput, [semiPath]);
  fs.rmSync(path.dirname(semiPath), { recursive: true, force: true });
  return result;
}

function validEntry(ruleId, { f3Value = 0.80, f3Level = 3, f8Value = 0.65, f8Level = 2 } = {}) {
  return {
    id: ruleId,
    F3: { value: f3Value, level: f3Level, reasoning: 'Clear trigger context.' },
    F8: { value: f8Value, level: f8Level, reasoning: 'Linter can enforce this.' },
  };
}

// ---------------------------------------------------------------------------
// Happy-path parsing
// ---------------------------------------------------------------------------

describe('HappyPath', () => {
  it('basic parse', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.equal(out.schema_version, '0.1');
    assert.ok('patches' in out);
    assert.ok('R001' in out.patches);
  });

  it('F3/F8 present', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    const patch = out.patches.R001;
    assert.ok('F3' in patch);
    assert.ok('F8' in patch);
    assert.equal(patch.F3.value, 0.80);
    assert.equal(patch.F8.value, 0.65);
  });

  it('multiple rules', () => {
    const entries = [validEntry('R001'), validEntry('R002'), validEntry('R003')];
    const [out] = runParse(['R001', 'R002', 'R003'], entries);
    assert.deepEqual(new Set(Object.keys(out.patches)), new Set(['R001', 'R002', 'R003']));
  });

  it('level in output', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.equal(out.patches.R001.F3.level, 3);
  });

  it('reasoning in output', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.ok('reasoning' in out.patches.R001.F3);
  });

  it('reasoning truncated at 80', () => {
    const longReason = 'A'.repeat(120);
    const entry = validEntry('R001');
    entry.F3.reasoning = longReason;
    const [out] = runParse(['R001'], [entry]);
    assert.ok(out.patches.R001.F3.reasoning.length <= 80);
  });
});

// ---------------------------------------------------------------------------
// Markdown fence stripping
// ---------------------------------------------------------------------------

describe('FenceStripping', () => {
  it('json fences stripped', () => {
    const entries = [validEntry('R001')];
    const raw = '```json\n' + JSON.stringify(entries) + '\n```';
    const [out] = runParse(['R001'], raw);
    assert.ok('R001' in out.patches);
  });

  it('plain fences stripped', () => {
    const entries = [validEntry('R001')];
    const raw = '```\n' + JSON.stringify(entries) + '\n```';
    const [out] = runParse(['R001'], raw);
    assert.ok('R001' in out.patches);
  });

  it('prose before array', () => {
    const entries = [validEntry('R001')];
    const raw = 'Sure! Here are the judgments:\n\n' + JSON.stringify(entries);
    const [out] = runParse(['R001'], raw);
    assert.ok('R001' in out.patches);
  });

  it('prose after array', () => {
    const entries = [validEntry('R001')];
    const raw = JSON.stringify(entries) + '\n\nLet me know if you need more details.';
    const [out] = runParse(['R001'], raw);
    assert.ok('R001' in out.patches);
  });

  it('nested object in prose (extracts the correct array)', () => {
    const entries = [validEntry('R001')];
    const raw = 'Here is the analysis: {"note": "blah"}\n\n' + JSON.stringify(entries);
    const [out] = runParse(['R001'], raw);
    assert.ok('R001' in out.patches);
  });
});

// ---------------------------------------------------------------------------
// Level validation
// ---------------------------------------------------------------------------

describe('LevelValidation', () => {
  it('F3 level 0 to 4 valid', () => {
    for (const [level, value] of [[0, 0.05], [1, 0.25], [2, 0.50], [3, 0.75], [4, 0.95]]) {
      const [out] = runParse(
        ['R001'],
        [{ id: 'R001', F3: { value, level, reasoning: 'ok' }, F8: { value: 0.65, level: 2, reasoning: 'ok' } }]
      );
      assert.equal(out.patches.R001.F3.level, level);
    }
  });

  it('F8 level 0 to 3 valid', () => {
    for (const [level, value] of [[0, 0.175], [1, 0.40], [2, 0.675], [3, 0.925]]) {
      const [out] = runParse(
        ['R001'],
        [{ id: 'R001', F3: { value: 0.80, level: 3, reasoning: 'ok' }, F8: { value, level, reasoning: 'ok' } }]
      );
      assert.equal(out.patches.R001.F8.level, level);
    }
  });

  it('value outside level range corrected (value=0.80 with level=0 -> corrected to level-0 midpoint)', () => {
    const entry = {
      id: 'R001',
      F3: { value: 0.80, level: 0, reasoning: 'mismatch test' },
      F8: { value: 0.65, level: 2, reasoning: 'ok' },
    };
    const [out, stderr] = runParse(['R001'], [entry]);
    const patchF3 = out.patches.R001.F3;
    // Level wins: value corrected to midpoint of level-0 range [0.00, 0.10]
    assert.equal(patchF3.level, 0);
    assert.ok(patchF3.value <= 0.10);
    assert.ok(stderr.includes('WARNING'));
  });

  it('out-of-range value clamped (value > 1.0 -> clamped and warning emitted)', () => {
    const entry = {
      id: 'R001',
      F3: { value: 1.5, level: 4, reasoning: 'clamped' },
      F8: { value: 0.65, level: 2, reasoning: 'ok' },
    };
    const [out, stderr] = runParse(['R001'], [entry]);
    assert.ok(out.patches.R001.F3.value <= 1.0);
    assert.ok(stderr.includes('WARNING'));
  });

  it('value zero is valid (value=0.0 with level=0 is valid)', () => {
    const entry = {
      id: 'R001',
      F3: { value: 0.0, level: 0, reasoning: 'zero' },
      F8: { value: 0.65, level: 2, reasoning: 'ok' },
    };
    const [out] = runParse(['R001'], [entry]);
    assert.equal(out.patches.R001.F3.value, 0.0);
  });
});

// ---------------------------------------------------------------------------
// Null factor handling
// ---------------------------------------------------------------------------

describe('NullFactorHandling', () => {
  it('null value/null level accepted', () => {
    const entry = {
      id: 'R001',
      F3: { value: null, level: null, reasoning: 'could not score' },
      F8: { value: 0.65, level: 2, reasoning: 'ok' },
    };
    const [out] = runParse(['R001'], [entry]);
    const patchF3 = out.patches.R001.F3;
    assert.equal(patchF3.value, null);
    assert.equal(patchF3.level, null);
  });

  it('missing F3 inserts null entry', () => {
    const entry = {
      id: 'R001',
      F8: { value: 0.65, level: 2, reasoning: 'ok' },
    };
    const [out, stderr] = runParse(['R001'], [entry]);
    const patchF3 = out.patches.R001.F3;
    assert.equal(patchF3.value, null);
    assert.ok(stderr.includes('WARNING'));
  });

  it('missing F8 inserts null entry', () => {
    const entry = {
      id: 'R001',
      F3: { value: 0.80, level: 3, reasoning: 'ok' },
    };
    const [out, stderr] = runParse(['R001'], [entry]);
    const patchF8 = out.patches.R001.F8;
    assert.equal(patchF8.value, null);
    assert.ok(stderr.includes('WARNING'));
  });
});

// ---------------------------------------------------------------------------
// Missing ID handling
// ---------------------------------------------------------------------------

describe('MissingIdHandling', () => {
  it('missing rule inserts null entry', () => {
    const entries = [validEntry('R001')];
    const [out, stderr] = runParse(['R001', 'R002'], entries);
    assert.ok('R002' in out.patches);
    assert.equal(out.patches.R002.F3.value, null);
    assert.ok(stderr.includes('WARNING'));
  });

  it('unexpected rule id ignored', () => {
    const entries = [validEntry('R001'), validEntry('R999')];
    const [out, stderr] = runParse(['R001'], entries);
    assert.ok(!('R999' in out.patches));
    assert.ok(stderr.includes('WARNING'));
  });

  it('duplicate entry last wins', () => {
    const entries = [
      validEntry('R001', { f3Value: 0.50, f3Level: 2 }),
      validEntry('R001', { f3Value: 0.80, f3Level: 3 }),
    ];
    const [out, stderr] = runParse(['R001'], entries);
    assert.equal(out.patches.R001.F3.value, 0.80);
    assert.ok(stderr.includes('WARNING'));
  });

  it('too many missing ids fatal (more than tolerance missing -> returncode != 0)', () => {
    const ruleIds = Array.from({ length: 21 }, (_, i) => `R${String(i + 1).padStart(3, '0')}`);
    const entries = [validEntry('R001')];
    const proc = runParseRaw(ruleIds, entries);
    assert.notEqual(proc.status, 0);
    assert.ok(proc.stderr.includes('FATAL'));
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('SchemaValidation', () => {
  it('schema_version in output', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.equal(out.schema_version, '0.1');
  });

  it('model_version in output', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.ok('model_version' in out);
  });

  it('patches key present', () => {
    const [out] = runParse(['R001'], [validEntry('R001')]);
    assert.equal(typeof out.patches, 'object');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('ErrorHandling', () => {
  it('no JSON array fatal', () => {
    const proc = runParseRaw(['R001'], 'This is not JSON.');
    assert.notEqual(proc.status, 0);
    assert.ok(proc.stderr.includes('FATAL'));
  });

  it('empty input fatal', () => {
    const proc = runParseRaw(['R001'], '');
    assert.notEqual(proc.status, 0);
    assert.ok(proc.stderr.includes('FATAL'));
  });

  it('entry missing id skipped', () => {
    const entries = [
      { F3: { value: 0.80, level: 3, reasoning: 'ok' }, F8: { value: 0.65, level: 2, reasoning: 'ok' } },
      validEntry('R001'),
    ];
    const [out, stderr] = runParse(['R001'], entries);
    assert.ok('R001' in out.patches);
    assert.ok(stderr.includes('WARNING'));
  });

  it('wrong schema_version fatal (scored_semi.json with wrong schema_version -> fatal)', () => {
    const scoredSemi = { schema_version: '9.9', rules: [{ id: 'R001' }] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-semi-'));
    const semiPath = path.join(tmpDir, 'scored_semi.json');
    fs.writeFileSync(semiPath, JSON.stringify(scoredSemi), 'utf-8');

    const proc = runScriptRaw('parse_judgment.js', [validEntry('R001')], [semiPath]);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert.notEqual(proc.status, 0);
    assert.ok(proc.stderr.includes('FATAL'));
  });
});

// ---------------------------------------------------------------------------
// --expected-ids override
// ---------------------------------------------------------------------------

describe('ExpectedIdsOverride', () => {
  it('expected-ids narrows scope (passing --expected-ids R002 ignores R001 even if present in scored_semi)', () => {
    const entries = [validEntry('R001'), validEntry('R002')];
    const [out] = runParse(['R001', 'R002'], entries, { expectedIds: ['R002'] });
    // R001 may appear as unexpected warning, but R002 must be present
    assert.ok('R002' in out.patches);
  });

  it('expected-ids missing in output fatal (if expected_ids has R999 but model did not return it, warn)', () => {
    const entries = [validEntry('R001')];
    // With --expected-ids, only R001 is expected
    const [out] = runParse(['R001'], entries, { expectedIds: ['R001'] });
    assert.ok('R001' in out.patches);
  });
});

// ---------------------------------------------------------------------------
// F6/F7/F1 optional patch passthrough
// ---------------------------------------------------------------------------

describe('KnownPatchFields', () => {
  it('F7_patch passthrough', () => {
    const entry = validEntry('R001');
    entry.F7_patch = { value: 0.95, reasoning: 'Override from judgment' };
    const [out] = runParse(['R001'], [entry]);
    assert.ok('F7_patch' in out.patches.R001);
    assert.equal(out.patches.R001.F7_patch.value, 0.95);
  });

  it('F6_patch passthrough', () => {
    const entry = validEntry('R001');
    entry.F6_patch = { value: 0.80, reasoning: 'Override' };
    const [out] = runParse(['R001'], [entry]);
    assert.ok('F6_patch' in out.patches.R001);
  });

  it('F1_patch passthrough', () => {
    const entry = validEntry('R001');
    entry.F1_patch = { value: 1.0, reasoning: 'Override' };
    const [out] = runParse(['R001'], [entry]);
    assert.ok('F1_patch' in out.patches.R001);
  });

  it('patch without value key dropped', () => {
    const entry = validEntry('R001');
    entry.F7_patch = { reasoning: 'no value key' };
    const [out, stderr] = runParse(['R001'], [entry]);
    assert.ok(!('F7_patch' in out.patches.R001));
    assert.ok(stderr.includes('WARNING'));
  });

  it('patch out of range dropped', () => {
    const entry = validEntry('R001');
    entry.F7_patch = { value: 1.5, reasoning: 'over range' };
    const [out, stderr] = runParse(['R001'], [entry]);
    assert.ok(!('F7_patch' in out.patches.R001));
    assert.ok(stderr.includes('WARNING'));
  });

  it('patch null value accepted', () => {
    const entry = validEntry('R001');
    entry.F7_patch = { value: null, reasoning: 'could not score' };
    const [out] = runParse(['R001'], [entry]);
    assert.ok('F7_patch' in out.patches.R001);
    assert.equal(out.patches.R001.F7_patch.value, null);
  });
});
