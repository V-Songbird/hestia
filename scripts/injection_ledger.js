#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function projectDir() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function ledgerPath() {
  return path.join(projectDir(), ".hestia", "injection-ledger.jsonl");
}

function record(verdict, orderId, note = "") {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = { ts: Math.floor(Date.now() / 1000), order: orderId, verdict };
  if (note) entry.note = note;
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
  return p;
}

function readEntries() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  const entries = [];
  for (let line of fs.readFileSync(p, "utf-8").split("\n")) {
    line = line.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && !Array.isArray(obj) && obj.order) {
      entries.push(obj);
    }
  }
  return entries;
}

function summarize() {
  const entries = readEntries();
  const per = {};
  for (const e of entries) {
    const order = String(e.order);
    const bucket = per[order] || (per[order] = { confirm: 0, dispute: 0 });
    const verdict = e.verdict;
    if (verdict in bucket) bucket[verdict] += 1;
  }

  const orders = [];
  for (const order of Object.keys(per).sort()) {
    const confirms = per[order].confirm;
    const disputes = per[order].dispute;
    const sessions = confirms + disputes;
    orders.push({
      order,
      confirms,
      disputes,
      sessions,
      note: note(order, confirms, disputes, sessions),
    });
  }
  return { orders, total_entries: entries.length };
}

function note(order, confirms, disputes, sessions) {
  if (sessions === 0) return `order ${order}: no verdicts recorded yet`;
  if (confirms === 0) {
    return `order ${order}: 0 confirms / ${sessions} sessions — candidate to drop or rescope`;
  }
  if (disputes > confirms) {
    return `order ${order}: disputed more than confirmed (${disputes} vs ${confirms}) — candidate to rescope`;
  }
  return `order ${order}: ${confirms} confirms / ${disputes} disputes`;
}

function render(summary) {
  if (!summary.orders.length) {
    return (
      "Injection ledger: empty. No standing order has been confirmed or " +
      "disputed yet — record signal with `injection_ledger.py confirm|dispute " +
      "<order-id>`."
    );
  }
  const lines = ["Standing-order ledger (self-audit signal, not enforcement):"];
  for (const o of summary.orders) {
    lines.push(`  ${o.note}`);
  }
  lines.push(`Total verdicts recorded: ${summary.total_entries}.`);
  return lines.join("\n");
}

const DOC = `Append-only ledger for Hestia's always-on standing orders.

An always-on nudge that is frequently irrelevant trains Claude to tune out ALL
of them. This ledger turns that risk into a measurable signal: each session can
record whether a standing order *mattered* (\`confirm\`) or *fired but was
irrelevant* (\`dispute\`). The \`summary\` mode aggregates the counts so a human can
see which orders carry their weight and which are candidates to drop or rescope.

This is a self-audit signal, not enforcement. There are NO magic-number
thresholds — \`summary\` reports counts and a descriptive note; the candidacy is
descriptive, never an auto-action.

Storage: \`.hestia/injection-ledger.jsonl\` (already-gitignored namespace), one
JSON object per line, append-only.

CLI:
    injection_ledger.py confirm <order-id> [note]
    injection_ledger.py dispute <order-id> [note]
    injection_ledger.py summary

Standard library only. Python 3.10+.
`;

function main(argv) {
  if (!argv.length) {
    process.stderr.write(DOC);
    return 2;
  }
  const cmd = argv[0];
  if (cmd === "confirm" || cmd === "dispute") {
    if (argv.length < 2 || !argv[1].trim()) {
      process.stderr.write(`usage: injection_ledger.py ${cmd} <order-id> [note]\n`);
      return 2;
    }
    const orderId = argv[1].trim();
    const noteArg = argv.slice(2).join(" ").trim();
    const p = record(cmd, orderId, noteArg);
    process.stdout.write(`recorded ${cmd} for '${orderId}' -> ${p}\n`);
    return 0;
  }
  if (cmd === "summary") {
    process.stdout.write(render(summarize()) + "\n");
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write("commands: confirm <id> | dispute <id> | summary\n");
  return 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (exc) {
    process.stderr.write(`injection_ledger error: ${exc.message}\n`);
    process.exit(1);
  }
}

module.exports = { record, readEntries, summarize, render, main };
