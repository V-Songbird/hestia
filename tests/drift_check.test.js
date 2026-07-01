'use strict';

// Tests for drift.js --check — the CI drift gate (exit non-zero on stale refs).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runScriptRaw, makeTmpProject } = require('./helpers');

function run(project, ...flags) {
  return runScriptRaw('drift.js', null, ['--project-root', project, ...flags]);
}

test('clean exits zero', () => {
  const project = makeTmpProject();
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'No file references here.\n', 'utf-8');
  assert.equal(run(project, '--check').status, 0);
});

test('dead ref exits nonzero', () => {
  const project = makeTmpProject();
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'Run the scan in `scripts/gone.py`.\n', 'utf-8');
  assert.equal(run(project, '--check').status, 1);
});

test('check is opt-in: without --check, a plain scan exits 0 even when drift exists', () => {
  const project = makeTmpProject();
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'Run the scan in `scripts/gone.py`.\n', 'utf-8');
  assert.equal(run(project).status, 0);
});
