"use strict";

const fs = require("fs");
const path = require("path");
const _lib = require("./_lib");

const DATA_DIR = path.join(__dirname, "_data");

function loadRubric(name) {
  return fs.readFileSync(path.join(DATA_DIR, name), "utf-8");
}

function buildPrompt(data) {
  const rules = data.rules || [];
  const projectContext = data.project_context || {};

  const rubricF3 = loadRubric("rubric_F3.md");
  const rubricF8 = loadRubric("rubric_F8.md");

  const sections = [];

  sections.push("# Quality Factor Scoring\n");
  sections.push("Score F3 and F8 for every rule.\n");

  sections.push("## Project Context");
  const stack = projectContext.stack || [];
  sections.push(`Stack: ${stack.length ? stack.join(", ") : "unknown"}`);

  const alwaysLoaded = projectContext.always_loaded_files || [];
  sections.push(`Always-loaded files: ${alwaysLoaded.length ? alwaysLoaded.join(", ") : "none"}`);

  const globScoped = projectContext.glob_scoped_files || [];
  if (globScoped.length) {
    const globsSummary = globScoped
      .slice(0, 5)
      .map((gf) => (gf.globs && gf.globs.length ? gf.globs[0] : "?"))
      .join(", ");
    sections.push(`Glob-scoped files: ${globScoped.length} files covering ${globsSummary}`);
  } else {
    sections.push("Glob-scoped files: none");
  }

  sections.push("");
  sections.push("Note: glob-scoped rules have their trigger anchored to the glob pattern.");
  sections.push("\"I'm editing a file matching this glob\" IS the trigger context for F3.\n");

  const tooling = projectContext.tooling || {};
  const configured = Object.keys(tooling).filter((name) => tooling[name]);
  if (configured.length) {
    const notDetected = Object.keys(tooling).filter((name) => !tooling[name]);
    sections.push(`Configured enforcement: ${configured.join(", ")}`);
    if (notDetected.length) {
      sections.push(`Not detected: ${notDetected.join(", ")}`);
    }
  } else {
    sections.push("No enforcement tooling detected.");
  }
  sections.push("");

  sections.push("## F3: Trigger-Action Distance");
  sections.push(rubricF3.trim());
  sections.push("");

  sections.push("## F8: Enforceability Ceiling");
  sections.push(rubricF8.trim());
  sections.push("Score enforceability against this project's detected stack and tooling, not in the abstract.\n");

  sections.push("## Rules\n");
  sections.push("| ID | File | Globs | Text | Flags |");
  sections.push("|---|---|---|---|---|");

  const sourceFiles = data.source_files || [];

  for (const rule of rules) {
    const ruleId = rule.id;
    const fi = rule.file_index || 0;
    const sf = fi < sourceFiles.length ? sourceFiles[fi] : {};

    const filePath = sf.path || "unknown";
    const globs = sf.globs || [];
    const globsStr = globs.length ? globs.join(", ") : "always-loaded";

    let text = rule.text.slice(0, 120);
    if (rule.text.length > 120) {
      text += "...";
    }

    const flags = buildFlags(rule);

    sections.push(`| ${ruleId} | ${filePath} | ${globsStr} | "${text}" | ${flags} |`);
  }

  sections.push("");

  sections.push("## Response format\n");
  sections.push("Respond with ONLY a JSON array. No prose, no markdown fences.");
  sections.push("One object per rule. Always include F3 and F8.");
  sections.push("Reasoning: one sentence, max 80 characters.\n");
  sections.push('[{"id":"R001","F3":{"value":0.80,"level":3,"reasoning":"..."},');
  sections.push('  "F8":{"value":0.65,"level":2,"reasoning":"..."}}]');

  return sections.join("\n");
}

function buildFlags(rule) {
  const flags = [];
  const confidenceLow = rule.factor_confidence_low || [];

  if (confidenceLow.includes("F3")) {
    const factors = rule.factors || {};
    const f3 = factors.F3 || {};
    flags.push(`F3: mech=${f3.value !== undefined ? f3.value : "?"}`);
  }

  if (confidenceLow.includes("F8")) {
    const factors = rule.factors || {};
    const f8 = factors.F8 || {};
    flags.push(`F8: mech=${f8.value !== undefined ? f8.value : "?"}`);
  }

  return flags.length ? flags.join("; ") : "—";
}

const BATCH_SIZE_DEFAULT = 12;
const BATCH_THRESHOLD = 20;

function partitionRules(rules, sourceFiles, batchSize = BATCH_SIZE_DEFAULT) {
  if (!rules.length) return [];

  function sortKey(rule) {
    const fi = rule.file_index || 0;
    const sf = fi < sourceFiles.length ? sourceFiles[fi] : {};
    return [sf.path || "", rule.line_start || 0];
  }

  const sortedRules = [...rules].sort((a, b) => {
    const [pathA, lineA] = sortKey(a);
    const [pathB, lineB] = sortKey(b);
    if (pathA !== pathB) return pathA < pathB ? -1 : 1;
    return lineA - lineB;
  });

  const fileGroups = [];
  let currentGroup = [];
  let currentFi = null;
  for (const rule of sortedRules) {
    const fi = rule.file_index || 0;
    if (fi !== currentFi && currentGroup.length) {
      fileGroups.push(currentGroup);
      currentGroup = [];
    }
    currentFi = fi;
    currentGroup.push(rule);
  }
  if (currentGroup.length) fileGroups.push(currentGroup);

  const batches = [];
  let currentBatch = [];
  for (const group of fileGroups) {
    if (group.length <= batchSize) {
      if (currentBatch.length + group.length <= batchSize) {
        currentBatch.push(...group);
      } else {
        if (currentBatch.length) batches.push(currentBatch);
        currentBatch = [...group];
      }
    } else {
      if (currentBatch.length) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      for (let i = 0; i < group.length; i += batchSize) {
        batches.push(group.slice(i, i + batchSize));
      }
    }
  }

  if (currentBatch.length) batches.push(currentBatch);

  return batches;
}

function buildBatchPrompt(data, ruleSubset, batchNum, totalBatches, isContinuation = false) {
  const batchData = { ...data, rules: ruleSubset };
  let prompt = buildPrompt(batchData);

  let batchNote = `\n*Batch ${batchNum} of ${totalBatches}.*`;
  if (isContinuation) {
    const fi = ruleSubset.length ? ruleSubset[0].file_index || 0 : 0;
    const sourceFiles = data.source_files || [];
    const sf = fi < sourceFiles.length ? sourceFiles[fi] : {};
    const filePath = sf.path || "unknown";
    batchNote +=
      `\n*Note: These rules continue from ${filePath}. ` +
      "See previous batch for earlier rules from this file.*";
  }

  const idx = prompt.indexOf("\n");
  if (idx !== -1) {
    prompt = prompt.slice(0, idx) + batchNote + "\n" + prompt.slice(idx + 1);
  }

  return prompt;
}

function main() {
  let batchDir = null;
  let inputPath = null;
  let outputPath = null;
  const args = process.argv.slice(2);
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--batch-dir" && i + 1 < args.length) {
      batchDir = args[i + 1];
      i += 2;
    } else if (args[i] === "--input" && i + 1 < args.length) {
      inputPath = args[i + 1];
      i += 2;
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputPath = args[i + 1];
      i += 2;
    } else {
      i += 1;
    }
  }

  let data;
  if (inputPath) {
    data = _lib.readJson(inputPath);
  } else {
    data = _lib.readStdinJson();
    if (!data) {
      _lib.fail("empty input");
    }
  }

  const rules = data.rules || [];
  const sourceFiles = data.source_files || [];

  if (batchDir && rules.length > BATCH_THRESHOLD) {
    fs.mkdirSync(batchDir, { recursive: true });
    const batches = partitionRules(rules, sourceFiles);

    let prevLastFi = null;
    const manifestBatches = [];

    for (let idx = 0; idx < batches.length; idx++) {
      const batch = batches[idx];
      const batchNum = idx + 1;
      const firstFi = batch.length ? batch[0].file_index || 0 : null;
      const isContinuation = firstFi !== null && firstFi === prevLastFi;

      const prompt = buildBatchPrompt(data, batch, batchNum, batches.length, isContinuation);

      const promptPath = path.join(batchDir, `prompt_${String(batchNum).padStart(3, "0")}.md`);
      fs.writeFileSync(promptPath, prompt, "utf-8");

      manifestBatches.push({
        file: `prompt_${String(batchNum).padStart(3, "0")}.md`,
        rule_ids: batch.map((r) => r.id),
      });

      prevLastFi = batch.length ? batch[batch.length - 1].file_index || 0 : null;
    }

    const manifest = {
      batch_count: batches.length,
      batch_size_target: BATCH_SIZE_DEFAULT,
      total_rules: rules.length,
      batches: manifestBatches,
    };
    const manifestPath = path.join(batchDir, "batch_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  } else {
    const prompt = buildPrompt(data);
    if (outputPath) {
      fs.writeFileSync(outputPath, prompt + "\n", "utf-8");
    } else {
      process.stdout.write(prompt);
      process.stdout.write("\n");
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPrompt,
  buildBatchPrompt,
  partitionRules,
  BATCH_SIZE_DEFAULT,
  BATCH_THRESHOLD,
};
