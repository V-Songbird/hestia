"use strict";

const fs = require("fs");
const path = require("path");

function mergePatches(batchDir, scoredSemiPath) {
  const patchFiles = fs
    .readdirSync(batchDir)
    .filter((f) => /^patches_.*\.json$/.test(f))
    .sort()
    .map((f) => path.join(batchDir, f));

  if (patchFiles.length === 0) {
    console.error("FATAL: No patches_*.json files found in batch directory");
    process.exit(1);
  }

  const mergedPatches = {};
  let schemaVersion = null;
  let modelVersion = "unknown";

  for (const pf of patchFiles) {
    const raw = fs.readFileSync(pf, "utf-8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          data = JSON.parse(raw.slice(start, end + 1));
        } catch {
          console.error(`FATAL: Cannot parse JSON from ${path.basename(pf)}`);
          process.exit(1);
        }
      } else {
        console.error(`FATAL: Cannot parse JSON from ${path.basename(pf)}`);
        process.exit(1);
      }
    }

    const sv = data.schema_version;
    if (schemaVersion === null) {
      schemaVersion = sv;
    } else if (sv !== schemaVersion) {
      console.error(
        `WARNING: schema_version mismatch in ${path.basename(pf)}: '${sv}' vs '${schemaVersion}'`
      );
    }

    const mv = data.model_version ?? "unknown";
    if (mv !== "unknown") {
      modelVersion = mv;
    }

    const patches = data.patches ?? {};
    for (const [ruleId, patchData] of Object.entries(patches)) {
      if (ruleId in mergedPatches) {
        console.error(
          `WARNING: Duplicate rule ${ruleId} across batches, last one wins (from ${path.basename(pf)})`
        );
      }
      mergedPatches[ruleId] = patchData;
    }
  }

  const scoredData = JSON.parse(fs.readFileSync(scoredSemiPath, "utf-8"));

  const expectedIds = new Set(
    (scoredData.rules ?? []).filter((r) => "id" in r).map((r) => r.id)
  );
  const mergedIds = new Set(Object.keys(mergedPatches));

  const missing = [...expectedIds].filter((id) => !mergedIds.has(id));
  if (missing.length) {
    console.error(
      `WARNING: ${missing.length} rule IDs missing after merge: ${missing.sort().slice(0, 10).join(", ")}`
    );
  }

  const extra = [...mergedIds].filter((id) => !expectedIds.has(id));
  if (extra.length) {
    console.error(
      `WARNING: ${extra.length} unexpected rule IDs in patches: ${extra.sort().slice(0, 10).join(", ")}`
    );
  }

  return {
    schema_version: schemaVersion || "0.1",
    model_version: modelVersion,
    patches: mergedPatches,
  };
}

function main() {
  let outputPath = null;
  const positional = [];
  const args = process.argv.slice(2);
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--output" && i + 1 < args.length) {
      outputPath = args[i + 1];
      i += 2;
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }

  if (positional.length < 2) {
    console.error("Usage: merge_batch_patches.js <batch_dir> <scored_semi.json> [--output file]");
    process.exit(1);
  }

  const batchDir = positional[0];
  const scoredSemiPath = positional[1];

  const result = mergePatches(batchDir, scoredSemiPath);
  const text = JSON.stringify(result, null, 2);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text, "utf-8");
  } else {
    process.stdout.write(text);
    process.stdout.write("\n");
  }
}

if (require.main === module) {
  main();
}

module.exports = { mergePatches };
