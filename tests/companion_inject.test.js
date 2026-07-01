'use strict';

// Tests for companion-inject.js — the SessionStart injector.
//
// Covers:
//   - SessionStart (on by default) emits the full body of the housekeeping reminder.
//   - The companion is on/off only — no verbosity levels. `off` emits nothing;
//     anything else (incl. absent file) is on.
//   - The hook never crashes on missing / empty / malformed stdin.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTmpProject } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'hooks', 'companion-inject.js');

// Marker tied to the housekeeping reminder (skills/lean/doctrine.md).
const HOUSE_TERSE = '- **Keep the workspace tidy:**';
const HOUSE_FULL = '## Keep the workspace tidy';

function runHook(project, stdinData) {
  return spawnSync('node', [HOOK], {
    input: stdinData === null || stdinData === undefined ? undefined : stdinData,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

function sessionEvent(source) {
  const d = { hook_event_name: 'SessionStart' };
  if (source !== undefined) d.source = source;
  return JSON.stringify(d);
}

function turnEvent() {
  return JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'do a thing' });
}

function pretoolEvent(toolName) {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName });
}

function posttoolEvent(sessionId = 's', toolName = 'Read') {
  return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: toolName, session_id: sessionId });
}

function userpromptEvent(sessionId = 's') {
  return JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId });
}

function setMode(project, mode) {
  const d = path.join(project, '.hestia');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'lean-mode'), mode, 'utf-8');
}

function isJson(s) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SessionStart — full brief, raw stdout
// ---------------------------------------------------------------------------

describe('SessionStart', () => {
  test('emits full brief raw', () => {
    const project = makeTmpProject();
    const r = runHook(project, sessionEvent());
    assert.equal(r.status, 0);
    // Raw text, not JSON-wrapped.
    assert.equal(isJson(r.stdout), false);
    assert.match(r.stdout, /# Hestia/);
  });

  test('full brief includes housekeeping reminder', () => {
    const project = makeTmpProject();
    const r = runHook(project, sessionEvent());
    assert.match(r.stdout, /Keep the workspace tidy/);
    assert.doesNotMatch(r.stdout, /Talk to the stakeholder/);
  });

  test('default mode is on', () => {
    // No lean-mode file -> on -> full body of housekeeping reminder.
    const project = makeTmpProject();
    const r = runHook(project, sessionEvent());
    assert.match(r.stdout, new RegExp(HOUSE_FULL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(r.stdout.includes(HOUSE_TERSE), false);
  });
});

// ---------------------------------------------------------------------------
// SessionStart source — re-anchor preamble on resume/compact
// ---------------------------------------------------------------------------

describe('SessionStartSource', () => {
  test('startup uses initial preamble', () => {
    const project = makeTmpProject();
    const out = runHook(project, sessionEvent('startup')).stdout;
    assert.match(out, /keeping the workspace tidy/); // initial preamble text
    assert.equal(out.includes('just resumed or compressed'), false);
  });

  test('compact uses reanchor preamble', () => {
    const project = makeTmpProject();
    const out = runHook(project, sessionEvent('compact')).stdout;
    assert.match(out, /still here/); // re-anchor heading
    assert.match(out, /just resumed or compressed/);
  });

  test('resume uses reanchor preamble', () => {
    const project = makeTmpProject();
    const out = runHook(project, sessionEvent('resume')).stdout;
    assert.match(out, /just resumed or compressed/);
  });

  test('reanchor keeps full order body', () => {
    // Re-anchor changes the framing, never drops detail.
    const project = makeTmpProject();
    const out = runHook(project, sessionEvent('compact')).stdout;
    assert.equal(out.includes(HOUSE_FULL), true);
  });

  test('unknown source falls back to initial', () => {
    const project = makeTmpProject();
    const out = runHook(project, sessionEvent('wibble')).stdout;
    assert.match(out, /keeping the workspace tidy/);
    assert.equal(out.includes('just resumed or compressed'), false);
  });
});

// ---------------------------------------------------------------------------
// UserPromptSubmit — one rotating line, raw stdout
// ---------------------------------------------------------------------------

describe('TurnNudge', () => {
  test('emits single hestia line', () => {
    const project = makeTmpProject();
    const r = runHook(project, turnEvent());
    assert.equal(r.status, 0);
    const out = r.stdout.trim();
    assert.equal(out.startsWith('[Hestia]'), true);
    assert.equal(out.split('[Hestia]').length - 1, 1); // one line, not the old 4-in-one
    assert.equal(isJson(r.stdout), false); // raw, not JSON-wrapped
  });

  test('rotation covers multiple lines', () => {
    // Across many turns the pool yields more than one distinct line.
    const project = makeTmpProject();
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      seen.add(runHook(project, turnEvent()).stdout.trim());
    }
    assert.equal(seen.size > 1, true);
  });

  test('off emits nothing', () => {
    const project = makeTmpProject();
    setMode(project, 'off');
    const r = runHook(project, turnEvent());
    assert.equal(r.stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// PreToolUse — situational, JSON-wrapped, silent for unmatched tools
// ---------------------------------------------------------------------------

describe('PreToolUse', () => {
  test('edit emits nothing', () => {
    // Edit carries no nudge.
    const project = makeTmpProject();
    const r = runHook(project, pretoolEvent('Edit'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('bash gets tidy nudge', () => {
    const project = makeTmpProject();
    const r = runHook(project, pretoolEvent('Bash'));
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.equal(ctx.startsWith('[Hestia] Tidy:'), true);
  });

  test('websearch emits nothing', () => {
    // WebSearch no longer has a nudge after communication pillar removal.
    const project = makeTmpProject();
    const r = runHook(project, pretoolEvent('WebSearch'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('mcp sql matches regex group', () => {
    const project = makeTmpProject();
    const r = runHook(project, pretoolEvent('mcp__webstorm__execute_sql_query'));
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.equal(ctx.startsWith('[Hestia] Tidy:'), true);
  });

  test('unmatched tool emits nothing', () => {
    const project = makeTmpProject();
    const r = runHook(project, pretoolEvent('Read'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('off emits nothing', () => {
    const project = makeTmpProject();
    setMode(project, 'off');
    const r = runHook(project, pretoolEvent('Bash'));
    assert.equal(r.stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

describe('OffMode', () => {
  test('session off emits nothing', () => {
    const project = makeTmpProject();
    setMode(project, 'off');
    const r = runHook(project, sessionEvent());
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// Robustness — never crash
// ---------------------------------------------------------------------------

describe('Robustness', () => {
  test('empty stdin defaults to session', () => {
    const project = makeTmpProject();
    const r = runHook(project, '');
    assert.equal(r.status, 0);
    // Empty stdin -> treated as SessionStart -> raw full brief.
    assert.match(r.stdout, /# Hestia/);
  });

  test('malformed stdin does not crash', () => {
    const project = makeTmpProject();
    const r = runHook(project, 'not json at all {{{');
    assert.equal(r.status, 0);
  });

  test('no stdin does not crash', () => {
    const project = makeTmpProject();
    const r = runHook(project, null);
    assert.equal(r.status, 0);
  });

  test('non-off mode is on', () => {
    // Anything that isn't `off` — garbage or a legacy level word — means on.
    const project = makeTmpProject();
    for (const mode of ['wibble', 'lean', 'trim', 'bare']) {
      setMode(project, mode);
      const r = runHook(project, sessionEvent());
      assert.equal(r.status, 0);
      assert.equal(r.stdout.includes(HOUSE_FULL), true); // full brief, not off
    }
  });
});

// ---------------------------------------------------------------------------
// PostToolUse — boundary re-injection (count tool calls, re-anchor near handoff)
// ---------------------------------------------------------------------------

describe('Boundary', () => {
  function firedAt(project, n, session = 's') {
    // Run n PostToolUse calls; return the 1-based indices that emitted.
    const out = [];
    for (let i = 1; i <= n; i++) {
      if (runHook(project, posttoolEvent(session)).stdout.trim()) out.push(i);
    }
    return out;
  }

  test('silent under threshold', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent()); // reset the run
    assert.deepEqual(firedAt(project, 9), []);
  });

  test('fires at threshold', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent());
    assert.deepEqual(firedAt(project, 10), [10]);
  });

  test('refires every threshold', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent());
    assert.deepEqual(firedAt(project, 20), [10, 20]);
  });

  test('payload is boundary nudge', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent());
    let out = '';
    for (let i = 0; i < 10; i++) {
      out = runHook(project, posttoolEvent()).stdout;
    }
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.equal(ctx.startsWith('[Hestia] Long run'), true);
    assert.match(ctx, /hestia:later/);
  });

  test('user prompt resets counter', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent());
    firedAt(project, 10); // fires at 10
    runHook(project, userpromptEvent()); // new prompt -> reset
    assert.deepEqual(firedAt(project, 9), []); // silent again
  });

  test('session change resets', () => {
    const project = makeTmpProject();
    runHook(project, userpromptEvent('a'));
    for (let i = 0; i < 9; i++) {
      runHook(project, posttoolEvent('a')); // count 9 on session a
    }
    // switching session resets to count 1 -> silent (no fire at the 10th-overall call)
    assert.equal(runHook(project, posttoolEvent('b')).stdout.trim(), '');
  });

  test('off silences post tool', () => {
    const project = makeTmpProject();
    setMode(project, 'off');
    runHook(project, userpromptEvent());
    for (let i = 0; i < 12; i++) {
      assert.equal(runHook(project, posttoolEvent()).stdout.trim(), '');
    }
  });
});
