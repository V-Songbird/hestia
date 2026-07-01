'use strict';

// Verify-the-detector discipline (Phase 3 epistemics upgrade).
//
// THE RULE
// --------
// Every Hestia DETECTOR has a NEGATIVE fixture proving it fires. A detector
// tested only on clean input is indistinguishable from a broken one: if it
// "passes" by emitting nothing, a silently-broken detector that never fires on
// real problems looks exactly the same. (Grounded in iceberg's rule — a detector
// you've never seen fire might be silently passing everything.)
//
// So each detector here is exercised as a PAIR:
//   * a CLEAN input  -> assert the finding does NOT fire (no false positive), and
//   * a KNOWN-BAD input -> assert the finding DOES fire, with the correct
//     severity/shape per the Phase-1 finding contract (cited + triple-shape).
//
// Each negative assertion targets the SPECIFIC finding (by tag/artifact/symptom),
// not merely "the script ran without error" — so neutering the detector would make
// the test fail.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runScript, makeTmpProject } = require('./helpers');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const refsMod = require(path.join(SCRIPTS_DIR, 'refs.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh project root that discover() will accept as a real project. */
function gitProject() {
  const root = makeTmpProject();
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function checkup(root) {
  return runScript('checkup.js', null, ['--project-root', root]);
}

function findingsWithTag(out, tag) {
  return out.findings.filter((f) => (f.tags || []).includes(tag));
}

function findingsForArtifact(out, artifact) {
  return out.findings.filter((f) => f.artifact === artifact);
}

function assertContract(f) {
  // Phase-1 finding contract: cited (has a locator) + triple-shape.
  assert.ok(f.file, `cite-or-drop: finding has no file locator: ${JSON.stringify(f)}`);
  assert.ok(f.location, `cite-or-drop: finding has no location: ${JSON.stringify(f)}`);
  assert.equal(f.advisory, false, `detector finding must not be advisory: ${JSON.stringify(f)}`);
  assert.ok(f.symptom, `triple-shape: missing symptom: ${JSON.stringify(f)}`);
  assert.ok(f.why, `triple-shape: missing why: ${JSON.stringify(f)}`);
  assert.ok(f.fix_action, `triple-shape: missing fix_action: ${JSON.stringify(f)}`);
}

// ---------------------------------------------------------------------------
// checkup probe: missing CLAUDE.md (near-empty onboarding)
// ---------------------------------------------------------------------------

describe('missing CLAUDE.md', () => {
  test('fires: a project with no CLAUDE.md must produce the high-severity finding', () => {
    const root = gitProject(); // nothing else: no CLAUDE.md at all
    const out = checkup(root);
    const cm = findingsForArtifact(out, 'claude-md');
    const missing = cm.filter((f) => f.symptom.includes('No CLAUDE.md'));
    assert.ok(missing.length, `missing-CLAUDE.md detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = missing[0];
    assert.equal(f.severity, 'high');
    assert.equal(out.near_empty, true);
    assertContract(f);
  });

  test('does not fire: a project WITH a CLAUDE.md must NOT raise the missing finding', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n\nRun the tests.\n', 'utf-8');
    const out = checkup(root);
    const missing = out.findings.filter((f) => f.symptom.includes('No CLAUDE.md'));
    assert.deepEqual(missing, [], `false positive: ${JSON.stringify(missing)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe: oversized project CLAUDE.md
// ---------------------------------------------------------------------------

describe('oversized CLAUDE.md', () => {
  test('fires', () => {
    const root = gitProject();
    const lines = [];
    for (let i = 0; i < 260; i++) lines.push(`line ${i}`);
    const big = '# Proj\n' + lines.join('\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), big, 'utf-8');
    const out = checkup(root);
    const size = findingsForArtifact(out, 'claude-md').filter((f) => (f.tags || []).includes('size'));
    assert.ok(size.length, `oversized-CLAUDE.md detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = size[0];
    assert.equal(f.severity, 'medium');
    assert.ok(f.symptom.includes('long'));
    assertContract(f);
  });

  test('does not fire: small CLAUDE.md', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n\nRun the tests.\n', 'utf-8');
    const out = checkup(root);
    const size = findingsForArtifact(out, 'claude-md').filter((f) => (f.tags || []).includes('size'));
    assert.deepEqual(size, [], `false positive: ${JSON.stringify(size)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe: oversized SKILL.md body
// ---------------------------------------------------------------------------

describe('oversized SKILL.md', () => {
  function writeSkill(root, bodyLines) {
    const skdir = path.join(root, '.claude', 'skills', 'demo');
    fs.mkdirSync(skdir, { recursive: true });
    const lines = [];
    for (let i = 0; i < bodyLines; i++) lines.push(`step ${i}`);
    const body = '---\nname: demo\ndescription: a demo skill\n---\n' + lines.join('\n');
    fs.writeFileSync(path.join(skdir, 'SKILL.md'), body, 'utf-8');
  }

  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8'); // avoid near-empty
    writeSkill(root, 560);
    const out = checkup(root);
    const size = findingsForArtifact(out, 'skill').filter((f) => (f.tags || []).includes('size'));
    assert.ok(size.length, `oversized-SKILL.md detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = size[0];
    assert.equal(f.severity, 'medium');
    assertContract(f);
  });

  test('does not fire: small skill', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    writeSkill(root, 20);
    const out = checkup(root);
    const size = findingsForArtifact(out, 'skill').filter((f) => (f.tags || []).includes('size'));
    assert.deepEqual(size, [], `false positive: ${JSON.stringify(size)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe: agent without frontmatter
// ---------------------------------------------------------------------------

describe('agent no frontmatter', () => {
  function writeAgent(root, text) {
    const ag = path.join(root, '.claude', 'agents');
    fs.mkdirSync(ag, { recursive: true });
    fs.writeFileSync(path.join(ag, 'demo.md'), text, 'utf-8');
  }

  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    writeAgent(root, 'just prose, no YAML frontmatter at all\n');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'agent').filter((f) => f.symptom === 'Agent has no frontmatter');
    assert.ok(hits.length, `no-frontmatter detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = hits[0];
    assert.equal(f.severity, 'high');
    assert.ok((f.tags || []).includes('frontmatter'));
    assertContract(f);
  });

  test('does not fire: agent with frontmatter', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    writeAgent(root, '---\nname: demo\ndescription: a demo agent\n---\nbody\n');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'agent').filter((f) => f.symptom === 'Agent has no frontmatter');
    assert.deepEqual(hits, [], `false positive: ${JSON.stringify(hits)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe: agent frontmatter missing name/description
// ---------------------------------------------------------------------------

describe('agent missing description', () => {
  function writeAgent(root, fm) {
    const ag = path.join(root, '.claude', 'agents');
    fs.mkdirSync(ag, { recursive: true });
    fs.writeFileSync(path.join(ag, 'demo.md'), fm, 'utf-8');
  }

  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    // Has frontmatter and a name, but no description.
    writeAgent(root, '---\nname: demo\n---\nbody\n');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'agent').filter(
      (f) => f.symptom.includes('missing') && f.symptom.includes('description')
    );
    assert.ok(hits.length, `missing-description detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = hits[0];
    assert.equal(f.severity, 'medium');
    assertContract(f);
  });

  test('does not fire: complete frontmatter', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    writeAgent(root, '---\nname: demo\ndescription: a complete agent\n---\nbody\n');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'agent').filter((f) => f.symptom.includes('missing'));
    assert.deepEqual(hits, [], `false positive: ${JSON.stringify(hits)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe + shared refs.js: broken path references
// ---------------------------------------------------------------------------

describe('checkup broken refs', () => {
  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      '# Proj\n\nSee `./docs/gone.md` for the build steps.\n',
      'utf-8'
    );
    const out = checkup(root);
    const stale = findingsWithTag(out, 'stale');
    assert.ok(stale.length, `broken-ref detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = stale[0];
    assert.equal(f.severity, 'high');
    assert.equal(f.artifact, 'reference');
    assert.ok(f.symptom.includes('missing files'));
    assertContract(f);
  });

  test('does not fire: resolvable refs', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'real.md'), 'here\n', 'utf-8');
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      '# Proj\n\nSee `./real.md` for details.\n',
      'utf-8'
    );
    const out = checkup(root);
    const stale = findingsWithTag(out, 'stale');
    assert.deepEqual(stale, [], `false positive: ${JSON.stringify(stale)}`);
  });
});

describe('refs detector (shared broken-reference primitive)', () => {
  test('flags a missing path', () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hestia-refs-'));
    const f = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(f, 'Read `./missing/file.md` first.\n', 'utf-8');
    const broken = refsMod.brokenRefs(f, root);
    assert.ok(broken.includes('./missing/file.md'), JSON.stringify(broken));
  });

  test('does not flag an existing path', () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hestia-refs-'));
    fs.writeFileSync(path.join(root, 'exists.md'), 'x', 'utf-8');
    const f = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(f, 'Read `./exists.md` first.\n', 'utf-8');
    assert.deepEqual(refsMod.brokenRefs(f, root), []);
  });

  test('flags broken at import', () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hestia-refs-'));
    const f = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(f, '@./shared/conventions.md\n', 'utf-8');
    const broken = refsMod.brokenRefs(f, root);
    assert.ok(broken.some((b) => b.startsWith('@')), JSON.stringify(broken));
  });
});

// ---------------------------------------------------------------------------
// checkup probe: unparseable settings.json
// ---------------------------------------------------------------------------

describe('bad settings.json', () => {
  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    const cc = path.join(root, '.claude');
    fs.mkdirSync(cc, { recursive: true });
    fs.writeFileSync(path.join(cc, 'settings.json'), '{ not valid json', 'utf-8');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'hook').filter((f) => (f.tags || []).includes('parse'));
    assert.ok(hits.length, `bad-settings-json detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = hits[0];
    assert.equal(f.severity, 'medium');
    assert.ok(f.symptom.includes('not valid JSON'));
    assertContract(f);
  });

  test('does not fire: valid settings.json', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    const cc = path.join(root, '.claude');
    fs.mkdirSync(cc, { recursive: true });
    fs.writeFileSync(path.join(cc, 'settings.json'), '{"hooks": {}}', 'utf-8');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'hook').filter((f) => (f.tags || []).includes('parse'));
    assert.deepEqual(hits, [], `false positive: ${JSON.stringify(hits)}`);
  });
});

// ---------------------------------------------------------------------------
// checkup probe: unparseable .mcp.json
// ---------------------------------------------------------------------------

describe('bad .mcp.json', () => {
  test('fires', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ not json', 'utf-8');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'mcp').filter((f) => (f.tags || []).includes('parse'));
    assert.ok(hits.length, `bad-mcp-json detector did not fire: ${JSON.stringify(out.findings)}`);
    const f = hits[0];
    assert.equal(f.severity, 'medium');
    assert.ok(f.symptom.includes('.mcp.json is not valid JSON'));
    assertContract(f);
  });

  test('does not fire: valid .mcp.json', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Proj\n', 'utf-8');
    fs.writeFileSync(path.join(root, '.mcp.json'), '{"mcpServers": {}}', 'utf-8');
    const out = checkup(root);
    const hits = findingsForArtifact(out, 'mcp').filter((f) => (f.tags || []).includes('parse'));
    assert.deepEqual(hits, [], `false positive: ${JSON.stringify(hits)}`);
  });
});

// ---------------------------------------------------------------------------
// drift.js: broken-reference staleness scan
// ---------------------------------------------------------------------------

describe('drift staleness', () => {
  test('fires on broken ref', () => {
    const root = gitProject();
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      '# Proj\n\nFollow `./docs/setup.md`.\n',
      'utf-8'
    );
    const out = runScript('drift.js', null, ['--project-root', root]);
    assert.ok(out.stale_files.length, `drift detector did not fire: ${JSON.stringify(out)}`);
    assert.ok(out.total_broken >= 1);
    const entry = out.stale_files[0];
    assert.equal(entry.path, 'CLAUDE.md');
    assert.ok(entry.broken.includes('./docs/setup.md'));
    // A firing scan produces a non-empty change signature.
    assert.ok(out.signature);
  });

  test('clean on resolvable refs', () => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, 'setup.md'), 'steps\n', 'utf-8');
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      '# Proj\n\nFollow `./setup.md`.\n',
      'utf-8'
    );
    const out = runScript('drift.js', null, ['--project-root', root]);
    assert.deepEqual(out.stale_files, []);
    assert.equal(out.total_broken, 0);
    // Clean result is stated explicitly, never silenced.
    const details = out.limits.map((n) => n.detail || '').join(' ').toLowerCase();
    assert.ok(details.includes('no stale references found'));
  });
});

// ---------------------------------------------------------------------------
// rules engine low-quality path: a weak rule must score low + flag folklore
// ---------------------------------------------------------------------------

/**
 * Run a single rule through score_mechanical -> score_semi -> compose and
 * return the scored rule + the compose-level enforceability outputs.
 *
 * score_semi.js is the no-op-friendly middle stage in hestia's pipeline; it is
 * included so the negative test exercises the real chain, not a shortcut.
 */
function scoreChain(ruleText) {
  const payload = {
    schema_version: '0.1',
    pipeline_version: '0.1.0',
    project_context: { stack: [] },
    config: {},
    source_files: [{
      path: 'CLAUDE.md', globs: [], glob_match_count: null,
      default_category: 'mandate', line_count: 10, always_loaded: true,
    }],
    rules: [{
      id: 'R1', file_index: 0, text: ruleText,
      line_start: 3, line_end: 3, category: 'mandate',
      referenced_entities: [],
      staleness: { gated: false, missing_entities: [] },
      factors: {},
    }],
  };
  let data = JSON.stringify(payload);
  for (const script of ['score_mechanical.js', 'score_semi.js', 'compose.js']) {
    const proc = spawnSync('node', [path.join(SCRIPTS_DIR, script)], {
      input: data,
      encoding: 'utf-8',
      timeout: 60000,
      env: process.env,
    });
    assert.equal(proc.status, 0, `${script} failed: ${proc.stderr}`);
    data = proc.stdout;
  }
  return JSON.parse(data);
}

// A deliberately weak rule: vague verb ("Try to"), abstract quality words
// ("clean", "maintainable"), no concrete construct/command/threshold.
const WEAK_RULE = 'Try to keep things clean and maintainable.';
// A strong, enforceable counterpart: bare imperative + runnable command + threshold.
const STRONG_RULE = 'ALWAYS run `npm test` before committing; coverage must be >= 80%.';

describe('rules engine low-quality path', () => {
  test('weak rule scores low and is flagged', () => {
    const out = scoreChain(WEAK_RULE);
    const rule = out.rules[0];
    // The scoring DETECTOR must surface this as a low-quality rule.
    assert.ok(rule.score < 0.50, `weak rule should score low: ${rule.score}`);
    assert.ok(['D', 'F'].includes(rule.grade), rule.grade);
    assert.ok(
      rule.dominant_weakness !== null && rule.dominant_weakness !== undefined,
      'a weak rule must name a dominant weakness to drive a rewrite'
    );
    // The folklore path must also fire and emit a cited triple-shape finding.
    assert.equal(rule.enforceability.class, 'folklore', JSON.stringify(rule.enforceability));
    assert.equal(out.enforceability_counts.folklore, 1);
    assert.equal(out.folklore_findings.length, 1);
    const ff = out.folklore_findings[0];
    // Phase-1 contract on the emitted folklore finding.
    assert.equal(ff.file, 'CLAUDE.md');
    assert.equal(ff.location, 'CLAUDE.md:3');
    assert.equal(ff.advisory, false);
    assert.ok(ff.symptom && ff.why && ff.fix_action);
    assert.ok(ff.tags.includes('folklore'));
  });

  test('strong rule scores high and is not flagged', () => {
    const out = scoreChain(STRONG_RULE);
    const rule = out.rules[0];
    // The clean counterpart must NOT trip the low-quality / folklore detector.
    assert.ok(rule.score >= 0.75, `strong rule should score high: ${rule.score}`);
    assert.ok(['A', 'B'].includes(rule.grade), rule.grade);
    assert.equal(rule.enforceability.class, 'enforceable', JSON.stringify(rule.enforceability));
    assert.equal(out.enforceability_counts.folklore, 0);
    assert.deepEqual(out.folklore_findings, []);
  });

  test('weak and strong are actually distinguished', () => {
    // The detector's value is the SPREAD: a neutered scorer that returned a
    // constant would fail this. The weak rule must score materially lower.
    const weak = scoreChain(WEAK_RULE).rules[0].score;
    const strong = scoreChain(STRONG_RULE).rules[0].score;
    assert.ok(strong - weak > 0.30, `${weak}, ${strong}`);
  });
});
