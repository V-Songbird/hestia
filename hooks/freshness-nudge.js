"use strict";

const fs = require("fs");
const path = require("path");

const { scan } = require("../scripts/drift");

const THROTTLE_DAYS = 14;

function projectDir() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(isoDate) {
  const then = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date(today() + "T00:00:00Z");
  return Math.round((now - then) / 86400000);
}

function main() {
  const root = projectDir();
  const result = scan(root);
  if (!result.stale_files.length) return;

  const marker = path.join(root, ".hestia", "freshness-nudge.json");
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(marker, "utf-8"));
  } catch {
    prev = {};
  }

  const sameSig = Boolean(prev.signature) && prev.signature === result.signature;
  let recent = false;
  if (sameSig && prev.date) {
    const diff = daysSince(prev.date);
    recent = diff !== null && diff < THROTTLE_DAYS;
  }
  const setupStale = (result.staleness || {}).label === "stale";
  if (sameSig && recent && !setupStale) return;

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
      JSON.stringify({ signature: result.signature, date: today() }),
      "utf-8"
    );
  } catch {
    // best-effort
  }

  const files = result.stale_files
    .slice(0, 5)
    .map((s) => s.path)
    .join(", ");
  const n = result.total_broken;
  const msg =
    `Hestia: ${n} broken reference(s) in this project's instruction files (${files}) ` +
    `— Claude is working from stale paths. Surface this to the user at the first ` +
    `natural break and offer /hestia:freshness or /hestia:checkup; don't sit on it.`;
  try {
    process.stdout.write(Buffer.from(msg, "utf-8"));
  } catch {
    // stdout write failure -> mirror Python's OSError swallow
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { projectDir, main };
