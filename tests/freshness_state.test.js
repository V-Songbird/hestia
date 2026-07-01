'use strict';

// Tests for freshness_state.js — feature #3, "staleness-as-honesty".
//
// Two linked behaviors:
//
//   1. Derive-staleness: a fresh/aging/stale label is DERIVED from cheap signals
//      (commits since last checkup, days since last checkup) via one formula using
//      the labeled DEFAULTS. No grade is ever stored.
//
//   2. Negative invariants: when a surface scans clean it is recorded with the
//      input-signature that made it clean; an unchanged signature lets a later run
//      SKIP the surface, a changed signature forces a re-scan.
//
// Also exercises graceful degradation: not a git repo, and no prior state.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { makeTmpProject } = require('./helpers');
const fsState = require('../scripts/freshness_state');

const D = fsState.DEFAULTS;

function gitAvailable() {
  try {
    const r = spawnSync('git', ['--version']);
    return !r.error;
  } catch {
    return false;
  }
}

function initRepo(root) {
  const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf-8' });
  run('init');
  run('config', 'user.email', 't@t.t');
  run('config', 'user.name', 't');
  run('commit', '--allow-empty', '-m', 'first');
}

describe('deriveStaleness — the one formula, exercised at representative signal values', () => {
  it('fresh when both signals within bounds', () => {
    let out = fsState.deriveStaleness(0, 0.0);
    assert.equal(out.label, 'fresh');
    out = fsState.deriveStaleness(D.fresh_max_commits, D.fresh_max_days);
    assert.equal(out.label, 'fresh');
  });

  it('aging between fresh and stale', () => {
    const commits = D.fresh_max_commits + 1; // just past fresh
    const days = D.fresh_max_days + 1;
    const out = fsState.deriveStaleness(commits, days);
    assert.equal(out.label, 'aging');
  });

  it('stale when commits over floor', () => {
    const out = fsState.deriveStaleness(D.stale_min_commits, 0.0);
    assert.equal(out.label, 'stale');
    assert.ok(out.reason.includes(String(D.stale_min_commits)));
  });

  it('stale when days over floor', () => {
    const out = fsState.deriveStaleness(0, Number(D.stale_min_days));
    assert.equal(out.label, 'stale');
  });

  it('stale floor overrides otherwise fresh signal', () => {
    // commits says fresh, days says stale -> stale wins.
    const out = fsState.deriveStaleness(0, Number(D.stale_min_days + 10));
    assert.equal(out.label, 'stale');
  });

  it('fresh requires every known signal fresh', () => {
    // commits fresh, days aging -> not fresh.
    const out = fsState.deriveStaleness(0, Number(D.fresh_max_days + 5));
    assert.equal(out.label, 'aging');
  });

  it('unknown when both signals missing', () => {
    const out = fsState.deriveStaleness(null, null);
    assert.equal(out.label, 'unknown');
    assert.equal(out.commits, null);
    assert.equal(out.days, null);
  });

  it('one signal known still classifies', () => {
    // Only commits known, within fresh bound -> fresh.
    assert.equal(fsState.deriveStaleness(1, null).label, 'fresh');
    // Only days known, over stale floor -> stale.
    assert.equal(fsState.deriveStaleness(null, Number(D.stale_min_days)).label, 'stale');
  });

  it('custom defaults override', () => {
    const tight = { ...D, fresh_max_commits: 1, stale_min_commits: 2 };
    assert.equal(fsState.deriveStaleness(2, null, { defaults: tight }).label, 'stale');
    assert.equal(fsState.deriveStaleness(1, null, { defaults: tight }).label, 'fresh');
  });

  it('reason is present and human', () => {
    for (const out of [
      fsState.deriveStaleness(0, 0.0),
      fsState.deriveStaleness(D.stale_min_commits, 0.0),
      fsState.deriveStaleness(null, null),
    ]) {
      assert.ok(out.reason && typeof out.reason === 'string');
    }
  });
});

describe('signals — days_since / commits_since degrade to null, not 0', () => {
  it('daysSince none and bad input', () => {
    assert.equal(fsState.daysSince(null), null);
    assert.equal(fsState.daysSince('not-a-date'), null);
  });

  it('daysSince recent is small', () => {
    const ts = new Date().toISOString();
    assert.ok(fsState.daysSince(ts) < 1.0);
  });

  it('commitsSince no sha is null', () => {
    const tmpProject = makeTmpProject();
    assert.equal(fsState.commitsSince(null, tmpProject), null);
  });

  it('commitsSince not a git repo is null', () => {
    const tmpProject = makeTmpProject();
    // tmpProject has no .git -> unavailable signal, not zero.
    assert.equal(fsState.commitsSince('deadbeef', tmpProject), null);
  });
});

describe('cleared surfaces — negative invariants', () => {
  it('unrecorded surface is not cleared', () => {
    const tmpProject = makeTmpProject();
    assert.equal(fsState.isCleared(tmpProject, 'broken-refs', 'abc123'), false);
  });

  it('record then skip on unchanged signature', () => {
    const tmpProject = makeTmpProject();
    const f = path.join(tmpProject, 'CLAUDE.md');
    require('fs').writeFileSync(f, 'hello', 'utf-8');
    const sig = fsState.surfaceSignature([f]);
    fsState.recordCleared(tmpProject, 'broken-refs', sig);
    // Same signature -> cleared -> skip.
    assert.equal(fsState.isCleared(tmpProject, 'broken-refs', sig), true);
  });

  it('recheck on changed signature', () => {
    const tmpProject = makeTmpProject();
    const f = path.join(tmpProject, 'CLAUDE.md');
    require('fs').writeFileSync(f, 'hello', 'utf-8');
    const sig1 = fsState.surfaceSignature([f]);
    fsState.recordCleared(tmpProject, 'broken-refs', sig1);
    // Mutate the file so size/mtime change -> new signature -> not cleared.
    require('fs').writeFileSync(f, 'hello world, now longer', 'utf-8');
    const sig2 = fsState.surfaceSignature([f]);
    assert.notEqual(sig2, sig1);
    assert.equal(fsState.isCleared(tmpProject, 'broken-refs', sig2), false);
  });

  it('signature changes when file deleted', () => {
    const tmpProject = makeTmpProject();
    const f = path.join(tmpProject, 'CLAUDE.md');
    require('fs').writeFileSync(f, 'hi', 'utf-8');
    const sig1 = fsState.surfaceSignature([f]);
    require('fs').unlinkSync(f);
    const sig2 = fsState.surfaceSignature([f]);
    assert.notEqual(sig2, sig1);
  });

  it('signature order independent', () => {
    const tmpProject = makeTmpProject();
    const a = path.join(tmpProject, 'a.md');
    const b = path.join(tmpProject, 'b.md');
    require('fs').writeFileSync(a, 'a', 'utf-8');
    require('fs').writeFileSync(b, 'b', 'utf-8');
    assert.equal(fsState.surfaceSignature([a, b]), fsState.surfaceSignature([b, a]));
  });

  it('clear surface removes record', () => {
    const tmpProject = makeTmpProject();
    const f = path.join(tmpProject, 'CLAUDE.md');
    require('fs').writeFileSync(f, 'hi', 'utf-8');
    const sig = fsState.surfaceSignature([f]);
    fsState.recordCleared(tmpProject, 'broken-refs', sig);
    fsState.clearSurface(tmpProject, 'broken-refs');
    assert.equal(fsState.isCleared(tmpProject, 'broken-refs', sig), false);
  });

  it('cleared record carries ts and sha', () => {
    const tmpProject = makeTmpProject();
    const f = path.join(tmpProject, 'CLAUDE.md');
    require('fs').writeFileSync(f, 'hi', 'utf-8');
    const sig = fsState.surfaceSignature([f]);
    fsState.recordCleared(tmpProject, 'broken-refs', sig);
    const rec = fsState.clearedRecord(tmpProject, 'broken-refs');
    assert.equal(rec.signature, sig);
    assert.ok('ts' in rec); // sha may be null when not a git repo
  });
});

describe('checkup state — cheap signal only, graceful degrade', () => {
  it('no prior state is unknown', () => {
    const tmpProject = makeTmpProject();
    assert.deepEqual(fsState.loadCheckupState(tmpProject), {});
    const out = fsState.stalenessFor(tmpProject);
    assert.equal(out.label, 'unknown');
    assert.equal(out.last_sha, null);
  });

  it('record checkup persists only cheap signal', () => {
    const tmpProject = makeTmpProject();
    const rec = fsState.recordCheckup(tmpProject);
    assert.deepEqual(new Set(Object.keys(rec)), new Set(['sha', 'ts'])); // NO "grade", NO "label", NO "score"
    // Round-trips from disk.
    const loaded = fsState.loadCheckupState(tmpProject);
    assert.equal(loaded.ts, rec.ts);
  });

  it('state written under dot-hestia', () => {
    const tmpProject = makeTmpProject();
    fsState.recordCheckup(tmpProject);
    assert.ok(
      require('fs').statSync(path.join(tmpProject, '.hestia', 'checkup-state.json')).isFile()
    );
  });

  it('corrupt state degrades to empty', () => {
    const tmpProject = makeTmpProject();
    const p = path.join(tmpProject, '.hestia', 'checkup-state.json');
    require('fs').mkdirSync(path.dirname(p), { recursive: true });
    require('fs').writeFileSync(p, '{not json', 'utf-8');
    assert.deepEqual(fsState.loadCheckupState(tmpProject), {});
  });

  it('no grade ever stored on disk', () => {
    const tmpProject = makeTmpProject();
    fsState.recordCheckup(tmpProject);
    const raw = require('fs').readFileSync(
      path.join(tmpProject, '.hestia', 'checkup-state.json'),
      'utf-8'
    );
    for (const forbidden of ['grade', 'label', 'score', 'health', '/10']) {
      assert.ok(!raw.includes(forbidden));
    }
  });
});

// ---------------------------------------------------------------------------
// git-backed path — only when git is available
// ---------------------------------------------------------------------------

describe('git-backed signals', { skip: gitAvailable() ? false : 'git not on PATH' }, () => {
  it('commitsSince counts new commits', () => {
    const tmpProject = makeTmpProject();
    initRepo(tmpProject);
    const sha = fsState.currentHead(tmpProject);
    assert.ok(sha);
    assert.equal(fsState.commitsSince(sha, tmpProject), 0);
    const run = (...a) => spawnSync('git', a, { cwd: tmpProject, encoding: 'utf-8' });
    run('commit', '--allow-empty', '-m', 'second');
    run('commit', '--allow-empty', '-m', 'third');
    assert.equal(fsState.commitsSince(sha, tmpProject), 2);
  });

  it('staleness fresh after recent checkup', () => {
    const tmpProject = makeTmpProject();
    initRepo(tmpProject);
    fsState.recordCheckup(tmpProject); // 0 commits, ~0 days -> fresh
    const out = fsState.stalenessFor(tmpProject);
    assert.equal(out.label, 'fresh');
    assert.equal(out.last_sha, fsState.currentHead(tmpProject));
  });

  it('staleness aging after many commits', () => {
    const tmpProject = makeTmpProject();
    initRepo(tmpProject);
    fsState.recordCheckup(tmpProject);
    const run = (...a) => spawnSync('git', a, { cwd: tmpProject, encoding: 'utf-8' });
    for (let i = 0; i < D.fresh_max_commits + 2; i++) {
      run('commit', '--allow-empty', '-m', `c${i}`);
    }
    const out = fsState.stalenessFor(tmpProject);
    assert.ok(out.label === 'aging' || out.label === 'stale');
  });

  it('unreachable sha degrades to null', () => {
    const tmpProject = makeTmpProject();
    initRepo(tmpProject);
    // A SHA that isn't in this repo -> rev-list fails -> null (graceful).
    assert.equal(fsState.commitsSince('0'.repeat(40), tmpProject), null);
  });
});
