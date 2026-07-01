'use strict';

// Tests for vanished-path-alarm.js — the PostToolUse vanished-path citation alarm.
//
// Covers:
//   - A destructive command (rm / mv / git mv|rm / Remove-Item) that deletes a path
//     an instruction file still cites fires an advisory in the same turn.
//   - A vanished DIRECTORY prefix-matches a nested bare reference inside it — the
//     case the existence-dependent refs.resolve() would mis-resolve and miss.
//   - A move flags the vanished SOURCE only, never the surviving destination.
//   - Silence when: the path still exists, nothing cites it, the tool isn't
//     Bash/PowerShell, the path is outside the project tree, or the arg is a glob.
//   - The signature throttle suppresses an identical back-to-back alarm but lets a
//     different one through.
//   - The hookSpecificOutput JSON contract, and never-crash robustness.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'vanished-path-alarm.js');

function runHook(project, toolName, command) {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    cwd: project,
    tool_input: { command },
    tool_response: { stdout: '', stderr: '', exit_code: 0 },
  };
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

// The injected advisory text, or '' when the hook stayed silent.
function contextOf(result) {
  const out = result.stdout.trim();
  if (!out) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

// A temp project root. The empty .git makes findProjectRoot() stop here,
// deterministically, regardless of any ambient repo above the temp dir.
function makeProject() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hestia-vanished-'));
  const p = path.join(tmpDir, 'project');
  fs.mkdirSync(p);
  fs.mkdirSync(path.join(p, '.git'));
  return p;
}

function write(project, relpath, text) {
  const f = path.join(project, relpath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, 'utf-8');
}

// ---------------------------------------------------------------------------
// Fires — the path vanished and something still cites it
// ---------------------------------------------------------------------------

describe('Fires', () => {
  test('file delete names the citation', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'Run the scan in `scripts/old.py` first.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    const ctx = contextOf(runHook(project, 'Bash', 'rm scripts/old.py'));
    assert.match(ctx, /CLAUDE\.md/);
    assert.match(ctx, /scripts\/old\.py/);
  });

  test('dir rename prefix-matches nested bare ref', () => {
    // git mv of a directory must flag a bare ref inside it cited from a
    // NESTED rule file — the resolve() existence-fallback gotcha.
    const project = makeProject();
    write(project, '.claude/rules/api.md', 'Always run `scripts/drift.py` before a commit.\n');
    write(project, 'scripts/drift.py', 'x\n');
    fs.renameSync(path.join(project, 'scripts'), path.join(project, 'tools')); // git mv scripts tools
    const ctx = contextOf(runHook(project, 'Bash', 'git mv scripts tools'));
    assert.match(ctx, /\.claude\/rules\/api\.md/);
    assert.match(ctx, /scripts\/drift\.py/);
  });

  test('git rm fires', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `docs/spec.md`.\n');
    write(project, 'docs/spec.md', 'x\n');
    fs.unlinkSync(path.join(project, 'docs', 'spec.md'));
    const ctx = contextOf(runHook(project, 'Bash', 'git rm docs/spec.md'));
    assert.match(ctx, /docs\/spec\.md/);
  });

  test('powershell Remove-Item fires', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'The agent reads `references/legacy.md`.\n');
    write(project, 'references/legacy.md', 'x\n');
    fs.unlinkSync(path.join(project, 'references', 'legacy.md'));
    const ctx = contextOf(runHook(project, 'PowerShell', 'Remove-Item -Force .\\references\\legacy.md'));
    assert.match(ctx, /references\/legacy\.md/);
  });

  test('compound command destructive part parsed', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'Style: `docs/style.md`.\n');
    write(project, 'docs/style.md', 'x\n');
    fs.unlinkSync(path.join(project, 'docs', 'style.md'));
    const ctx = contextOf(runHook(project, 'Bash', 'echo cleaning && rm docs/style.md'));
    assert.match(ctx, /docs\/style\.md/);
  });

  test('reports line number', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', '# Title\n\nfiller\n\nSee `scripts/old.py` here.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    const ctx = contextOf(runHook(project, 'Bash', 'rm scripts/old.py'));
    assert.match(ctx, /CLAUDE\.md:5/); // the ref is on line 5
  });
});

// ---------------------------------------------------------------------------
// Command shapes — prefixes, flags, and the deliberate git base-change bail
// ---------------------------------------------------------------------------

describe('CommandShapes', () => {
  function goneCited(project) {
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
  }

  test('sudo prefix', () => {
    const project = makeProject();
    goneCited(project);
    assert.notEqual(contextOf(runHook(project, 'Bash', 'sudo rm scripts/old.py')), '');
  });

  test('env var prefix', () => {
    const project = makeProject();
    goneCited(project);
    assert.notEqual(contextOf(runHook(project, 'Bash', 'FOO=bar rm scripts/old.py')), '');
  });

  test('env wrapper prefix', () => {
    const project = makeProject();
    goneCited(project);
    assert.notEqual(contextOf(runHook(project, 'Bash', 'env FOO=bar rm scripts/old.py')), '');
  });

  test('flags after git verb', () => {
    const project = makeProject();
    goneCited(project);
    assert.notEqual(contextOf(runHook(project, 'Bash', 'git rm -f scripts/old.py')), '');
  });

  test('git -C bails safely', () => {
    // git -C relocates the base a path resolves against; we deliberately bail
    // rather than resolve against the wrong cwd (prefer a miss to a false alarm).
    const project = makeProject();
    goneCited(project);
    assert.equal(contextOf(runHook(project, 'Bash', 'git -C scripts rm old.py')), '');
  });
});

// ---------------------------------------------------------------------------
// Silent — no false alarms
// ---------------------------------------------------------------------------

describe('Silent', () => {
  test('path still exists', () => {
    // Command claimed a delete but the path is still on disk (no-op / copy).
    const project = makeProject();
    write(project, 'CLAUDE.md', 'Keeper `scripts/keep.py`.\n');
    write(project, 'scripts/keep.py', 'x\n'); // NOT removed
    assert.equal(contextOf(runHook(project, 'Bash', 'rm scripts/keep.py')), '');
  });

  test('uncited deletion', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'Nothing references the build dir.\n');
    write(project, 'build/artifact.bin', 'x\n');
    fs.unlinkSync(path.join(project, 'build', 'artifact.bin'));
    assert.equal(contextOf(runHook(project, 'Bash', 'rm build/artifact.bin')), '');
  });

  test('non-watched tool', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    assert.equal(contextOf(runHook(project, 'Read', 'rm scripts/old.py')), '');
  });

  test('non-destructive command', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    // cat of a missing file references it but removes nothing -> not destructive.
    assert.equal(contextOf(runHook(project, 'Bash', 'cat scripts/old.py')), '');
  });

  test('move does not flag destination', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `docs/old.md` and `docs/new.md`.\n');
    write(project, 'docs/old.md', 'x\n');
    fs.renameSync(path.join(project, 'docs', 'old.md'), path.join(project, 'docs', 'new.md'));
    const ctx = contextOf(runHook(project, 'Bash', 'mv docs/old.md docs/new.md'));
    assert.match(ctx, /docs\/old\.md/); // vanished source flagged
    assert.doesNotMatch(ctx, /docs\/new\.md/); // surviving destination not flagged
  });

  test('glob argument skipped', () => {
    // A globbed delete can't be resolved to concrete paths -> conservative skip.
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    assert.equal(contextOf(runHook(project, 'Bash', 'rm scripts/*.py')), '');
  });

  test('deletion outside project tree', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'Local only.\n');
    // An absolute path outside the project: nothing in-tree cites it.
    assert.equal(contextOf(runHook(project, 'Bash', 'rm /tmp/nonexistent-xyz.txt')), '');
  });
});

// ---------------------------------------------------------------------------
// Throttle — identical alarm suppressed, different alarm allowed
// ---------------------------------------------------------------------------

describe('Throttle', () => {
  test('identical alarm suppressed second time', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    const first = contextOf(runHook(project, 'Bash', 'rm scripts/old.py'));
    const second = contextOf(runHook(project, 'Bash', 'rm scripts/old.py'));
    assert.notEqual(first, '');
    assert.equal(second, '');
  });

  test('different alarm still fires', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `a/one.py` and `b/two.py`.\n');
    write(project, 'a/one.py', 'x\n');
    write(project, 'b/two.py', 'x\n');
    fs.unlinkSync(path.join(project, 'a', 'one.py'));
    assert.notEqual(contextOf(runHook(project, 'Bash', 'rm a/one.py')), '');
    fs.unlinkSync(path.join(project, 'b', 'two.py'));
    assert.notEqual(contextOf(runHook(project, 'Bash', 'rm b/two.py')), '');
  });
});

// ---------------------------------------------------------------------------
// JSON contract + robustness — never crash
// ---------------------------------------------------------------------------

describe('ContractAndRobustness', () => {
  test('JSON contract', () => {
    const project = makeProject();
    write(project, 'CLAUDE.md', 'See `scripts/old.py`.\n');
    write(project, 'scripts/old.py', 'x\n');
    fs.unlinkSync(path.join(project, 'scripts', 'old.py'));
    const r = runHook(project, 'Bash', 'rm scripts/old.py');
    const payload = JSON.parse(r.stdout);
    const hso = payload.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PostToolUse');
    assert.equal(typeof hso.additionalContext, 'string');
    assert.ok(hso.additionalContext);
  });

  test('empty stdin does not crash', () => {
    const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf-8', timeout: 30000, env: process.env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('malformed stdin does not crash', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json {{{', encoding: 'utf-8', timeout: 30000, env: process.env });
    assert.equal(r.status, 0);
  });

  test('missing command does not crash', () => {
    const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    const r = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8', timeout: 30000, env: process.env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});
