'use strict';

// Tests for injection_ledger.js — the standing-order self-audit ledger.
//
// Covers:
//   - confirm / dispute append a well-formed line to .hestia/injection-ledger.jsonl
//   - the ledger file + .hestia/ dir are created on first write
//   - summary aggregates per-order confirm/dispute counts with a descriptive note
//   - graceful first-run: summary on a fresh project says "empty", never crashes
//   - bad lines in the ledger are skipped, not fatal
//   - the CLI never hard-crashes on missing/empty args

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeTmpProject, runScriptRaw } = require('./helpers');
const ledger = require('../scripts/injection_ledger');

let project;

beforeEach(() => {
  project = makeTmpProject();
  process.env.CLAUDE_PROJECT_DIR = project;
});

// ---------------------------------------------------------------------------
// File creation + append
// ---------------------------------------------------------------------------

describe('record', () => {
  test('confirm creates ledger in .hestia', () => {
    const p = ledger.record('confirm', 'scope');
    assert.equal(p, path.join(project, '.hestia', 'injection-ledger.jsonl'));
    assert.ok(fs.existsSync(p));
  });

  test('record appends one jsonl line', () => {
    ledger.record('confirm', 'scope');
    ledger.record('dispute', 'phases');
    const lines = fs
      .readFileSync(path.join(project, '.hestia', 'injection-ledger.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.order, 'scope');
    assert.equal(first.verdict, 'confirm');
    assert.equal(Number.isInteger(first.ts), true);
  });

  test('record stores optional note', () => {
    ledger.record('confirm', 'scope', 'caught real scope creep');
    const entry = ledger.readEntries()[0];
    assert.equal(entry.note, 'caught real scope creep');
  });

  test('record omits empty note', () => {
    ledger.record('confirm', 'scope');
    assert.ok(!('note' in ledger.readEntries()[0]));
  });
});

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

describe('summary', () => {
  test('empty first run', () => {
    // A fresh project with no ledger yields an empty, non-crashing summary.
    const s = ledger.summarize();
    assert.deepEqual(s.orders, []);
    assert.equal(s.total_entries, 0);
    assert.ok(ledger.render(s).toLowerCase().includes('empty'));
  });

  test('aggregates confirm and dispute counts', () => {
    for (let i = 0; i < 3; i++) ledger.record('confirm', 'scope');
    ledger.record('dispute', 'scope');
    ledger.record('dispute', 'phases');
    const s = ledger.summarize();
    const byOrder = Object.fromEntries(s.orders.map((o) => [o.order, o]));
    assert.equal(byOrder.scope.confirms, 3);
    assert.equal(byOrder.scope.disputes, 1);
    assert.equal(byOrder.scope.sessions, 4);
    assert.equal(byOrder.phases.confirms, 0);
    assert.equal(byOrder.phases.disputes, 1);
    assert.equal(s.total_entries, 5);
  });

  test('zero-confirm order flagged as candidate', () => {
    // An order with disputes but no confirms gets the drop/rescope note.
    ledger.record('dispute', 'memory');
    ledger.record('dispute', 'memory');
    const note = ledger.summarize().orders[0].note;
    assert.ok(note.includes('0 confirms'));
    assert.ok(note.includes('candidate to drop or rescope'));
  });

  test('note is descriptive, not auto-action', () => {
    // No threshold/auto-action: even a heavily-disputed order is only a
    // 'candidate', never auto-dropped (the candidacy is descriptive).
    ledger.record('confirm', 'scope');
    ledger.record('dispute', 'scope');
    ledger.record('dispute', 'scope');
    const note = ledger.summarize().orders.find((o) => o.order === 'scope').note;
    assert.ok(note.includes('candidate to rescope'));
  });

  test('render lists every order', () => {
    ledger.record('confirm', 'scope');
    ledger.record('confirm', 'lean');
    const out = ledger.render(ledger.summarize());
    assert.ok(out.includes('scope'));
    assert.ok(out.includes('lean'));
  });

  test('bad lines are skipped', () => {
    const dir = path.join(project, '.hestia');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'injection-ledger.jsonl'),
      'not json\n{"order": "scope", "verdict": "confirm", "ts": 1}\n\n' +
        '{"no_order": true}\n',
      'utf-8'
    );
    const entries = ledger.readEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].order, 'scope');
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

function runCli(proj, ...args) {
  return runScriptRaw('injection_ledger.js', undefined, args);
}

describe('CLI', () => {
  test('confirm via CLI', () => {
    const r = runCli(project, 'confirm', 'scope');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('recorded confirm'));
    assert.ok(fs.existsSync(path.join(project, '.hestia', 'injection-ledger.jsonl')));
  });

  test('summary via CLI empty', () => {
    const r = runCli(project, 'summary');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.toLowerCase().includes('empty'));
  });

  test('summary via CLI after records', () => {
    runCli(project, 'confirm', 'scope');
    runCli(project, 'dispute', 'scope');
    const r = runCli(project, 'summary');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('scope'));
  });

  test('no args is nonzero, not a crash', () => {
    const r = runCli(project);
    assert.equal(r.status, 2);
  });

  test('confirm without order id is nonzero', () => {
    const r = runCli(project, 'confirm');
    assert.equal(r.status, 2);
  });

  test('unknown command is nonzero', () => {
    const r = runCli(project, 'frobnicate');
    assert.equal(r.status, 2);
  });
});
