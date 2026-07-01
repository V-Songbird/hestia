'use strict';

// Tests for build_prompt.js and merge_batch_patches.js.
//
// build_prompt.js: JSON payload -> markdown LLM prompt. Optionally batches.
// merge_batch_patches.js: batch_dir + scored_semi.json -> merged patches.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScriptRaw } = require('./helpers');

// ---------------------------------------------------------------------------
// build_prompt.js helpers
// ---------------------------------------------------------------------------

function makePayload(rules, sourceFiles, projectContext) {
  return {
    schema_version: '0.1',
    project_root: '/test',
    project_context: projectContext || {
      stack: ['Python', 'pytest'],
      always_loaded_files: ['CLAUDE.md'],
      glob_scoped_files: [],
      tooling: { pre_commit: false, ci: false },
    },
    source_files: sourceFiles || [
      { path: 'CLAUDE.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 20, always_loaded: true },
    ],
    rules,
  };
}

function makeRule(ruleId, text, fileIndex, lineStart, category) {
  const ls = lineStart === undefined ? 5 : lineStart;
  return {
    id: ruleId,
    file_index: fileIndex === undefined ? 0 : fileIndex,
    text,
    line_start: ls,
    line_end: ls,
    category: category || 'mandate',
    staleness: { gated: false, missing_entities: [] },
    factors: { F1: { value: 0.85 }, F2: { value: 0.85 }, F4: { value: 0.95 } },
    factor_confidence_low: [],
  };
}

function makeManyRules(count) {
  const rules = [];
  for (let i = 1; i <= count; i++) {
    rules.push(makeRule(`R${String(i).padStart(3, '0')}`, `Rule number ${i}`));
  }
  return rules;
}

/** Run build_prompt.js; return { stdout, stderr }. */
function runBuildPrompt(payload, batchDir) {
  const args = batchDir ? ['--batch-dir', batchDir] : [];
  const result = runScriptRaw('build_prompt.js', payload, args);
  if (result.status !== 0) {
    throw new Error(`build_prompt.js exited ${result.status}\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-batching-'));
}

// ---------------------------------------------------------------------------
// Single-prompt mode
// ---------------------------------------------------------------------------

describe('single prompt mode', () => {
  test('prompt contains rules table', () => {
    const rules = [makeRule('R001', 'ALWAYS validate user input')];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('R001'));
    assert.ok(stdout.includes('ALWAYS validate user input'));
  });

  test('prompt contains F3 and F8 rubrics', () => {
    const rules = [makeRule('R001', 'Use functional components')];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('F3'));
    assert.ok(stdout.includes('F8'));
  });

  test('prompt contains response format', () => {
    const rules = [makeRule('R001', 'Use strict typing')];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('Response format'));
    assert.ok(
      stdout.toLowerCase().includes('json array') ||
      stdout.includes('["id"') ||
      stdout.includes('"F3"')
    );
  });

  test('stack in prompt', () => {
    const rules = [makeRule('R001', 'Use React hooks')];
    const payload = makePayload(rules, undefined, {
      stack: ['TypeScript', 'React'],
      always_loaded_files: ['CLAUDE.md'],
      glob_scoped_files: [],
      tooling: { eslint: true },
    });
    const { stdout } = runBuildPrompt(payload);
    assert.ok(stdout.includes('TypeScript') || stdout.includes('React'));
  });

  test('glob scoped file noted', () => {
    const rules = [makeRule('R001', 'Use async/await', 1)];
    const sourceFiles = [
      { path: 'CLAUDE.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 10, always_loaded: true },
      { path: '.claude/rules/api.md', globs: ['src/api/**/*.ts'],
        glob_match_count: 12, default_category: 'mandate',
        line_count: 10, always_loaded: false },
    ];
    const payload = makePayload(rules, sourceFiles);
    const { stdout } = runBuildPrompt(payload);
    assert.ok(stdout.includes('src/api/**/*.ts'));
  });

  test('always loaded file noted', () => {
    const rules = [makeRule('R001', 'Use strict types')];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('always-loaded') || stdout.includes('CLAUDE.md'));
  });

  test('long rule text truncated', () => {
    const longText = 'A'.repeat(200);
    const rules = [makeRule('R001', longText)];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('A'.repeat(120)));
    assert.ok(stdout.includes('...'));
  });

  test('empty rules does not crash', () => {
    const { stdout } = runBuildPrompt(makePayload([]));
    assert.ok(stdout.includes('F3'));
    assert.ok(stdout.includes('F8'));
  });

  test('multiple rules all appear', () => {
    const rules = [
      makeRule('R001', 'Never use eval()'),
      makeRule('R002', 'Always use strict mode'),
    ];
    const { stdout } = runBuildPrompt(makePayload(rules));
    assert.ok(stdout.includes('R001'));
    assert.ok(stdout.includes('R002'));
  });

  test('confidence flag F3 in flags', () => {
    const rule = makeRule('R001', 'Maybe follow guidelines');
    rule.factor_confidence_low = ['F3'];
    rule.factors.F3 = { value: 0.35 };
    const { stdout } = runBuildPrompt(makePayload([rule]));
    assert.ok(stdout.includes('F3: mech='));
  });

  test('confidence flag F8 in flags', () => {
    const rule = makeRule('R001', 'Use consistent naming');
    rule.factor_confidence_low = ['F8'];
    rule.factors.F8 = { value: 0.65 };
    const { stdout } = runBuildPrompt(makePayload([rule]));
    assert.ok(stdout.includes('F8: mech='));
  });

  test('no flags shows dash', () => {
    const rule = makeRule('R001', 'Use strict types');
    rule.factor_confidence_low = [];
    const { stdout } = runBuildPrompt(makePayload([rule]));
    assert.ok(stdout.includes('—'));
  });
});

// ---------------------------------------------------------------------------
// Batch mode
// ---------------------------------------------------------------------------

describe('batch mode', () => {
  test('single prompt below threshold', () => {
    // 20 rules -> no batching; single prompt to stdout.
    const rules = makeManyRules(20);
    const batchDir = path.join(makeTmpDir(), 'batches');
    const { stdout } = runBuildPrompt(makePayload(rules), batchDir);
    assert.ok(!fs.existsSync(batchDir));
    assert.ok(stdout.includes('R001'));
  });

  test('batch mode above threshold', () => {
    // 21 rules -> batching; prompt files created in batch_dir.
    const rules = makeManyRules(21);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules), batchDir);
    assert.ok(fs.existsSync(batchDir));
    const promptFiles = fs.readdirSync(batchDir).filter((f) => /^prompt_.*\.md$/.test(f)).sort();
    assert.ok(promptFiles.length >= 2);
  });

  test('batch manifest created', () => {
    // Batch mode creates batch_manifest.json.
    const rules = makeManyRules(21);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules), batchDir);
    const manifestPath = path.join(batchDir, 'batch_manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok('batches' in manifest);
    assert.equal(manifest.total_rules, 21);
  });

  test('manifest rule ids cover all', () => {
    // All rule IDs appear in manifest batches.
    const rules = makeManyRules(25);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules), batchDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, 'batch_manifest.json'), 'utf-8'));
    const allIds = new Set();
    for (const b of manifest.batches) {
      for (const rid of b.rule_ids) allIds.add(rid);
    }
    const expected = new Set();
    for (let i = 1; i <= 25; i++) expected.add(`R${String(i).padStart(3, '0')}`);
    assert.deepEqual(allIds, expected);
  });

  test('batch size respected', () => {
    // No batch exceeds BATCH_SIZE_DEFAULT (12) rules.
    const rules = makeManyRules(30);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules), batchDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, 'batch_manifest.json'), 'utf-8'));
    const batchSize = manifest.batch_size_target || 12;
    for (const b of manifest.batches) {
      assert.ok(b.rule_ids.length <= batchSize);
    }
  });

  test('continuation note in same file batches', () => {
    // When one file's rules split across batches, continuation note appears.
    const rules = makeManyRules(25);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules), batchDir);
    const promptFiles = fs.readdirSync(batchDir).filter((f) => /^prompt_.*\.md$/.test(f)).sort();
    const texts = promptFiles.map((f) => fs.readFileSync(path.join(batchDir, f), 'utf-8'));
    const hasContinuation = texts.slice(1).some(
      (t) => t.toLowerCase().includes('continuation') || t.toLowerCase().includes('continue')
    );
    assert.ok(hasContinuation);
  });

  test('file cohesion respected', () => {
    // Rules from the same file prefer to stay in the same batch.
    const sourceFiles = [
      { path: 'file_a.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 40, always_loaded: true },
      { path: 'file_b.md', globs: [], glob_match_count: null,
        default_category: 'mandate', line_count: 40, always_loaded: true },
    ];
    const rulesA = [];
    for (let i = 1; i <= 11; i++) rulesA.push(makeRule(`A${String(i).padStart(3, '0')}`, `Rule A${i}`, 0, i));
    const rulesB = [];
    for (let i = 1; i <= 11; i++) rulesB.push(makeRule(`B${String(i).padStart(3, '0')}`, `Rule B${i}`, 1, i));
    const rules = rulesA.concat(rulesB);
    const batchDir = path.join(makeTmpDir(), 'batches');
    runBuildPrompt(makePayload(rules, sourceFiles), batchDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, 'batch_manifest.json'), 'utf-8'));
    const firstBatchIds = new Set(manifest.batches[0].rule_ids);
    const aInFirst = [...firstBatchIds].filter((rid) => rid.startsWith('A'));
    const bInFirst = [...firstBatchIds].filter((rid) => rid.startsWith('B'));
    // File A's rules should dominate the first batch, not be mixed with File B
    assert.ok(aInFirst.length > bInFirst.length || bInFirst.length === 0);
  });
});

// ---------------------------------------------------------------------------
// merge_batch_patches.js helpers
// ---------------------------------------------------------------------------

function writePatchFile(batchDir, name, patches) {
  const p = {
    schema_version: '0.1',
    model_version: 'test-model-1',
    patches,
  };
  fs.writeFileSync(path.join(batchDir, name), JSON.stringify(p), 'utf-8');
}

function writeScoredSemi(filePath, ruleIds) {
  const data = { schema_version: '0.1', rules: ruleIds.map((rid) => ({ id: rid })) };
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

/** Run merge_batch_patches.js, return { parsed output, stderr }. */
function runMergePatches(batchDir, scoredSemiPath, outputPath) {
  const args = [batchDir, scoredSemiPath];
  if (outputPath) args.push('--output', outputPath);
  const result = runScriptRaw('merge_batch_patches.js', null, args);
  if (result.status !== 0) {
    throw new Error(`merge_batch_patches.js exited ${result.status}\n${result.stderr}`);
  }
  if (outputPath) {
    return { out: JSON.parse(fs.readFileSync(outputPath, 'utf-8')), stderr: result.stderr };
  }
  return { out: JSON.parse(result.stdout), stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// merge_batch_patches tests
// ---------------------------------------------------------------------------

describe('merge batch patches', () => {
  test('merges two batches', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001', 'R002']);

    writePatchFile(batchDir, 'patches_001.json', {
      R001: {
        F3: { value: 0.80, level: 3, reasoning: 'ok' },
        F8: { value: 0.65, level: 2, reasoning: 'ok' },
      },
    });
    writePatchFile(batchDir, 'patches_002.json', {
      R002: {
        F3: { value: 0.50, level: 2, reasoning: 'ok' },
        F8: { value: 0.40, level: 1, reasoning: 'ok' },
      },
    });

    const { out } = runMergePatches(batchDir, scoredSemi);
    assert.ok('R001' in out.patches);
    assert.ok('R002' in out.patches);
  });

  test('schema version in output', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001']);
    writePatchFile(batchDir, 'patches_001.json', {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
    });
    const { out } = runMergePatches(batchDir, scoredSemi);
    assert.equal(out.schema_version, '0.1');
  });

  test('duplicate id last wins', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001']);
    writePatchFile(batchDir, 'patches_001.json', {
      R001: { F3: { value: 0.50, level: 2 }, F8: { value: 0.40, level: 1 } },
    });
    writePatchFile(batchDir, 'patches_002.json', {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
    });
    const { out, stderr } = runMergePatches(batchDir, scoredSemi);
    assert.equal(out.patches.R001.F3.value, 0.80);
    assert.ok(stderr.includes('WARNING'));
  });

  test('missing rule warns', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001', 'R002']);
    writePatchFile(batchDir, 'patches_001.json', {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
    });
    const { stderr } = runMergePatches(batchDir, scoredSemi);
    assert.ok(stderr.includes('WARNING'));
  });

  test('extra rule in patches warns', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001']);
    writePatchFile(batchDir, 'patches_001.json', {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
      R999: { F3: { value: 0.50, level: 2 }, F8: { value: 0.40, level: 1 } },
    });
    const { stderr } = runMergePatches(batchDir, scoredSemi);
    assert.ok(stderr.includes('WARNING'));
  });

  test('no patch files fatal', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001']);

    const result = runScriptRaw('merge_batch_patches.js', null, [batchDir, scoredSemi]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('FATAL'));
  });

  test('write to output file', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    const outputPath = path.join(tmpDir, 'merged.json');
    writeScoredSemi(scoredSemi, ['R001']);
    writePatchFile(batchDir, 'patches_001.json', {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
    });
    const { out } = runMergePatches(batchDir, scoredSemi, outputPath);
    assert.ok(fs.existsSync(outputPath));
    assert.ok('R001' in out.patches);
  });

  test('schema version mismatch warns', () => {
    const tmpDir = makeTmpDir();
    const batchDir = path.join(tmpDir, 'batches');
    fs.mkdirSync(batchDir);
    const scoredSemi = path.join(tmpDir, 'scored_semi.json');
    writeScoredSemi(scoredSemi, ['R001', 'R002']);

    const p1 = { schema_version: '0.1', model_version: 'test-model', patches: {
      R001: { F3: { value: 0.80, level: 3 }, F8: { value: 0.65, level: 2 } },
    } };
    const p2 = { schema_version: '0.2', model_version: 'test-model', patches: {
      R002: { F3: { value: 0.50, level: 2 }, F8: { value: 0.40, level: 1 } },
    } };
    fs.writeFileSync(path.join(batchDir, 'patches_001.json'), JSON.stringify(p1));
    fs.writeFileSync(path.join(batchDir, 'patches_002.json'), JSON.stringify(p2));

    const { stderr } = runMergePatches(batchDir, scoredSemi);
    assert.ok(stderr.includes('WARNING'));
  });
});
