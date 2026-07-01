#!/usr/bin/env node
"use strict";

// Detect + prepare handoff — Hestia's orchestration core.
//
// Hestia detects config drift but does not repair it; the repair belongs to the
// plugin that owns the artifact. Claude Code exposes NO programmatic cross-plugin
// invocation API (verified against the plugins reference), so a handoff is three
// deterministic steps, none of which invoke another plugin directly:
//
//   1. look up the owning tool for a drift class in the routing table
//      (scripts/_data/handoff_routes.json),
//   2. STAGE a payload under .hestia/handoffs/ — the locator, the stale items, and
//      (where known) the correct values the owner needs to act, and
//   3. let the caller surface the route's one-line `action` so the user, or
//      Claude's description-matching delegation, triggers the target.
//
// Modes (JSON in on stdin where noted, JSON out on stdout):
//   routes            Emit the routing table.
//   stage   (stdin)   Record a decided handoff. Payload: {drift_class, locator,
//                     items[], correct_values?}. Returns the written record + path.
//   list              Summarize pending staged handoffs under .hestia/handoffs/.
//   clear   (stdin)   Remove a staged handoff by id ({id}) — or all if {"all": true}.
//
// State lives under .hestia/ (gitignored, local — never committed). Read-only with
// respect to the user's project. Node 18+, no dependencies.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseArgs } = require("util");

const { emit, findProjectRoot, loadData, readStdinJson, rel } = require("./_lib");

const HANDOFF_DIR = ".hestia/handoffs";

function routes() {
  try {
    return loadData("handoff_routes");
  } catch {
    return { routes: [] };
  }
}

function _routeFor(driftClass) {
  for (const r of routes().routes || []) {
    if (r.drift_class === driftClass) return r;
  }
  return null;
}

function _handoffId(driftClass, locator, items) {
  const basis = `${driftClass}|${locator}|${JSON.stringify(items)}`;
  return crypto.createHash("sha1").update(basis, "utf-8").digest("hex").slice(0, 8);
}

function stage(payload, root) {
  const driftClass = String(payload.drift_class || "");
  const locator = String(payload.locator || "");
  const items = payload.items || [];
  const route = _routeFor(driftClass);
  const hid = _handoffId(driftClass, locator, items);

  const record = {
    id: hid,
    drift_class: driftClass,
    locator,
    items,
    correct_values: payload.correct_values !== undefined ? payload.correct_values : null,
    owner_plugin: route ? route.owner_plugin : null,
    target: route ? route.target : null,
    install_hint: route ? route.install_hint : null,
    action: route
      ? route.action
      : "No registered owner for this drift class — surface the finding to the user directly.",
    caveat: route ? route.caveat || null : null,
    routed: route !== null,
    staged_at: new Date().toISOString(),
  };
  const out = path.join(String(root), HANDOFF_DIR, `${driftClass || "unrouted"}-${hid}.json`);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2), "utf-8");
  } catch (e) {
    return { status: "failed", reason: String(e.message || e) };
  }
  return { status: "staged", path: rel(out, root), record };
}

function listPending(root) {
  const d = path.join(String(root), HANDOFF_DIR);
  const out = [];
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
    const names = fs.readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(d, name), "utf-8")));
      } catch {
        continue;
      }
    }
  }
  // Group the human-facing summary by owner so a report can route at a glance.
  const byOwner = {};
  for (const h of out) {
    const key = h.owner_plugin || "(unrouted)";
    byOwner[key] = (byOwner[key] || 0) + 1;
  }
  return { status: "ok", count: out.length, by_owner: byOwner, handoffs: out };
}

function clear(payload, root) {
  const d = path.join(String(root), HANDOFF_DIR);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    return { status: "ok", removed: 0 };
  }
  let removed = 0;
  if (payload.all) {
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(d, name));
        removed += 1;
      } catch {
        // ignore
      }
    }
    return { status: "ok", removed };
  }
  const hid = String(payload.id || "");
  if (!hid) {
    return { status: "failed", reason: 'clear needs an id or {"all": true}' };
  }
  const suffix = `-${hid}.json`;
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith(suffix)) continue;
    try {
      fs.unlinkSync(path.join(d, name));
      removed += 1;
    } catch {
      // ignore
    }
  }
  return { status: "ok", removed };
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "project-root": { type: "string", default: undefined },
    },
    allowPositionals: true,
  });
  const mode = positionals[0];
  if (!["routes", "stage", "list", "clear"].includes(mode)) {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
  }
  const root = values["project-root"] === undefined
    ? findProjectRoot()
    : path.resolve(values["project-root"]);

  if (mode === "routes") {
    emit(routes());
  } else if (mode === "stage") {
    emit(stage(readStdinJson() || {}, root));
  } else if (mode === "list") {
    emit(listPending(root));
  } else if (mode === "clear") {
    emit(clear(readStdinJson() || {}, root));
  }
}

if (require.main === module) {
  main();
}

module.exports = { routes, stage, listPending, clear };
