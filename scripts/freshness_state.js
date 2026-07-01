"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const { readJson, writeJson } = require("./_lib");

const DEFAULTS = {
  fresh_max_commits: 20,
  stale_min_commits: 75,
  fresh_max_days: 14,
  stale_min_days: 60,
};

const STATE_DIR = ".hestia";
const CHECKUP_STATE_FILE = "checkup-state.json";
const CLEARED_FILE = "cleared.json";

function _git(args, root) {
  let out;
  try {
    out = execFileSync("git", args, {
      cwd: String(root),
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  return out.trim();
}

function currentHead(root) {
  return _git(["rev-parse", "HEAD"], path.resolve(String(root)));
}

function commitsSince(sha, root) {
  if (!sha) return null;
  const out = _git(["rev-list", "--count", `${sha}..HEAD`], path.resolve(String(root)));
  if (out === null) return null;
  if (!/^-?\d+$/.test(out)) return null;
  return parseInt(out, 10);
}

function _nowTs() {
  return new Date().toISOString();
}

function daysSince(ts) {
  if (!ts) return null;
  const then = new Date(ts);
  if (Number.isNaN(then.getTime())) return null;
  const deltaSeconds = (Date.now() - then.getTime()) / 1000;
  return Math.max(0.0, deltaSeconds / 86400.0);
}

function _round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function deriveStaleness(commits, days, { defaults = null } = {}) {
  const d = defaults || DEFAULTS;
  const haveCommits = commits !== null && commits !== undefined;
  const haveDays = days !== null && days !== undefined;

  if (!haveCommits && !haveDays) {
    return {
      label: "unknown",
      commits: null,
      days: null,
      reason: "no prior checkup recorded for this project",
    };
  }

  const staleHits = [];
  if (haveCommits && commits >= d.stale_min_commits) {
    staleHits.push(`${commits} commits since last checkup (>= ${d.stale_min_commits})`);
  }
  if (haveDays && days >= d.stale_min_days) {
    staleHits.push(`${_round(days)} days since last checkup (>= ${d.stale_min_days})`);
  }
  if (staleHits.length) {
    return {
      label: "stale",
      commits: haveCommits ? commits : null,
      days: haveDays ? _round(days, 1) : null,
      reason: staleHits.join("; "),
    };
  }

  const commitsFresh = !haveCommits || commits <= d.fresh_max_commits;
  const daysFresh = !haveDays || days <= d.fresh_max_days;
  if (commitsFresh && daysFresh) {
    const parts = [];
    if (haveCommits) parts.push(`${commits} commits since last checkup (<= ${d.fresh_max_commits})`);
    if (haveDays) parts.push(`${_round(days)} days ago (<= ${d.fresh_max_days})`);
    return {
      label: "fresh",
      commits: haveCommits ? commits : null,
      days: haveDays ? _round(days, 1) : null,
      reason: parts.join("; ") || "within fresh bounds",
    };
  }

  const parts = [];
  if (haveCommits) parts.push(`${commits} commits since last checkup`);
  if (haveDays) parts.push(`${_round(days)} days ago`);
  return {
    label: "aging",
    commits: haveCommits ? commits : null,
    days: haveDays ? _round(days, 1) : null,
    reason: parts.join("; ") + " — past fresh, not yet stale",
  };
}

function _statePath(root, name) {
  return path.join(String(root), STATE_DIR, name);
}

function loadCheckupState(root) {
  const p = _statePath(root, CHECKUP_STATE_FILE);
  let data;
  try {
    data = readJson(p);
  } catch {
    return {};
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function recordCheckup(root) {
  const record = { sha: currentHead(root), ts: _nowTs() };
  try {
    writeJson(_statePath(root, CHECKUP_STATE_FILE), record);
  } catch {
    // ignore
  }
  return record;
}

function stalenessFor(root, { defaults = null } = {}) {
  const prev = loadCheckupState(root);
  const sha = prev.sha !== undefined ? prev.sha : null;
  const ts = prev.ts !== undefined ? prev.ts : null;
  const result = deriveStaleness(commitsSince(sha, root), daysSince(ts), { defaults });
  result.last_sha = sha === undefined ? null : sha;
  result.last_ts = ts === undefined ? null : ts;
  return result;
}

function surfaceSignature(files) {
  const h = crypto.createHash("sha1");
  const sorted = Array.from(files, (x) => String(x)).sort();
  for (const f of sorted) {
    let token;
    try {
      const st = fs.statSync(f);
      const mtimeNs = BigInt(Math.round(st.mtimeMs * 1e6));
      token = `${f}|${st.size}|${mtimeNs.toString()}`;
    } catch {
      token = `${f}|absent`;
    }
    h.update(token, "utf-8");
    h.update(Buffer.from([0]));
  }
  return h.digest("hex").slice(0, 16);
}

function loadCleared(root) {
  const p = _statePath(root, CLEARED_FILE);
  let data;
  try {
    data = readJson(p);
  } catch {
    return {};
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function _saveCleared(root, data) {
  try {
    writeJson(_statePath(root, CLEARED_FILE), data);
  } catch {
    // ignore
  }
}

function isCleared(root, surface, currentSignature) {
  const rec = loadCleared(root)[surface];
  if (!rec || typeof rec !== "object") return false;
  return Boolean(currentSignature) && rec.signature === currentSignature;
}

function clearedRecord(root, surface) {
  const rec = loadCleared(root)[surface];
  return rec && typeof rec === "object" ? rec : null;
}

function recordCleared(root, surface, signature) {
  const data = loadCleared(root);
  const record = { signature, ts: _nowTs(), sha: currentHead(root) };
  data[surface] = record;
  _saveCleared(root, data);
  return record;
}

function clearSurface(root, surface) {
  const data = loadCleared(root);
  if (Object.prototype.hasOwnProperty.call(data, surface)) {
    delete data[surface];
    _saveCleared(root, data);
  }
}

module.exports = {
  DEFAULTS,
  STATE_DIR,
  CHECKUP_STATE_FILE,
  CLEARED_FILE,
  currentHead,
  commitsSince,
  daysSince,
  deriveStaleness,
  loadCheckupState,
  recordCheckup,
  stalenessFor,
  surfaceSignature,
  loadCleared,
  isCleared,
  clearedRecord,
  recordCleared,
  clearSurface,
};
