"use strict";

const path = require("path");
const crypto = require("crypto");
const { parseArgs } = require("util");

const { discover } = require("./discover");
const { stalenessFor } = require("./freshness_state");
const { brokenRefs } = require("./refs");
const { emit, limitNote } = require("./_lib");

const INSTRUCTION_KINDS = ["claude_md", "rules", "agents", "skills", "commands"];

function scan(projectRoot) {
  const inv = discover(projectRoot);
  const root = path.resolve(inv.project_root);
  const stale = [];
  let total = 0;
  for (const kind of INSTRUCTION_KINDS) {
    for (const item of inv.artifacts[kind]) {
      const broken = brokenRefs(path.join(root, item.path), root);
      if (broken.length) {
        stale.push({ path: item.path, kind, broken });
        total += broken.length;
      }
    }
  }

  let signature = "";
  if (stale.length) {
    const basis = stale
      .map((s) => `${s.path}:${s.broken.join(",")}`)
      .sort()
      .join("|");
    signature = crypto.createHash("sha1").update(basis, "utf-8").digest("hex").slice(0, 12);
  }

  const limits = [];
  if (!stale.length) {
    limits.push(
      limitNote(
        "freshness",
        "No stale references found.",
        "This only checks resolvable path-like references; " +
          "prose that describes outdated behavior is not detected. " +
          "Run /hestia:prose-drift to check semantic staleness."
      )
    );
  }
  limits.push(
    limitNote(
      "freshness-scope",
      "Reference detection is conservative — only path-like tokens (./ ../ ~/ " +
        ".claude/ or slash+extension), @imports, and relative markdown links are " +
        "verified. Time/churn signals are excluded (a fresh clone resets mtimes).",
      "A reference written in prose or pointing outside the " +
        "project tree may be stale without showing up here. " +
        "Run /hestia:prose-drift to scan for semantic staleness — rules or " +
        "CLAUDE.md directions that describe tools, commands, or structure the " +
        "code no longer confirms."
    )
  );

  const staleness = stalenessFor(root);

  return {
    status: "ok",
    project_root: root,
    stale_files: stale,
    total_broken: total,
    signature,
    staleness,
    limits,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string", default: undefined },
      check: { type: "boolean", default: false },
    },
  });
  const result = scan(values["project-root"]);
  emit(result);
  if (values.check && result.stale_files.length) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scan };
