"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const _lib = require("./_lib.js");

const SCRIPTS_DIR = __dirname;

function letterGrade(score) {
  if (score >= 0.80) return "A";
  if (score >= 0.65) return "B";
  if (score >= 0.50) return "C";
  if (score >= 0.35) return "D";
  return "F";
}

function runNode(scriptName, inputText) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, scriptName)], {
    input: inputText,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return result;
}

function scoreRewrites(auditPath, rewritesInputPath) {
  const audit = _lib.readJson(auditPath);
  const rewritesInput = _lib.readJson(rewritesInputPath);

  if (!rewritesInput || rewritesInput.length === 0) {
    return {
      schema_version: "0.1",
      pipeline_version: "0.1.0",
      project_context: {},
      config: {},
      source_files: [],
      rules: [],
    };
  }

  let sourceFiles = audit.source_files || [
    {
      path: "",
      globs: [],
      glob_match_count: 0,
      default_category: "mandate",
      line_count: 1,
      always_loaded: true,
    },
  ];
  if (!sourceFiles.length) {
    sourceFiles = [
      {
        path: "",
        globs: [],
        glob_match_count: 0,
        default_category: "mandate",
        line_count: 1,
        always_loaded: true,
      },
    ];
  }

  const rules = rewritesInput.map((rw, i) => ({
    id: rw.rule_id || `RW${String(i + 1).padStart(3, "0")}`,
    file_index: 0,
    text: rw.suggested_rewrite,
    line_start: rw.line_start != null ? rw.line_start : 1,
    line_end: rw.line_start != null ? rw.line_start : 1,
    category: "mandate",
    referenced_entities: [],
    staleness: { gated: false, missing_entities: [] },
    factors: {},
  }));

  const pipelineInput = {
    schema_version: "0.1",
    pipeline_version: "0.1.0",
    project_context: audit.project_context || { stack: [] },
    config: audit.config || {},
    source_files: [sourceFiles[0]],
    rules,
  };

  const inputJson = JSON.stringify(pipelineInput);

  const p1 = runNode("score_mechanical.js", inputJson);
  if (p1.status !== 0) {
    process.stderr.write(`score_mechanical.py failed: ${p1.stderr}\n`);
    process.exit(1);
  }

  const p2 = runNode("score_semi.js", p1.stdout);
  if (p2.status !== 0) {
    process.stderr.write(`score_semi.py failed: ${p2.stderr}\n`);
    process.exit(1);
  }

  const result = JSON.parse(p2.stdout);

  const { wouldFragment } = require("./extract.js");

  const resultRules = result.rules || [];
  for (let i = 0; i < resultRules.length; i++) {
    const rule = resultRules[i];
    if (i < rewritesInput.length) {
      const rw = rewritesInput[i];
      rule._rewrite_meta = {
        rule_id: rw.rule_id,
        original_text: rw.original_text || "",
        file: rw.file || "",
        line_start: rw.line_start || 0,
        old_score: rw.old_score || 0,
        old_dominant_weakness: rw.old_dominant_weakness != null ? rw.old_dominant_weakness : null,
        projected_score: rw.projected_score != null ? rw.projected_score : null,
      };
      const fragments = wouldFragment(rw.suggested_rewrite);
      if (fragments.length > 1) {
        rule._rewrite_meta.would_fragment = true;
        rule._rewrite_meta.fragment_count = fragments.length;
        rule._rewrite_meta.fragments_preview = fragments.map((f) => f.slice(0, 80));
        const ruleId = rw.rule_id || `RW${String(i + 1).padStart(3, "0")}`;
        process.stderr.write(
          `WARNING: ${ruleId} rewrite would fragment into ${fragments.length} rules when re-extracted. ` +
            `First fragment: ${JSON.stringify(fragments[0].slice(0, 80))}. Revise to use \`or\` instead of \`, and\`, ` +
            "drop semicolons, or collapse to a single directive.\n"
        );
      }
    }
  }

  return result;
}

function finalizeRewrites(rewriteSemiPath, patchesPath, auditPath) {
  const rewriteSemi = _lib.readJson(rewriteSemiPath);
  const audit = _lib.readJson(auditPath);
  const patchesData = _lib.readJson(patchesPath);
  const patches = patchesData.patches || patchesData;

  for (const rule of rewriteSemi.rules || []) {
    const ruleId = rule.id;
    if (!(ruleId in patches)) continue;
    const patch = patches[ruleId];
    if (!rule.factors) rule.factors = {};
    for (const [factorName, factorData] of Object.entries(patch)) {
      if (factorName.endsWith("_patch")) {
        const baseName = factorName.replace("_patch", "");
        if (
          baseName in rule.factors &&
          factorData &&
          typeof factorData === "object" &&
          "value" in factorData
        ) {
          rule.factors[baseName].value = factorData.value;
          rule.factors[baseName].method = "judgment_patch";
        }
      } else if (factorName === "F3" || factorName === "F8") {
        rule.factors[factorName] = factorData;
      }
    }
  }

  const result = runNode("compose.js", JSON.stringify(rewriteSemi));
  if (result.status !== 0) {
    process.stderr.write(`compose.py failed: ${result.stderr}\n`);
    process.exit(1);
  }

  const composed = JSON.parse(result.stdout);
  const composedRules = composed.rules || [];

  const auditRules = {};
  for (const r of audit.rules || []) auditRules[r.id] = r;

  const rewrites = [];
  for (const rule of composedRules) {
    const meta = rule._rewrite_meta || {};
    const ruleId = meta.rule_id != null ? meta.rule_id : rule.id != null ? rule.id : "?";
    const oldScore = meta.old_score || 0;
    const newScore = rule.score || 0;
    const oldGrade = letterGrade(oldScore);
    const newGrade = letterGrade(newScore);
    const projected = meta.projected_score != null ? meta.projected_score : null;

    // Safety gate 1: Regression — drop rewrites that score lower than original.
    if (newScore < oldScore) continue;

    const origRule = auditRules[ruleId] || {};
    const origFactors = origRule.factors || {};
    const newFactors = rule.factors || {};
    const improvements = {};
    for (const fn of ["F1", "F2", "F3", "F4", "F7", "F8"]) {
      const oldVal = origFactors[fn] ? origFactors[fn].value : undefined;
      const newVal = newFactors[fn] ? newFactors[fn].value : undefined;
      if (oldVal != null && newVal != null && newVal > oldVal) {
        improvements[fn] = [round2(oldVal), round2(newVal)];
      }
    }
    const hasImprovements = Object.keys(improvements).length > 0;

    // Safety gate 2: Judgment volatility — flag large F3 swings.
    const oldF3 = origFactors.F3 ? origFactors.F3.value : undefined;
    const newF3 = newFactors.F3 ? newFactors.F3.value : undefined;
    const f3Delta = Math.abs((newF3 || 0) - (oldF3 || 0));
    const jvFlagged = f3Delta > 0.2;

    // Safety gate 3: Self-verification delta.
    const svd = projected != null ? Math.abs(newScore - projected) : 0.0;

    rewrites.push({
      rule_id: ruleId,
      file: meta.file || "",
      line_start: meta.line_start || 0,
      original_text: meta.original_text || "",
      suggested_rewrite: rule.text || "",
      old_score: round3(oldScore),
      new_score: round3(newScore),
      delta: round3(newScore - oldScore),
      old_grade: oldGrade,
      new_grade: newGrade,
      old_dominant_weakness: meta.old_dominant_weakness != null ? meta.old_dominant_weakness : null,
      new_dominant_weakness: rule.dominant_weakness != null ? rule.dominant_weakness : null,
      factor_improvements: hasImprovements ? improvements : null,
      judgment_volatility: {
        flagged: jvFlagged,
        f3_delta: round2(f3Delta),
        old_f3: oldF3 != null ? oldF3 : null,
        new_f3: newF3 != null ? newF3 : null,
      },
      projected_score: projected,
      self_verification_delta: round3(svd),
    });
  }

  return rewrites;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    process.stderr.write("Usage:\n");
    process.stderr.write(
      "  rewrite_scorer.js --score-rewrites <audit.json> <rewrites_input.json> [--output file]\n"
    );
    process.stderr.write(
      "  rewrite_scorer.js --finalize <rewrite_semi.json> <patches.json> <audit.json> [--output file]\n"
    );
    process.exit(1);
  }

  let outputPath = null;
  const filtered = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--output" && i + 1 < argv.length) {
      outputPath = argv[i + 1];
      i += 2;
    } else {
      filtered.push(argv[i]);
      i += 1;
    }
  }

  if (!filtered.length) {
    process.stderr.write("Missing mode argument\n");
    process.exit(1);
  }

  const mode = filtered[0];
  const positional = filtered.slice(1);

  if (mode === "--score-rewrites") {
    if (positional.length !== 2) {
      process.stderr.write(
        "Usage: rewrite_scorer.js --score-rewrites <audit.json> <rewrites_input.json> [--output file]\n"
      );
      process.exit(1);
    }
    const result = scoreRewrites(positional[0], positional[1]);
    if (outputPath) {
      _lib.writeJson(outputPath, result);
    } else {
      _lib.emit(result);
    }
  } else if (mode === "--finalize") {
    if (positional.length !== 3) {
      process.stderr.write(
        "Usage: rewrite_scorer.js --finalize <rewrite_semi.json> <patches.json> <audit.json> [--output file]\n"
      );
      process.exit(1);
    }
    const rewrites = finalizeRewrites(positional[0], positional[1], positional[2]);
    if (outputPath) {
      _lib.writeJson(outputPath, rewrites);
    } else {
      process.stdout.write(JSON.stringify(rewrites, null, 2));
      process.stdout.write("\n");
    }
  } else {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scoreRewrites, finalizeRewrites, letterGrade };
