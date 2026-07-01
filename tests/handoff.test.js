'use strict';

// Tests for handoff.js — the detect-and-route orchestration stager.
//
// Covers the four modes (routes / stage / list / clear), routed vs unrouted
// handling, the deterministic id (re-staging the same finding overwrites rather
// than duplicates), the owner-grouped listing, and the team-local hookify caveat.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runScript, makeTmpProject } = require('./helpers');

function run(mode, project, stdin) {
  const args = [mode];
  if (project !== undefined && project !== null) {
    args.push('--project-root', String(project));
  }
  return runScript('handoff.js', stdin, args);
}

describe('routes', () => {
  test('routes present and unique', () => {
    const classes = run('routes').routes.map((r) => r.drift_class);
    assert.ok(classes.includes('claude_md_content_drift'));
    assert.ok(classes.includes('rule_should_be_hook'));
    assert.equal(classes.length, new Set(classes).size); // no duplicate drift classes
  });

  test('every route has owner, target, action', () => {
    for (const r of run('routes').routes) {
      assert.ok(r.owner_plugin && r.target && r.action, JSON.stringify(r));
    }
  });
});

describe('stage', () => {
  test('routed handoff written', () => {
    const project = makeTmpProject();
    const out = run('stage', project, {
      drift_class: 'claude_md_content_drift',
      locator: 'CLAUDE.md:12',
      items: ['scripts/old.py gone'],
      correct_values: ['scripts/drift.py'],
    });
    assert.equal(out.status, 'staged');
    const rec = out.record;
    assert.equal(rec.routed, true);
    assert.equal(rec.owner_plugin, 'claude-md-management');
    assert.equal(rec.target, 'claude-md-improver skill');
    assert.ok(fs.statSync(path.join(project, out.path)).isFile());
  });

  test('unrouted class is graceful', () => {
    const project = makeTmpProject();
    const rec = run('stage', project, { drift_class: 'made_up', locator: 'x' }).record;
    assert.equal(rec.routed, false);
    assert.equal(rec.owner_plugin, null);
    assert.ok(rec.action.toLowerCase().includes('surface'));
  });

  test('deterministic id overwrites not duplicates', () => {
    const project = makeTmpProject();
    const p = { drift_class: 'skill_internal_ref_broken', locator: 'a/SKILL.md', items: ['r'] };
    const first = run('stage', project, p).record.id;
    const second = run('stage', project, p).record.id;
    assert.equal(first, second);
    assert.equal(run('list', project).count, 1); // identical finding did not duplicate
  });

  test('hook route surfaces team-local caveat', () => {
    const project = makeTmpProject();
    const rec = run('stage', project, {
      drift_class: 'rule_should_be_hook',
      locator: 'rules/api.md',
      items: ['x'],
    }).record;
    assert.ok(rec.caveat); // gitignored *.local.md -> not team-shared
  });
});

describe('list and clear', () => {
  test('list groups by owner', () => {
    const project = makeTmpProject();
    run('stage', project, { drift_class: 'claude_md_content_drift', locator: 'a', items: ['1'] });
    run('stage', project, { drift_class: 'absence_gap', locator: 'b', items: ['2'] });
    const d = run('list', project);
    assert.equal(d.count, 2);
    assert.equal(d.by_owner['claude-md-management'], 1);
    assert.equal(d.by_owner['claude-code-setup'], 1);
  });

  test('clear by id', () => {
    const project = makeTmpProject();
    const rec = run('stage', project, { drift_class: 'absence_gap', locator: 'b', items: ['2'] }).record;
    assert.equal(run('clear', project, { id: rec.id }).removed, 1);
    assert.equal(run('list', project).count, 0);
  });

  test('clear all', () => {
    const project = makeTmpProject();
    run('stage', project, { drift_class: 'absence_gap', locator: 'b', items: ['2'] });
    run('stage', project, { drift_class: 'claude_md_content_drift', locator: 'a', items: ['1'] });
    assert.equal(run('clear', project, { all: true }).removed, 2);
    assert.equal(run('list', project).count, 0);
  });

  test('list empty project', () => {
    const project = makeTmpProject();
    const d = run('list', project);
    assert.equal(d.count, 0);
    assert.deepEqual(d.handoffs, []);
  });
});
