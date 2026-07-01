"use strict";

const _lib = require("./_lib");
const enforceability = require("./enforceability");

const _WEIGHTS = _lib.loadData("weights");
const _FACTOR_WEIGHTS = _WEIGHTS.weights;
const _SOFT_FLOOR_THRESHOLD = _WEIGHTS.soft_floor_threshold;
const _SOFT_FLOOR_FACTORS = _WEIGHTS.soft_floor_factors;
const _STALENESS_MULTIPLIER = _WEIGHTS.staleness_multiplier;
const _POSITION_WEIGHTS = _WEIGHTS.position_weights;
const _LENGTH_PENALTY = _WEIGHTS.length_penalty;
const _LOAD_PROB_DEFAULTS = _WEIGHTS.load_prob_defaults;
const _PARALLEL_FACTORS = _WEIGHTS.parallel_factors || {};
const _F8_HOOK_THRESHOLD = (_PARALLEL_FACTORS.F8 || {}).threshold ?? 0.4;

const _CLARITY_FACTORS = ["F1", "F2", "F7"];
const _ACTIVATION_FACTORS = ["F3", "F4"];

const _FACTOR_TO_FAILURE_CLASS = {
  F1: "ambiguity",
  F2: "ambiguity",
  F3: "drift",
  F4: "drift",
  F7: "ambiguity",
};

const _PROHIBIT_POLARITIES = new Set(["prohibition", "positive_with_negative_clarification"]);
const _ASSERT_POLARITIES = new Set(["positive_imperative", "positive_with_alternative"]);

const _CONFLICT_MARKER_STOPLIST = new Set([
  "use", "new", "old", "file", "files", "code", "rule", "rules",
  "test", "tests", "data", "line", "error", "name",
]);
const _CONFLICT_MARKER_MIN_LEN = 3;

const _FOLKLORE_SYMPTOM = "rule can't be enforced or self-checked";
const _FOLKLORE_WHY =
  "an unenforceable rule trains Claude the ruleset contains noise, " +
  "discounting the rules that do matter";
const _FOLKLORE_FIX =
  "rewrite to name a checkable condition — a command, threshold, or " +
  "concrete construct — or delete it";

function _ruleMarkers(rule) {
  const f7 = (rule.factors || {}).F7 || {};
  const raw = f7.concrete_markers || [];
  const out = new Set();
  for (const m of raw) {
    if (typeof m !== "string") continue;
    const lower = m.trim().toLowerCase();
    if (lower.length < _CONFLICT_MARKER_MIN_LEN) continue;
    if (_CONFLICT_MARKER_STOPLIST.has(lower)) continue;
    out.add(lower);
  }
  return out;
}

function _rulePolarity(rule) {
  const f2 = (rule.factors || {}).F2 || {};
  const cat = f2.matched_category;
  return typeof cat === "string" ? cat : null;
}

function detectConflicts(rules) {
  const mandate = rules.filter((r) => r.category === "mandate");
  const prepared = mandate.map((r) => [r, _ruleMarkers(r), _rulePolarity(r)]);
  const conflicts = [];
  for (let i = 0; i < prepared.length; i++) {
    const [rA, markersA, polA] = prepared[i];
    if (polA === null || markersA.size === 0) continue;
    for (let j = i + 1; j < prepared.length; j++) {
      const [rB, markersB, polB] = prepared[j];
      if (polB === null || markersB.size === 0) continue;

      let prohibit, assert_, prohibitPol, assertPol, prohibitMarkers, assertMarkers;
      if (_PROHIBIT_POLARITIES.has(polA) && _ASSERT_POLARITIES.has(polB)) {
        [prohibit, assert_] = [rA, rB];
        [prohibitPol, assertPol] = [polA, polB];
        [prohibitMarkers, assertMarkers] = [markersA, markersB];
      } else if (_PROHIBIT_POLARITIES.has(polB) && _ASSERT_POLARITIES.has(polA)) {
        [prohibit, assert_] = [rB, rA];
        [prohibitPol, assertPol] = [polB, polA];
        [prohibitMarkers, assertMarkers] = [markersB, markersA];
      } else {
        continue;
      }

      const shared = [...prohibitMarkers].filter((m) => assertMarkers.has(m));
      if (!shared.length) continue;

      conflicts.push({
        type: "polarity_mismatch",
        rule_a: {
          id: prohibit.id,
          text: prohibit.text || "",
          file: prohibit.file || "",
          line_start: prohibit.line_start || 0,
          polarity: prohibitPol,
        },
        rule_b: {
          id: assert_.id,
          text: assert_.text || "",
          file: assert_.file || "",
          line_start: assert_.line_start || 0,
          polarity: assertPol,
        },
        shared_markers: shared.sort(),
      });
    }
  }
  conflicts.sort((a, b) => {
    if (a.rule_a.id < b.rule_a.id) return -1;
    if (a.rule_a.id > b.rule_a.id) return 1;
    if (a.rule_b.id < b.rule_b.id) return -1;
    if (a.rule_b.id > b.rule_b.id) return 1;
    return 0;
  });
  return conflicts;
}

function buildFolkloreFindings(rules) {
  const findings = [];
  for (const rule of rules) {
    const enf = rule.enforceability || {};
    if (enf.class !== "folklore") continue;
    const file = rule.file || "";
    if (!file) continue;
    const qualityWords = enf.quality_words || enf.evidence || [];
    const finding = _lib.Finding.cited({
      severity: "medium",
      artifact: "rule",
      symptom: _FOLKLORE_SYMPTOM,
      why: _FOLKLORE_WHY,
      fixAction: _FOLKLORE_FIX,
      file,
      line: rule.line_start,
      fix: "assess-rules",
      tags: ["folklore", ...qualityWords.map((w) => `quality-word:${w}`)],
    });
    const d = finding.toDict();
    d.rule_id = rule.id || "";
    d.text = rule.text || "";
    d.quality_words = qualityWords;
    findings.push(d);
  }
  return findings;
}

function _suggestEnforcementLayer(rule) {
  const text = (rule.text || "").toLowerCase();
  if (["commit", "push", "force-push", "pre-commit"].some((kw) => text.includes(kw))) {
    return "Git hook (pre-commit / pre-push)";
  }
  if (["prettier", "eslint", "format", "lint", "tsc"].some((kw) => text.includes(kw))) {
    return "Linter or formatter config";
  }
  if (["import", "export", "barrel", "directive"].some((kw) => text.includes(kw))) {
    return "ESLint rule";
  }
  if (["edit", "write", "delete", "src/"].some((kw) => text.includes(kw))) {
    return "Claude Code hook (PreToolUse on Edit/Write)";
  }
  return "Mechanical enforcement (hook or linter)";
}

function smoothFloor(x, threshold) {
  if (threshold <= 0) return 1.0;
  return Math.min(1.0, x / threshold);
}

function _computeLayer(factorNames, factorValues) {
  let numerator = 0.0;
  let denominator = 0.0;
  for (const f of factorNames) {
    const val = factorValues[f];
    if (val !== null && val !== undefined) {
      numerator += _FACTOR_WEIGHTS[f] * val;
      denominator += _FACTOR_WEIGHTS[f];
    }
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

function round(v, n) {
  const m = 10 ** n;
  return Math.round((v + Number.EPSILON) * m) / m;
}

function computePerRuleScore(factors, staleness, _category) {
  const factorValues = {};
  const degradedFactors = [];
  for (const fName of Object.keys(_FACTOR_WEIGHTS)) {
    const fData = factors[fName] || {};
    const val = fData.value;
    if (val === null || val === undefined) {
      degradedFactors.push(fName);
      factorValues[fName] = null;
    } else {
      factorValues[fName] = val;
    }
  }

  const f8Data = factors.F8 || {};
  const f8Value = f8Data.value;
  const isHookCandidate = f8Value !== null && f8Value !== undefined && f8Value < _F8_HOOK_THRESHOLD;

  let numerator = 0.0;
  let activeWeight = 0.0;
  for (const f of Object.keys(_FACTOR_WEIGHTS)) {
    if (factorValues[f] !== null) {
      numerator += _FACTOR_WEIGHTS[f] * factorValues[f];
      activeWeight += _FACTOR_WEIGHTS[f];
    }
  }
  const preFloorScore = activeWeight > 0 ? numerator / activeWeight : 0.0;

  const floorValues = [];
  const skippedFloors = [];
  for (const f of _SOFT_FLOOR_FACTORS) {
    if (factorValues[f] !== null && factorValues[f] !== undefined) {
      floorValues.push(smoothFloor(factorValues[f], _SOFT_FLOOR_THRESHOLD));
    } else {
      skippedFloors.push(f);
    }
  }

  floorValues.push(staleness.gated ? _STALENESS_MULTIPLIER : 1.0);

  const floor = floorValues.length ? Math.min(...floorValues) : 1.0;
  const score = preFloorScore * floor;

  const contributions = {};
  for (const f of Object.keys(_FACTOR_WEIGHTS)) {
    if (factorValues[f] !== null) {
      contributions[f] = activeWeight > 0
        ? round((_FACTOR_WEIGHTS[f] * factorValues[f]) / activeWeight, 3)
        : 0.0;
    } else {
      contributions[f] = null;
    }
  }

  const clarity = _computeLayer(_CLARITY_FACTORS, factorValues);
  const activation = _computeLayer(_ACTIVATION_FACTORS, factorValues);
  const layers = {
    clarity: clarity !== null ? round(clarity, 3) : null,
    activation: activation !== null ? round(activation, 3) : null,
  };

  function _factorIsStructurallyCorrect(factorName) {
    if (factorName !== "F4") return false;
    return (factors.F4 || {}).trigger_match === "implicit_scope_trust";
  }

  let domWeakness = null;
  let domGap = 0.0;
  const nonNull = Object.fromEntries(
    Object.entries(factorValues).filter(([, v]) => v !== null)
  );
  const nonNullValues = Object.values(nonNull);
  const allPerfect = nonNullValues.length
    ? nonNullValues.every((v) => v >= 1.0)
    : true;
  if (!allPerfect) {
    for (const [f, v] of Object.entries(nonNull)) {
      if (_factorIsStructurallyCorrect(f)) continue;
      const gap = _FACTOR_WEIGHTS[f] * (1.0 - v);
      if (gap > domGap) {
        domGap = gap;
        domWeakness = f;
      }
    }
  }

  const mechFactors = ["F1", "F2", "F4", "F7"];
  let mechNum = 0.0;
  let mechWeight = 0.0;
  for (const f of mechFactors) {
    if (factorValues[f] !== null && factorValues[f] !== undefined) {
      mechNum += _FACTOR_WEIGHTS[f] * factorValues[f];
      mechWeight += _FACTOR_WEIGHTS[f];
    }
  }
  const mechanicalScore = mechWeight > 0 ? round(mechNum / mechWeight, 3) : null;

  const degraded = degradedFactors.length > 0;
  const scoredCount = Object.keys(_FACTOR_WEIGHTS).length - degradedFactors.length;

  return {
    score: round(score, 3),
    pre_floor_score: round(preFloorScore, 3),
    floor: round(floor, 3),
    contributions,
    layers,
    dominant_weakness: domWeakness,
    dominant_weakness_gap: round(domGap, 3),
    failure_class: domWeakness ? _FACTOR_TO_FAILURE_CLASS[domWeakness] || null : null,
    degraded,
    degraded_factors: degradedFactors,
    scored_count: scoredCount,
    skipped_floors: skippedFloors,
    mechanical_score: mechanicalScore,
    f8_value: f8Value !== null && f8Value !== undefined ? round(f8Value, 3) : null,
    is_hook_candidate: isHookCandidate,
  };
}

function _stddev(values) {
  if (!values.length) return 0.0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computePerFileScore(rules, fileInfo) {
  if (!rules.length) {
    return {
      file_score: 0.0,
      length_penalty: 1.0,
      prohibition_ratio: 0.0,
      trigger_scope_coherence: 0.0,
      concreteness_coverage: 0.0,
      dead_zone_count: 0,
    };
  }

  const lineCount = fileInfo.line_count || 0;
  const totalRules = rules.length;

  const maxW = _POSITION_WEIGHTS.edge;
  const minW = _POSITION_WEIGHTS.middle;
  let weightedSum = 0.0;
  let weightSum = 0.0;
  for (const rule of rules) {
    const positionPct = rule.line_start / Math.max(lineCount, 1);
    const triangular = 1.0 - Math.abs(2.0 * positionPct - 1.0);
    const posWeight = maxW - (maxW - minW) * triangular;
    weightedSum += posWeight * (rule.score || 0.0);
    weightSum += posWeight;
  }
  const positionWeightedMean = weightSum > 0 ? weightedSum / weightSum : 0.0;

  const threshold = _LENGTH_PENALTY.threshold_lines;
  let lengthPenalty;
  if (lineCount <= threshold) {
    lengthPenalty = 1.0;
  } else {
    const penalty = 1.0 - _LENGTH_PENALTY.penalty_per_line * (lineCount - threshold);
    lengthPenalty = Math.max(_LENGTH_PENALTY.minimum_penalty, penalty);
  }

  const fileScore = positionWeightedMean * lengthPenalty;

  function _fval(rule, factor) {
    const v = (rule.factors || {})[factor];
    return v ? v.value : undefined;
  }

  const prohibitionCount = rules.filter((r) => {
    const v = _fval(r, "F2");
    return v !== null && v !== undefined && v < 0.6;
  }).length;
  const prohibitionRatio = totalRules > 0 ? prohibitionCount / totalRules : 0.0;

  const f4Values = rules
    .map((r) => _fval(r, "F4"))
    .filter((v) => v !== null && v !== undefined);
  const triggerScopeCoherence = f4Values.length > 1 ? _stddev(f4Values) : 0.0;

  const concretenessCount = rules.filter((r) => {
    const v = _fval(r, "F7");
    return v !== null && v !== undefined && v >= 0.6;
  }).length;
  const concretenessCoverage = totalRules > 0 ? concretenessCount / totalRules : 0.0;

  let deadZoneCount = 0;
  for (const rule of rules) {
    const posPct = rule.line_start / Math.max(lineCount, 1);
    if (posPct > 0.2 && posPct < 0.8 && (rule.score || 0) > 0.7) {
      deadZoneCount += 1;
    }
  }

  return {
    file_score: round(fileScore, 3),
    length_penalty: round(lengthPenalty, 3),
    prohibition_ratio: round(prohibitionRatio, 3),
    trigger_scope_coherence: round(triggerScopeCoherence, 3),
    concreteness_coverage: round(concretenessCoverage, 3),
    dead_zone_count: deadZoneCount,
  };
}

function _getLoadProb(sourceFile, overrides) {
  const path_ = sourceFile.path || "";
  if (path_ in overrides) return overrides[path_];
  if (sourceFile.always_loaded ?? true) return _LOAD_PROB_DEFAULTS.always_loaded;
  return _LOAD_PROB_DEFAULTS.glob_scoped;
}

function computeCorpusScores(rules, sourceFiles, config) {
  const loadProbOverrides = config.load_prob_overrides || {};
  const severityOverrides = config.severity_overrides || {};

  const fileRules = {};
  for (const rule of rules) {
    const fi = rule.file_index || 0;
    if (!fileRules[fi]) fileRules[fi] = [];
    fileRules[fi].push(rule);
  }

  const fileScores = {};
  for (const [fi, fiRules] of Object.entries(fileRules)) {
    const sf = sourceFiles[fi] || {};
    fileScores[fi] = computePerFileScore(fiRules, sf);
  }

  const mandateRules = rules.filter((r) => r.category === "mandate");
  const nonMandateRules = rules.filter((r) => r.category !== "mandate");

  let effectiveNum = 0.0;
  let effectiveDen = 0.0;
  for (const [fi, metrics] of Object.entries(fileScores)) {
    const sf = sourceFiles[fi] || {};
    const sfPath = sf.path || "";
    const fiMandates = (fileRules[fi] || []).filter((r) => r.category === "mandate");
    if (!fiMandates.length) continue;
    const loadProb = _getLoadProb(sf, loadProbOverrides);
    const severity = severityOverrides[sfPath] ?? 1.0;
    effectiveNum += loadProb * severity * metrics.file_score;
    effectiveDen += loadProb * severity;
  }
  const effectiveScore = effectiveDen > 0 ? effectiveNum / effectiveDen : 0.0;

  let ruleNum = 0.0;
  let ruleDen = 0.0;
  for (const rule of mandateRules) {
    const fi = rule.file_index || 0;
    const sf = sourceFiles[fi] || {};
    const loadProb = _getLoadProb(sf, loadProbOverrides);
    const severity = severityOverrides[sf.path || ""] ?? 1.0;
    ruleNum += loadProb * severity * (rule.score || 0.0);
    ruleDen += loadProb * severity;
  }
  const ruleMean = ruleDen > 0 ? ruleNum / ruleDen : 0.0;

  const guidelineScores = nonMandateRules.map((r) => r.score || 0.0);
  const guidelineScore = guidelineScores.length
    ? guidelineScores.reduce((a, b) => a + b, 0) / guidelineScores.length
    : 0.0;

  const effectiveCorpus = {
    score: round(effectiveScore, 3),
    methodology: "file-score weighted aggregate over mandate-rule-bearing files",
  };
  const corpus = {
    rule_mean_score: round(ruleMean, 3),
    rule_count: mandateRules.length,
    note: "diagnostic: rule-average ignoring file length penalty",
  };
  const guideline = {
    score: round(guidelineScore, 3),
    rule_count: nonMandateRules.length,
  };

  return [effectiveCorpus, corpus, guideline, fileScores];
}

const _GRADE_THRESHOLDS = [
  [0.85, "A"],
  [0.75, "B"],
  [0.65, "C"],
  [0.50, "D"],
  [0.0, "F"],
];

function scoreToGrade(score) {
  for (const [threshold, letter] of _GRADE_THRESHOLDS) {
    if (score >= threshold) return letter;
  }
  return "F";
}

function main() {
  const payload = _lib.readStdinJson();
  if (payload === null) {
    process.stderr.write("FATAL: no input on stdin\n");
    process.exit(1);
  }

  let rules = payload.rules || [];
  const sourceFiles = payload.source_files || [];
  const projectRoot = payload.project_root || "";
  const config = payload.config || {};

  for (const rule of rules) {
    const result = computePerRuleScore(
      rule.factors || {},
      rule.staleness || {},
      rule.category || "mandate"
    );
    Object.assign(rule, result);
    rule.grade = scoreToGrade(result.score);

    const fi = rule.file_index || 0;
    const sf = sourceFiles[fi] || {};
    if (rule.category === "mandate") {
      const loadProb = _getLoadProb(sf, config.load_prob_overrides || {});
      const severity = (config.severity_overrides || {})[sf.path || ""] ?? 1.0;
      rule.leverage = round(loadProb * severity * (1.0 - rule.score), 3);
    } else {
      rule.leverage = null;
    }

    rule.stale = (rule.staleness || {}).gated || false;

    if (fi < sourceFiles.length) {
      rule.file = sourceFiles[fi].path;
      rule.loading = sourceFiles[fi].always_loaded ? "always-loaded" : "glob-scoped";
    }
  }

  enforceability.classifyRules(rules);

  const mandateRules = rules
    .filter((r) => r.category === "mandate")
    .sort((a, b) => (b.leverage || 0) - (a.leverage || 0));
  const nonMandateRules = rules.filter((r) => r.category !== "mandate");
  rules = mandateRules.concat(nonMandateRules);

  const [effectiveCorpus, corpus, guideline, fileScoreMap] = computeCorpusScores(
    rules, sourceFiles, config
  );

  const filesOutput = [];
  sourceFiles.forEach((sf, fi) => {
    const fiRules = rules.filter((r) => r.file_index === fi);
    const metrics = fileScoreMap[fi] || computePerFileScore(fiRules, sf);
    filesOutput.push({
      path: sf.path || "",
      file_score: metrics.file_score,
      grade: scoreToGrade(metrics.file_score),
      line_count: sf.line_count || 0,
      rule_count: fiRules.length,
      length_penalty: metrics.length_penalty,
      prohibition_ratio: metrics.prohibition_ratio,
      trigger_scope_coherence: metrics.trigger_scope_coherence,
      concreteness_coverage: metrics.concreteness_coverage,
      dead_zone_count: metrics.dead_zone_count,
    });
  });

  const positive = rules.filter((r) => (r.score || 0) > 0.80 && !r.degraded);

  const rewriteCandidates = mandateRules
    .slice(0, 3)
    .filter((r) => r.leverage && r.leverage > 0)
    .map((r) => ({
      rule_id: r.id,
      score: r.score,
      dominant_weakness: r.dominant_weakness,
    }));

  const corpusGrade = scoreToGrade(effectiveCorpus.score);

  const enforceabilityCounts = { enforceable: 0, observable: 0, folklore: 0 };
  for (const r of rules) {
    const cls = (r.enforceability || {}).class;
    if (cls in enforceabilityCounts) enforceabilityCounts[cls] += 1;
  }
  const folkloreFindings = buildFolkloreFindings(rules);

  const limits = [
    _lib.limitNote(
      "rule-extraction",
      `Scored ${rules.length} extracted rule(s) across ${sourceFiles.length} ` +
      "instruction file(s). Rules the extractor could not isolate (e.g. " +
      "prose paragraphs without an imperative) are not scored.",
      "An instruction buried in prose may carry weight Claude " +
      "feels but this audit never saw."
    ),
    _lib.limitNote(
      "enforceability",
      "Classified every rule by how a violation could be detected: " +
      `${enforceabilityCounts.enforceable} enforceable, ` +
      `${enforceabilityCounts.observable} observable, ` +
      `${enforceabilityCounts.folklore} folklore. Conservative — an ` +
      "ambiguous rule is classed observable, never folklore.",
      "A rule classed observable may still be hard to " +
      "self-check in practice; the dimension only checks for a checkable " +
      "referent, not whether the check is easy."
    ),
  ];

  const output = {
    schema_version: "0.1",
    project: projectRoot,
    date: new Date().toISOString().slice(0, 10),
    methodology: {
      weights_version: _WEIGHTS.version,
    },
    files_scanned: sourceFiles.length,
    rules_extracted: rules.length,
    limits,
    effective_corpus_quality: { ...effectiveCorpus, grade: corpusGrade },
    corpus_quality: corpus,
    guideline_quality: guideline,
    rules,
    files: filesOutput,
    positive_findings: positive.map((r) => ({
      file: r.file || "",
      line: r.line_start,
      text: (r.text || "").slice(0, 100),
      score: r.score,
    })),
    rewrite_candidates: rewriteCandidates,
    hook_opportunities: rules
      .filter((r) => r.is_hook_candidate)
      .map((r) => ({
        id: r.id,
        text: r.text || "",
        file: r.file || "",
        line_start: r.line_start || 0,
        f8_value: r.f8_value,
        suggested_enforcement: _suggestEnforcementLayer(r),
      })),
    conflicts: detectConflicts(rules),
    enforceability_counts: enforceabilityCounts,
    folklore_findings: folkloreFindings,
  };

  _lib.emit(output);
}

if (require.main === module) {
  main();
}

module.exports = {
  detectConflicts,
  buildFolkloreFindings,
  smoothFloor,
  computePerRuleScore,
  computePerFileScore,
  computeCorpusScores,
  scoreToGrade,
};
