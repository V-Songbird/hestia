"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const _lib = require("./_lib.js");

const SCRIPTS_DIR = __dirname;
const NODE = process.execPath;
const TMP_DIR = ".hestia-tmp";
const BATCH_THRESHOLD = 20;

const _FRIENDLY_FIXES = {
  F1: "Start with a clear action verb: Use, Always, Never, Run",
  F2: "Flip from 'don't do X' to 'do Y instead'",
  F3: "Add a trigger: 'When editing X...' or 'Before committing...'",
  F4: "Move to a scoped rule file with paths: frontmatter, or broaden the language",
  F7: "Add a file path, code example, or before/after comparison",
};

const _LETTER_GRADES = [
  [0.80, "A"],
  [0.65, "B"],
  [0.50, "C"],
  [0.35, "D"],
];

const _FRIENDLY_STRENGTHS = {
  F1: "Strong action verb",
  F2: "Clear positive framing",
  F3: "Specific trigger context",
  F4: "Well-scoped to the right files",
  F7: "Concrete examples or file paths",
};

const _FRIENDLY_PROBLEMS = {
  F1: "Weak verb",
  F2: "Phrased as a prohibition",
  F3: "Unclear trigger",
  F4: "Loaded in the wrong context",
  F7: "Too vague",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _subprocessEnv() {
  return { ...process.env, PYTHONIOENCODING: "utf-8" };
}

function _runSubprocess(cmd, stdinData, timeout = 120000) {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    input: stdinData !== undefined && stdinData !== null ? stdinData : "",
    encoding: "utf-8",
    env: _subprocessEnv(),
    timeout,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const scriptName = cmd.length > 1 ? path.basename(cmd[1]) : cmd[0];
    process.stderr.write(
      `${scriptName} failed (exit ${result.status}): ${result.stderr}\n`
    );
    process.exit(1);
  }
  return result;
}

function _runPipeline(projectRoot) {
  const env = _subprocessEnv();
  const common = { encoding: "utf-8", env, maxBuffer: 1024 * 1024 * 1024, timeout: 120000 };

  const r1 = spawnSync(
    NODE,
    [path.join(SCRIPTS_DIR, "extract.js"), "--project-root", projectRoot],
    { ...common, input: "" }
  );
  if (r1.status !== 0) {
    process.stderr.write(`extract.js failed (exit ${r1.status}): ${r1.stderr}\n`);
    process.exit(1);
  }

  const r2 = spawnSync(
    NODE,
    [path.join(SCRIPTS_DIR, "score_mechanical.js")],
    { ...common, input: r1.stdout }
  );
  if (r2.status !== 0) {
    process.stderr.write(`score_mechanical.js failed (exit ${r2.status}): ${r2.stderr}\n`);
    process.exit(1);
  }

  const r3 = spawnSync(
    NODE,
    [path.join(SCRIPTS_DIR, "score_semi.js")],
    { ...common, input: r2.stdout }
  );
  if (r3.status !== 0) {
    process.stderr.write(`score_semi.js failed (exit ${r3.status}): ${r3.stderr}\n`);
    process.exit(1);
  }

  return r3.stdout;
}

function _readTmpJson(filename) {
  return _lib.readJson(path.join(TMP_DIR, filename));
}

function _writeTmpJson(filename, data) {
  _lib.writeJson(path.join(TMP_DIR, filename), data);
}

function _flattenJudgments(inputPath, flatOutputPath) {
  const data = _lib.readJson(inputPath);

  if (Array.isArray(data)) {
    return inputPath;
  }

  if (data && typeof data === "object" && "batches" in data) {
    const flat = [];
    for (const batch of data.batches) {
      flat.push(...(batch.judgments || []));
    }
    _lib.writeJson(flatOutputPath, flat);
    return flatOutputPath;
  }

  return inputPath;
}

function _applyPatches(scored, patchesData) {
  const patches = patchesData.patches || {};
  for (const rule of scored.rules || []) {
    const ruleId = rule.id;
    if (!(ruleId in patches)) continue;
    const patch = patches[ruleId];
    for (const [factorName, factorData] of Object.entries(patch)) {
      if (factorName.endsWith("_patch")) {
        const baseName = factorName.replace("_patch", "");
        if (rule.factors && baseName in rule.factors) {
          if (factorData && typeof factorData === "object" && "value" in factorData) {
            rule.factors[baseName].value = factorData.value;
            rule.factors[baseName].method = "judgment_patch";
          }
        }
      } else if (factorName === "F3" || factorName === "F8") {
        if (!rule.factors) rule.factors = {};
        rule.factors[factorName] = factorData;
      }
    }
  }
  return scored;
}

function _runScoringPipe(inputJson) {
  const result1 = _runSubprocess(
    [NODE, path.join(SCRIPTS_DIR, "score_mechanical.js")],
    inputJson
  );
  const result2 = _runSubprocess(
    [NODE, path.join(SCRIPTS_DIR, "score_semi.js")],
    result1.stdout
  );
  return result2.stdout;
}

function _runComposeAndSave(scoredWithPatches, auditFilename) {
  const inputJson = JSON.stringify(scoredWithPatches);
  const result = _runSubprocess(
    [NODE, path.join(SCRIPTS_DIR, "compose.js")],
    inputJson
  );
  _writeTmpJson(auditFilename, JSON.parse(result.stdout));
}

function _runReport(auditFilename, verbose, useJson) {
  const auditPath = path.join(TMP_DIR, auditFilename);
  const reportCmd = [NODE, path.join(SCRIPTS_DIR, "report.js"), "--input", auditPath];
  if (verbose) reportCmd.push("--verbose");
  if (useJson) reportCmd.push("--json");

  const result = spawnSync(reportCmd[0], reportCmd.slice(1), {
    encoding: "utf-8",
    env: _subprocessEnv(),
    timeout: 60000,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(`report.js failed (exit ${result.status}): ${result.stderr}\n`);
    process.exit(1);
  }

  process.stdout.write(result.stdout);
}

function _letterGrade(score) {
  for (const [threshold, grade] of _LETTER_GRADES) {
    if (score >= threshold) return grade;
  }
  return "F";
}

function _friendlySummary(rule) {
  const dw = rule.dominant_weakness;
  if (dw) {
    return _FRIENDLY_PROBLEMS[dw] || "Review and improve";
  }

  const factors = rule.factors || {};
  const scored = [];
  for (const fn of ["F1", "F2", "F3", "F4", "F7"]) {
    const fdata = factors[fn] || {};
    const val = fdata.value;
    if (val !== null && val !== undefined) {
      scored.push([val, fn]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored
    .slice(0, 3)
    .map(([, fn]) => _FRIENDLY_STRENGTHS[fn])
    .filter((s) => s !== undefined);
  return top.length ? top.join(", ") : "Well-structured rule";
}

// ---------------------------------------------------------------------------
// Mode implementations
// ---------------------------------------------------------------------------

function cmdPrepare(projectRoot) {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(TMP_DIR, ".gitignore"), "*\n", "utf-8");

  const stdout = _runPipeline(projectRoot);
  const scored = JSON.parse(stdout);
  _writeTmpJson("scored_semi.json", scored);

  const ruleCount = (scored.rules || []).length;
  const batchMode = ruleCount > BATCH_THRESHOLD;

  const scoredPath = path.join(TMP_DIR, "scored_semi.json");

  let metadata;
  if (batchMode) {
    const batchDir = path.join(TMP_DIR, "batches");
    _runSubprocess([
      NODE, path.join(SCRIPTS_DIR, "build_prompt.js"),
      "--batch-dir", batchDir,
      "--input", scoredPath,
    ]);
    const manifest = _readTmpJson("batches/batch_manifest.json");
    metadata = {
      rule_count: ruleCount,
      batch_count: manifest.batch_count,
      batch_mode: true,
      prompt_files: manifest.batches.map((b) =>
        path.join(TMP_DIR, "batches", b.file)
      ),
      single_prompt: null,
      manifest: path.join(TMP_DIR, "batches", "batch_manifest.json"),
    };
  } else {
    const promptPath = path.join(TMP_DIR, "prompt.md");
    _runSubprocess([
      NODE, path.join(SCRIPTS_DIR, "build_prompt.js"),
      "--input", scoredPath,
      "--output", promptPath,
    ]);
    metadata = {
      rule_count: ruleCount,
      batch_count: 0,
      batch_mode: false,
      prompt_files: [],
      single_prompt: promptPath,
      manifest: null,
    };
  }

  _lib.emit(metadata);
}

function cmdFinalize(verbose = false, useJson = false) {
  const scoredPath = path.join(TMP_DIR, "scored_semi.json");
  const judgmentsPath = path.join(TMP_DIR, "all_judgments.json");
  const flatPath = path.join(TMP_DIR, "_flat_judgments.json");
  const patchesPath = path.join(TMP_DIR, "judgment_patches.json");

  const effectiveInput = _flattenJudgments(judgmentsPath, flatPath);

  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "parse_judgment.js"),
    scoredPath,
    "--input", effectiveInput,
    "--output", patchesPath,
  ]);

  const scored = _readTmpJson("scored_semi.json");
  const patchesData = _readTmpJson("judgment_patches.json");
  const scoredPatched = _applyPatches(scored, patchesData);
  _runComposeAndSave(scoredPatched, "rules-audit.json");

  _runReport("rules-audit.json", verbose, useJson);
}

function cmdPrepareFix() {
  const audit = _readTmpJson("rules-audit.json");
  const rules = audit.rules || [];
  const files = audit.files || [];

  const qualifying = [];
  for (const r of rules) {
    if (r.category !== "mandate") continue;
    if ((r.score ?? 1.0) >= 0.50) continue;

    let filePath = r.file || "";
    if (!filePath) {
      const fi = r.file_index || 0;
      if (fi < files.length) {
        filePath = files[fi].path || "";
      }
    }

    const dw = r.dominant_weakness;
    qualifying.push({
      rule_id: r.id,
      file: filePath,
      line_start: r.line_start || 0,
      text: r.text || "",
      score: r.score || 0,
      dominant_weakness: dw,
      action: _FRIENDLY_FIXES[dw] || "Review and improve",
    });
  }

  _lib.emit({
    qualifying_count: qualifying.length,
    rules: qualifying,
  });
}

function cmdScoreRewrites() {
  const auditPath = path.join(TMP_DIR, "rules-audit.json");
  const rewritesPath = path.join(TMP_DIR, "rewrites_input.json");
  const rewriteSemiPath = path.join(TMP_DIR, "rewrite_semi.json");

  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "rewrite_scorer.js"),
    "--score-rewrites", auditPath, rewritesPath,
    "--output", rewriteSemiPath,
  ]);

  const rewriteSemi = _readTmpJson("rewrite_semi.json");
  const ruleCount = (rewriteSemi.rules || []).length;
  const batchMode = ruleCount > BATCH_THRESHOLD;

  let metadata;
  if (batchMode) {
    const batchDir = path.join(TMP_DIR, "rewrite_batches");
    _runSubprocess([
      NODE, path.join(SCRIPTS_DIR, "build_prompt.js"),
      "--batch-dir", batchDir,
      "--input", rewriteSemiPath,
    ]);
    const manifest = _readTmpJson("rewrite_batches/batch_manifest.json");
    metadata = {
      rule_count: ruleCount,
      batch_count: manifest.batch_count,
      batch_mode: true,
      prompt_files: manifest.batches.map((b) =>
        path.join(TMP_DIR, "rewrite_batches", b.file)
      ),
      single_prompt: null,
      manifest: path.join(TMP_DIR, "rewrite_batches", "batch_manifest.json"),
    };
  } else {
    const promptPath = path.join(TMP_DIR, "rewrite_prompt.md");
    _runSubprocess([
      NODE, path.join(SCRIPTS_DIR, "build_prompt.js"),
      "--input", rewriteSemiPath,
      "--output", promptPath,
    ]);
    metadata = {
      rule_count: ruleCount,
      batch_count: 0,
      batch_mode: false,
      prompt_files: [],
      single_prompt: promptPath,
      manifest: null,
    };
  }

  _lib.emit(metadata);
}

function cmdFinalizeFix(verbose = false, useJson = false) {
  const rewriteSemiPath = path.join(TMP_DIR, "rewrite_semi.json");
  const judgmentsPath = path.join(TMP_DIR, "rewrite_judgments.json");
  const flatPath = path.join(TMP_DIR, "_flat_rewrite_judgments.json");
  const patchesPath = path.join(TMP_DIR, "rewrite_patches.json");
  const auditPath = path.join(TMP_DIR, "rules-audit.json");
  const rewritesPath = path.join(TMP_DIR, "rewrites.json");

  const effectiveInput = _flattenJudgments(judgmentsPath, flatPath);

  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "parse_judgment.js"),
    rewriteSemiPath,
    "--input", effectiveInput,
    "--output", patchesPath,
  ]);

  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "rewrite_scorer.js"),
    "--finalize", rewriteSemiPath, patchesPath, auditPath,
    "--output", rewritesPath,
  ]);

  const audit = _readTmpJson("rules-audit.json");
  const rewrites = _readTmpJson("rewrites.json");
  audit.rewrites = rewrites;
  _writeTmpJson("rules-audit.json", audit);

  _runReport("rules-audit.json", verbose, useJson);
}

function cmdScoreDraft(draftPath) {
  const draft = _lib.readJson(draftPath);

  const rules = draft.rules;
  const targetFile = draft.file || ".claude/rules/draft.md";
  const category = draft.category || "mandate";

  const _extract = require("./extract.js");
  const fragmenting = [];
  for (const r of rules) {
    const fragments = _extract.wouldFragment(r.text);
    if (fragments.length > 1) {
      fragmenting.push({
        id: r.id,
        text: r.text,
        fragment_count: fragments.length,
        fragments_preview: fragments.map((f) => f.slice(0, 120)),
        reason:
          "Rule contains a splitter pattern (`, and` / ` and ` " +
          "between independent imperatives, `;` outside a code " +
          "span, or ` — ` followed by a clause with its own " +
          "verb). On the next audit pass extract.py would " +
          "fragment it into multiple rules that each score F. " +
          "Revise to use `or`, drop semicolons, or collapse to " +
          "a single directive.",
      });
    }
  }

  if (fragmenting.length) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const gitignorePath = path.join(TMP_DIR, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n", "utf-8");
    }
    _lib.emit({
      status: "needs_revision",
      fragmenting_rules: fragmenting,
    });
    return;
  }

  const sourceFiles = [{
    path: targetFile,
    globs: [],
    glob_match_count: null,
    default_category: category,
    line_count: rules.length + 5,
    always_loaded: true,
  }];

  const pipelineRules = rules.map((r, i) => ({
    id: r.id,
    file_index: 0,
    text: r.text,
    line_start: 5 + i,
    line_end: 5 + i,
    category,
    referenced_entities: [],
    staleness: { gated: false, missing_entities: [] },
    factors: {},
  }));

  const pipelineInput = {
    schema_version: "0.1",
    pipeline_version: "0.1.0",
    project_context: { stack: [] },
    config: {},
    source_files: sourceFiles,
    rules: pipelineRules,
  };

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const gitignorePath = path.join(TMP_DIR, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n", "utf-8");
  }

  const inputJson = JSON.stringify(pipelineInput);
  const scoredRaw = _runScoringPipe(inputJson);
  const scored = JSON.parse(scoredRaw);
  _writeTmpJson("draft_scored_semi.json", scored);

  const scoredPath = path.join(TMP_DIR, "draft_scored_semi.json");
  const promptPath = path.join(TMP_DIR, "draft_prompt.md");
  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "build_prompt.js"),
    "--input", scoredPath,
    "--output", promptPath,
  ]);

  const outputRules = (scored.rules || []).map((rule) => ({
    id: rule.id,
    text: rule.text,
    factors: rule.factors || {},
    needs_judgment: true,
  }));

  _lib.emit({
    status: "ok",
    rules: outputRules,
    judgment_prompt: path.join(TMP_DIR, "draft_prompt.md"),
  });
}

function cmdFinalizeDraft() {
  const scoredPath = path.join(TMP_DIR, "draft_scored_semi.json");
  const judgmentsPath = path.join(TMP_DIR, "draft_judgments.json");
  const flatPath = path.join(TMP_DIR, "_draft_flat_judgments.json");
  const patchesPath = path.join(TMP_DIR, "draft_patches.json");

  const effectiveInput = _flattenJudgments(judgmentsPath, flatPath);

  _runSubprocess([
    NODE, path.join(SCRIPTS_DIR, "parse_judgment.js"),
    scoredPath,
    "--input", effectiveInput,
    "--output", patchesPath,
  ]);

  const scored = _readTmpJson("draft_scored_semi.json");
  const patchesData = _readTmpJson("draft_patches.json");
  const scoredPatched = _applyPatches(scored, patchesData);
  _runComposeAndSave(scoredPatched, "draft_audit.json");

  const audit = _readTmpJson("draft_audit.json");
  const weights = _lib.loadData("weights");
  const categoryFloors = weights.category_floors;

  const outputRules = (audit.rules || []).map((rule) => {
    const score = rule.score || 0;
    const cat = rule.category || "mandate";
    const floor = categoryFloors[cat] ?? 0.50;
    const grade = _letterGrade(score);
    const passed = score >= floor;

    return {
      id: rule.id,
      text: rule.text || "",
      score: Math.round(score * 100) / 100,
      grade,
      dominant_weakness: rule.dominant_weakness,
      pass: passed,
      friendly_summary: _friendlySummary(rule),
    };
  });

  const allPass = outputRules.every((r) => r.pass);

  _lib.emit({
    rules: outputRules,
    all_pass: allPass,
    floor: categoryFloors.mandate ?? 0.50,
  });
}

function cmdPreparePlacement() {
  const placement = require("./placement.js");
  const audit = _readTmpJson("rules-audit.json");
  const report = placement.analyzeCorpus(audit);
  _lib.emit(report);
}

function cmdWritePromotions(projectRoot) {
  const placement = require("./placement.js");
  const payload = _lib.readStdinJson();
  const result = placement.writePromotions(payload, path.resolve(projectRoot));
  _lib.emit(result);
  if (result.status !== "ok") {
    process.exit(1);
  }
}

function cmdBuildAnalysis() {
  const audit = _readTmpJson("rules-audit.json");
  const rules = audit.rules || [];
  const files = audit.files || [];

  const mandate = rules.filter((r) => r.category === "mandate");

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of mandate) {
    gradeCounts[_letterGrade(r.score || 0)] += 1;
  }

  const goodCount = gradeCounts.A + gradeCounts.B;
  const belowFloor = mandate.filter((r) => (r.score || 0) < 0.50).length;

  const fileInfo = files.map((f) => ({
    path: f.path || "?",
    rule_count: f.rule_count || 0,
    file_score: f.file_score || 0,
    grade: _letterGrade(f.file_score || 0),
    line_count: f.line_count || 0,
    dead_zone_count: f.dead_zone_count || 0,
  }));

  const claudeMdRules = rules.filter((r) => (r.file || "").endsWith("CLAUDE.md")).length;
  const rulesDir = rules.filter((r) => !(r.file || "").endsWith("CLAUDE.md"));
  const scoped = rulesDir.filter((r) => r.loading === "glob-scoped").length;
  const alwaysInDir = rulesDir.length - scoped;
  const claudeMdFile = files.find((f) => (f.path || "").endsWith("CLAUDE.md"));
  const claudeMdLines = claudeMdFile ? (claudeMdFile.line_count || 0) : 0;

  const sortedMandate = [...mandate].sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = sortedMandate.slice(0, 5).map((r) => ({
    id: r.id,
    text: (r.text || "").slice(0, 120),
    score: r.score || 0,
    grade: _letterGrade(r.score || 0),
    strength: _friendlySummary(r),
  }));
  const worst = sortedMandate.length
    ? sortedMandate.slice(-5).map((r) => ({
        id: r.id,
        text: (r.text || "").slice(0, 120),
        score: r.score || 0,
        grade: _letterGrade(r.score || 0),
        problem: _FRIENDLY_PROBLEMS[r.dominant_weakness || ""] || "Review",
      }))
    : [];

  const rulesForMap = rules.map((r) => ({
    id: r.id,
    text: (r.text || "").slice(0, 200),
    file: r.file || "",
    score: r.score || 0,
    grade: _letterGrade(r.score || 0),
    dominant_weakness: r.dominant_weakness,
    loading: r.loading || "always-loaded",
  }));

  const ecq = audit.effective_corpus_quality || {};
  _lib.emit({
    grade: _letterGrade(ecq.score || 0),
    score: ecq.score || 0,
    rule_count: mandate.length,
    good_count: goodCount,
    grade_counts: gradeCounts,
    below_floor_count: belowFloor,
    files: fileInfo,
    organization: {
      claude_md_rules: claudeMdRules,
      scoped_rules: scoped,
      always_loaded_rules_in_rules_dir: alwaysInDir,
      claude_md_lines: claudeMdLines,
    },
    best_rules: best,
    worst_rules: worst,
    rules_for_intention_map: rulesForMap,
  });
}

function cmdCleanup() {
  const existed = fs.existsSync(TMP_DIR);
  if (existed) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  _lib.emit({ status: "ok", removed: existed, path: TMP_DIR });
}

// ---------------------------------------------------------------------------
// Argument parsing and dispatch
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    process.stderr.write("Usage: run_audit.js <mode> [options]\n");
    process.stderr.write(
      "Modes: --prepare, --finalize, --prepare-fix, --score-rewrites, " +
        "--finalize-fix, --score-draft, --finalize-draft, --build-analysis, " +
        "--prepare-placement, --write-promotions, --cleanup\n"
    );
    process.exit(1);
  }

  const mode = args[0];
  const rest = args.slice(1);

  if (mode === "--prepare") {
    let projectRoot = ".";
    let i = 0;
    while (i < rest.length) {
      if (rest[i] === "--project-root" && i + 1 < rest.length) {
        projectRoot = rest[i + 1];
        i += 2;
      } else {
        i += 1;
      }
    }
    cmdPrepare(projectRoot);
  } else if (mode === "--finalize") {
    const verbose = rest.includes("--verbose");
    const useJson = rest.includes("--json");
    cmdFinalize(verbose, useJson);
  } else if (mode === "--prepare-fix") {
    cmdPrepareFix();
  } else if (mode === "--score-rewrites") {
    cmdScoreRewrites();
  } else if (mode === "--finalize-fix") {
    const verbose = rest.includes("--verbose");
    const useJson = rest.includes("--json");
    cmdFinalizeFix(verbose, useJson);
  } else if (mode === "--score-draft") {
    if (!rest.length) {
      process.stderr.write("Usage: run_audit.js --score-draft <draft.json>\n");
      process.exit(1);
    }
    cmdScoreDraft(rest[0]);
  } else if (mode === "--finalize-draft") {
    cmdFinalizeDraft();
  } else if (mode === "--build-analysis") {
    cmdBuildAnalysis();
  } else if (mode === "--prepare-placement") {
    cmdPreparePlacement();
  } else if (mode === "--write-promotions") {
    let projectRoot = ".";
    let i = 0;
    while (i < rest.length) {
      if (rest[i] === "--project-root" && i + 1 < rest.length) {
        projectRoot = rest[i + 1];
        i += 2;
      } else {
        i += 1;
      }
    }
    cmdWritePromotions(projectRoot);
  } else if (mode === "--cleanup") {
    cmdCleanup();
  } else {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
