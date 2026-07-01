"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const _lib = require("./_lib");

const _PATTERNS = _lib.loadData("placement_patterns");
const _CANDIDATE_THRESHOLD = _PATTERNS["candidate_threshold"];
const _COMPOUND_THRESHOLD = _PATTERNS["compound_threshold"];

function _compileFlags(flagsStr) {
  if (!flagsStr) return "";
  let result = "";
  if (flagsStr.includes("i")) result += "i";
  if (flagsStr.includes("m")) result += "m";
  if (flagsStr.includes("s")) result += "s";
  return result;
}

function _loadSignals(primitive) {
  const signals = [];
  for (const raw of _PATTERNS[primitive]["signals"]) {
    const criterion = raw["criterion"];
    const flags = _compileFlags(raw["flags"]);
    const sig = {
      name: raw["name"],
      weight: raw["weight"],
      criterion,
    };
    if (criterion === "regex") {
      sig.pattern = new RegExp(raw["pattern"], flags);
    } else if (criterion === "factor_threshold") {
      sig.factor = raw["factor"];
      sig.operator = raw["operator"];
      sig.threshold = raw["threshold"];
    } else if (criterion === "step_chain") {
      sig.step_patterns = raw["patterns"].map((p) => new RegExp(p, flags));
      sig.min_steps = raw["min_steps"];
    } else if (criterion === "pointer_shape") {
      sig.max_action_verbs = raw["max_action_verbs"];
    } else {
      throw new Error(`Unknown criterion type: ${criterion}`);
    }
    signals.push(sig);
  }
  return signals;
}

const _HOOK_SIGNALS = _loadSignals("hook");
const _SKILL_SIGNALS = _loadSignals("skill");
const _SUBAGENT_SIGNALS = _loadSignals("subagent");

const _SKILL_SUB_TYPE_RULES = _PATTERNS["skill"]["sub_type_rules"];
const _SUBAGENT_SUB_TYPE_RULES = _PATTERNS["subagent"]["sub_type_rules"];

const _COMPOUND_CONJUNCTION_PATTERN = new RegExp(
  _PATTERNS["compound"]["conjunction_pattern"],
  "i"
);
const _COMPOUND_COORDINATION_PATTERNS = _PATTERNS["compound"][
  "coordination_phrases_for_glue"
].map((p) => new RegExp(p, "i"));

const _ACTION_VERB_PATTERN =
  /\b(use|run|add|remove|create|update|delete|write|edit|never|always|must|should|do\s+not|don't|follow|check|verify|ensure|prefer|avoid|implement|refactor|rename|import|export|declare|return|throw|catch)\b/gi;

// ---------------------------------------------------------------------------
// Signal evaluators
// ---------------------------------------------------------------------------

function _evalRegex(signal, text) {
  return signal.pattern.test(text);
}

function _evalFactorThreshold(signal, factors) {
  const factor = (factors && factors[signal.factor]) || {};
  const val = factor.value;
  if (val === undefined || val === null) return false;
  const threshold = signal.threshold;
  if (threshold === undefined || threshold === null) return false;
  const op = signal.operator;
  if (op === "<") return val < threshold;
  if (op === "<=") return val <= threshold;
  if (op === ">") return val > threshold;
  if (op === ">=") return val >= threshold;
  if (op === "==") return val === threshold;
  return false;
}

function _evalStepChain(signal, text) {
  for (const pattern of signal.step_patterns || []) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function _evalPointerShape(signal, text) {
  const verbCount = (text.match(_ACTION_VERB_PATTERN) || []).length;
  const maxVerbs = signal.max_action_verbs ?? 1;
  return verbCount <= maxVerbs;
}

function _evalSignal(signal, text, factors) {
  const criterion = signal.criterion;
  if (criterion === "regex") return _evalRegex(signal, text);
  if (criterion === "factor_threshold") return _evalFactorThreshold(signal, factors);
  if (criterion === "step_chain") return _evalStepChain(signal, text);
  if (criterion === "pointer_shape") return _evalPointerShape(signal, text);
  return false;
}

// ---------------------------------------------------------------------------
// Primitive detectors
// ---------------------------------------------------------------------------

function _scorePrimitive(signals, text, factors) {
  let total = 0.0;
  const evidence = [];
  for (const signal of signals) {
    if (_evalSignal(signal, text, factors)) {
      total += signal.weight;
      evidence.push(signal.name);
    }
  }
  return [Math.min(total, 1.0), evidence];
}

function _pickSubType(evidence, rules) {
  const evidenceSet = new Set(evidence);
  for (const rule of rules) {
    if ("requires_all_groups" in rule) {
      const groups = rule["requires_all_groups"];
      if (groups.every((group) => group.some((s) => evidenceSet.has(s)))) {
        return rule["name"];
      }
    }
  }
  let best = null;
  for (const rule of rules) {
    if (!("requires_any" in rule)) continue;
    const anyHits = rule["requires_any"].filter((s) => evidenceSet.has(s));
    if (anyHits.length === 0) continue;
    const excluded = rule["exclude"] || [];
    if (excluded.some((s) => evidenceSet.has(s))) continue;
    if (best === null || anyHits.length > best[1]) {
      best = [rule["name"], anyHits.length];
    }
  }
  return best ? best[0] : null;
}

function _skillSubType(evidence) {
  return _pickSubType(evidence, _SKILL_SUB_TYPE_RULES);
}

function _subagentSubType(evidence) {
  return _pickSubType(evidence, _SUBAGENT_SUB_TYPE_RULES);
}

function _hookSubType(text, confidence, evidence) {
  if (evidence.includes("lifecycle-trigger-keyword")) return "lifecycle-event";
  if (
    confidence >= 0.7 &&
    (evidence.includes("mechanical-verb") || evidence.includes("tool-invocation-match"))
  ) {
    return "deterministic-gate";
  }
  if (confidence >= _CANDIDATE_THRESHOLD) return "deterministic-gate";
  return null;
}

// ---------------------------------------------------------------------------
// Compound detection
// ---------------------------------------------------------------------------

function _hasConjunction(text) {
  return _COMPOUND_CONJUNCTION_PATTERN.test(text);
}

function _impliesCoordination(text) {
  return _COMPOUND_COORDINATION_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Top-level detection
// ---------------------------------------------------------------------------

function detectPlacement(rule) {
  const text = rule.text || "";
  const factors = rule.factors || {};

  const [hookConf, hookEvidence] = _scorePrimitive(_HOOK_SIGNALS, text, factors);
  const [skillConf, skillEvidence] = _scorePrimitive(_SKILL_SIGNALS, text, factors);
  const [subConf, subEvidence] = _scorePrimitive(_SUBAGENT_SIGNALS, text, factors);

  const allScores = [
    ["hook", hookConf, hookEvidence, () => _hookSubType(text, hookConf, hookEvidence)],
    ["skill", skillConf, skillEvidence, () => _skillSubType(skillEvidence)],
    ["subagent", subConf, subEvidence, () => _subagentSubType(subEvidence)],
  ];

  const detections = [];
  for (const [primitive, conf, evidence, subTypeFn] of allScores) {
    if (conf >= _CANDIDATE_THRESHOLD) {
      detections.push({
        primitive,
        confidence: _round3(conf),
        evidence,
        sub_type: subTypeFn(),
      });
    }
  }

  const aboveCompoundBar = allScores.filter(([, conf]) => conf >= _COMPOUND_THRESHOLD);
  const isCompound = aboveCompoundBar.length >= 2 && _hasConjunction(text);
  const needsGlue = isCompound && _impliesCoordination(text);

  let bestFit;
  if (isCompound) {
    bestFit = "compound";
  } else if (detections.length) {
    bestFit = detections.reduce((a, b) => (b.confidence > a.confidence ? b : a)).primitive;
  } else {
    bestFit = null;
  }

  return {
    rule_id: rule.id ?? null,
    rule_text: text,
    file: rule.file || "",
    line_start: rule.line_start ?? null,
    line_end: rule.line_end ?? null,
    detections,
    scores: {
      hook: _round3(hookConf),
      skill: _round3(skillConf),
      subagent: _round3(subConf),
    },
    compound: isCompound,
    compound_needs_glue: needsGlue,
    best_fit: bestFit,
  };
}

function _round3(n) {
  return Math.round(n * 1000) / 1000;
}

function analyzeCorpus(audit) {
  const rules = audit.rules || [];
  let candidates = rules.map(detectPlacement);
  candidates = candidates.filter((c) => c.detections.length);

  const summary = {
    total_candidates: candidates.length,
    hook_candidates: candidates.filter((c) => c.best_fit === "hook").length,
    skill_candidates: candidates.filter((c) => c.best_fit === "skill").length,
    subagent_candidates: candidates.filter((c) => c.best_fit === "subagent").length,
    compound_candidates: candidates.filter((c) => c.best_fit === "compound").length,
  };

  return {
    schema_version: "0.1",
    project: audit.project || "",
    audit_grade: _formatGrade(audit),
    candidates,
    summary,
  };
}

function _formatGrade(audit) {
  const ecq = audit.effective_corpus_quality || {};
  const score = ecq.score;
  if (score === undefined || score === null) return "unknown";
  let letter;
  if (score >= 0.8) letter = "A";
  else if (score >= 0.65) letter = "B";
  else if (score >= 0.5) letter = "C";
  else if (score >= 0.35) letter = "D";
  else letter = "F";
  return `${letter} (${score.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Source-file surgery — atomic deletion of promoted rules.
// ---------------------------------------------------------------------------

class SourceDriftError extends Error {}

function planDeletions(moves, projectRoot) {
  const byFile = new Map();
  for (const m of moves) {
    const p = path.resolve(projectRoot, m.file);
    if (!byFile.has(p)) byFile.set(p, []);
    byFile.get(p).push(m);
  }

  const newContents = new Map();
  for (const [p, fileMoves] of byFile) {
    newContents.set(p, _deleteRangesFromFile(p, fileMoves));
  }
  return newContents;
}

function _readLines(content) {
  // Python readlines() keeps line terminators; split-and-restore \n here.
  const lines = content.split(/(?<=\n)/);
  return lines;
}

function _deleteRangesFromFile(p, moves) {
  if (!fs.existsSync(p)) {
    throw new SourceDriftError(`Source file not found: ${p}`);
  }

  let lines = _readLines(fs.readFileSync(p, "utf-8"));

  for (const m of moves) {
    const lineStart = m.line_start;
    const lineEnd = m.line_end;
    if (lineStart === null || lineStart === undefined || lineEnd === null || lineEnd === undefined) {
      throw new SourceDriftError(`Move for ${p} has null line_start/line_end`);
    }
    if (lineStart < 1 || lineEnd > lines.length) {
      throw new SourceDriftError(
        `Move for ${p} out of bounds: lines ${lineStart}..${lineEnd} (file has ${lines.length} lines)`
      );
    }
    const span = lines.slice(lineStart - 1, lineEnd).join("");
    if (!_ruleTextMatches(m.rule_text || "", span)) {
      throw new SourceDriftError(
        `Source file drift at ${p}:${lineStart}..${lineEnd}. ` +
          `Expected rule text does not match current content. Re-audit.`
      );
    }
  }

  const sortedMoves = [...moves].sort((a, b) => b.line_start - a.line_start);
  for (const m of sortedMoves) {
    const startIdx = m.line_start - 1;
    const endIdx = m.line_end;
    lines = _deleteWithBlankLineCleanup(lines, startIdx, endIdx);
  }

  return lines.join("");
}

function _ruleTextMatches(expected, span) {
  const normalize = (s) =>
    s
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();

  const normExpected = normalize(expected);
  const normSpan = normalize(span);
  return normSpan.includes(normExpected) || normExpected.includes(normSpan);
}

function _deleteWithBlankLineCleanup(lines, startIdx, endIdx) {
  const before = lines.slice(0, startIdx);
  let after = lines.slice(endIdx);

  const isBlank = (line) => line.trim() === "";

  if (before.length && after.length && isBlank(before[before.length - 1]) && isBlank(after[0])) {
    after = after.slice(1);
  }

  return before.concat(after);
}

// ---------------------------------------------------------------------------
// PROMOTIONS.md assembly
// ---------------------------------------------------------------------------

const _PRIMITIVE_DEFINITIONS = {
  hook:
    "Hooks are shell commands, HTTP endpoints, or prompts that fire " +
    "automatically at Claude Code lifecycle events (`PreToolUse`, " +
    "`PostToolUse`, `UserPromptSubmit`, `Stop`, and others). They run " +
    "outside the model's context, cannot be rationalized around, and can " +
    "short-circuit the agent loop. Use hooks for deterministic gates you " +
    "want mechanically unavoidable.",
  skill:
    "Skills are reusable instructions Claude loads on demand. " +
    "**Reference skills** hold knowledge Claude consults during a task " +
    "(API style guides, vocabulary). **Action skills** run a workflow " +
    "you invoke with `/<name>` (e.g. `/deploy`). They don't burn context " +
    "when irrelevant.",
  subagent:
    "Subagents are isolated workers that run with their own context and " +
    "return only a summary. Use them for tasks that read many files, " +
    "involve noisy intermediate work, or benefit from bias independence " +
    "(a fresh context unmotivated by the caller's assumptions).",
  compound:
    "A compound candidate is a rule whose verb chain mixes enforceability " +
    "classes — one half is a deterministic gate (→ hook), the other is a " +
    "judgment call (→ subagent), and a small skill may act as connective " +
    "tissue that invokes both at the right moment. The mapping principle: " +
    "**hooks** for deterministic gates you want mechanically unavoidable, " +
    "**skills** for context-triggered procedural guidance the main agent " +
    "follows, **subagents** for delimited tasks needing isolated reasoning " +
    "or bias independence. If you find yourself encoding a judgment call " +
    "in a hook or a mechanical check in a skill, you've misallocated.",
};

const _PRIMITIVE_DOCS_LINKS = {
  hook: [
    ["Hooks overview", "https://code.claude.com/docs/en/features-overview#hooks"],
    ["Hooks in the agent loop", "https://code.claude.com/docs/en/agent-sdk/agent-loop#hooks"],
    ["Hooks reference", "https://code.claude.com/docs/en/hooks#hooks-reference"],
  ],
  skill: [
    ["Skills overview", "https://code.claude.com/docs/en/features-overview#skills"],
    ["Skills in Claude Code", "https://code.claude.com/docs/en/agent-sdk/claude-code-features#skills"],
    ["Skills reference", "https://code.claude.com/docs/en/plugins-reference#skills"],
  ],
  subagent: [
    ["Subagents overview", "https://code.claude.com/docs/en/features-overview#subagents"],
    ["Create custom subagents", "https://code.claude.com/docs/en/sub-agents#create-custom-subagents"],
    ["Use subagents for investigation", "https://code.claude.com/docs/en/best-practices#use-subagents-for-investigation"],
  ],
  compound: [["Claude Code features overview", "https://code.claude.com/docs/en/features-overview"]],
};

const _PRIMITIVE_HEADINGS = {
  hook: "Hooks",
  skill: "Skills",
  subagent: "Subagents",
  compound: "Compound candidates (rules that split across primitives)",
};

const _PRIMITIVE_ORDER = ["hook", "skill", "subagent", "compound"];

function assemblePromotionsDoc(movesByPrimitive, project, auditGrade, generatedAt, existingContent) {
  const existingKeys = existingContent ? _extractExistingEntryKeys(existingContent) : new Set();

  const lines = [];
  if (existingContent === null || existingContent === undefined) {
    lines.push(_renderBanner(project, auditGrade, generatedAt));
  } else {
    lines.push(existingContent.replace(/\s+$/, ""));
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## Appended ${generatedAt}`);
    lines.push("");
    lines.push(`> Audit grade at append time: \`${auditGrade}\``);
    lines.push("");
  }

  for (const primitive of _PRIMITIVE_ORDER) {
    const entries = movesByPrimitive[primitive] || [];
    const newEntries = entries.filter((e) => !existingKeys.has(_entryKeyStr(e)));
    if (!newEntries.length) continue;
    lines.push("---");
    lines.push("");
    lines.push(`## ${_PRIMITIVE_HEADINGS[primitive]}`);
    lines.push("");
    lines.push(_PRIMITIVE_DEFINITIONS[primitive]);
    lines.push("");
    lines.push("**Learn more:**");
    for (const [label, url] of _PRIMITIVE_DOCS_LINKS[primitive]) {
      lines.push(`- [${label}](${url})`);
    }
    lines.push("");
    lines.push("**Candidates from your rules:**");
    lines.push("");
    for (const entry of newEntries) {
      lines.push(..._renderEntry(entry, primitive));
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

function _renderBanner(project, auditGrade, generatedAt) {
  return (
    "# Hestia promotion candidates\n" +
    "\n" +
    "> ⚠️ **These items are documented, not enforced.** They were flagged " +
    "as better-fit for a Claude Code primitive other than a rule. Hestia " +
    "does not re-read this file on subsequent audits — nothing here affects " +
    "your grade. Promote each item to the recommended primitive when you " +
    "have time, and delete it from this file when you do.\n" +
    ">\n" +
    `> **Generated:** ${generatedAt} · **Project:** ${project} · ` +
    `**From audit:** \`${auditGrade}\`\n`
  );
}

function _renderEntry(entry, primitive) {
  const location = `\`${entry.file}:${entry.line_start}\``;
  const lines = [`### ${location}`];
  const ruleText = _stripBulletMarker((entry.rule_text || "").replace(/\s+$/, ""));
  if (ruleText) {
    lines.push("");
    lines.push(`> ${ruleText}`);
  }
  lines.push("");
  if (primitive === "compound") {
    const compound = entry.compound || {};
    const splitHint = compound.split_hint || "";
    if (splitHint) lines.push(`- **Why split**: ${splitHint}`);
    for (const partKey of ["part_a", "part_b"]) {
      const part = compound[partKey] || {};
      if (!part || Object.keys(part).length === 0) continue;
      lines.push(..._renderPart(part, _titleCase(partKey.replace("_", " "))));
    }
    const glue = compound.glue;
    if (glue) lines.push(..._renderPart(glue, "Optional glue"));
  } else {
    const judgment = entry.judgment || {};
    if (judgment.why) lines.push(`- **Why a ${primitive}**: ${judgment.why}`);
    if (judgment.suggested_shape) lines.push(`- **Suggested shape**: ${judgment.suggested_shape}`);
    if (judgment.next_step) lines.push(`- **Next step**: ${judgment.next_step}`);
    if (judgment.tradeoff) lines.push(`- **Trade-off**: ${judgment.tradeoff}`);
  }
  return lines;
}

function _titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

const _BULLET_MARKER_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/;

function _stripBulletMarker(text) {
  return text.replace(_BULLET_MARKER_PATTERN, "");
}

function _renderPart(part, label) {
  const primitive = _titleCase(part.primitive || "");
  const text = part.text || "";
  const shape = part.suggested_shape || "";
  const nextStep = part.next_step || "";
  const tradeoff = part.tradeoff;
  const out = [`- **${label}** → **${primitive}**: "${text}"`];
  if (shape) out.push(`  - **Suggested shape**: ${shape}`);
  if (nextStep) out.push(`  - **Next step**: ${nextStep}`);
  if (tradeoff) out.push(`  - **Trade-off**: ${tradeoff}`);
  return out;
}

function _entryKeyStr(entry) {
  return JSON.stringify([entry.file ?? null, _stripBulletMarker(entry.rule_text || "").slice(0, 60)]);
}

const _ENTRY_HEADER_NEW_PATTERN = /^###\s+`([^`]+):(\d+)`\s*$/;
const _ENTRY_HEADER_LEGACY_PATTERN = /^###\s+`([^`]+):(\d+)`\s+—\s+"(.+)"\s*$/;
const _BLOCKQUOTE_LINE_PATTERN = /^>\s+(.+)$/;

function _extractExistingEntryKeys(content) {
  const keys = new Set();
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const legacy = line.match(_ENTRY_HEADER_LEGACY_PATTERN);
    if (legacy) {
      const [, filePath, , text] = legacy;
      keys.add(JSON.stringify([filePath, _stripBulletMarker(text).slice(0, 60)]));
      i += 1;
      continue;
    }
    const newHeader = line.match(_ENTRY_HEADER_NEW_PATTERN);
    if (newHeader) {
      const [, filePath] = newHeader;
      let ruleText = "";
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const bq = lines[j].match(_BLOCKQUOTE_LINE_PATTERN);
        if (bq) {
          ruleText = bq[1];
          break;
        }
      }
      keys.add(JSON.stringify([filePath, _stripBulletMarker(ruleText).slice(0, 60)]));
      i += 1;
      continue;
    }
    i += 1;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// write_promotions orchestration (atomic)
// ---------------------------------------------------------------------------

function _collectJudgmentWarnings(moves) {
  const warnings = [];
  const requiredFields = ["why", "suggested_shape", "next_step"];
  for (const move of moves) {
    const ruleId = move.rule_id ?? "<unknown>";
    const primitive = move.primitive || "";
    if (primitive === "compound") {
      const compound = move.compound || {};
      if (!compound.part_a || !compound.part_b) {
        warnings.push(
          `${ruleId}: compound move is missing part_a or part_b; ` +
            "PROMOTIONS.md entry will be header-only"
        );
      }
      continue;
    }
    const judgment = move.judgment || {};
    const missing = requiredFields.filter((f) => !judgment[f]);
    if (missing.length) {
      warnings.push(
        `${ruleId}: move has no ${missing.join("/")} in judgment; ` +
          "PROMOTIONS.md entry will be header-only. Generate the judgment " +
          "strings per skills/audit/references/promotion-guide.md before " +
          "writing."
      );
    }
  }
  return warnings;
}

function writePromotions(payload, projectRoot) {
  const moves = payload.moves || [];
  if (!moves.length) {
    return {
      schema_version: "0.1",
      promotions_file: ".hestia/PROMOTIONS.md",
      entries_written: 0,
      files_modified: [],
      rules_removed: 0,
      status: "ok",
    };
  }

  const judgmentWarnings = _collectJudgmentWarnings(moves);

  const project = payload.project || "";
  const auditGrade = payload.audit_grade || "unknown";
  const generatedAt =
    payload.generated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const movesByPrimitive = {};
  for (const m of moves) {
    const primitive = m.primitive || "hook";
    if (!movesByPrimitive[primitive]) movesByPrimitive[primitive] = [];
    movesByPrimitive[primitive].push(m);
  }

  let newSourceContents;
  try {
    newSourceContents = planDeletions(moves, projectRoot);
  } catch (e) {
    if (e instanceof SourceDriftError) {
      return {
        schema_version: "0.1",
        status: "failed",
        reason: `source_file_drift: ${e.message}`,
        promotions_file: ".hestia/PROMOTIONS.md",
        entries_written: 0,
        files_modified: [],
        rules_removed: 0,
      };
    }
    throw e;
  }

  const promotionsPath = path.join(projectRoot, ".hestia", "PROMOTIONS.md");
  let existingContent = null;
  if (fs.existsSync(promotionsPath)) {
    existingContent = fs.readFileSync(promotionsPath, "utf-8");
  }
  const newDoc = assemblePromotionsDoc(
    movesByPrimitive,
    project,
    auditGrade,
    generatedAt,
    existingContent
  );

  const written = [];
  try {
    fs.mkdirSync(path.dirname(promotionsPath), { recursive: true });
    _atomicWrite(promotionsPath, newDoc);
    written.push(".hestia/PROMOTIONS.md");

    for (const [p, content] of newSourceContents) {
      _atomicWrite(p, content);
      const rel = path.relative(projectRoot, p);
      const relPath = rel.startsWith("..") ? p : rel;
      written.push(relPath.split(path.sep).join("/"));
    }
  } catch (e) {
    return {
      schema_version: "0.1",
      status: "failed",
      reason: `write_error: ${e.message}`,
      promotions_file: ".hestia/PROMOTIONS.md",
      entries_written: 0,
      files_modified: written,
      rules_removed: 0,
    };
  }

  for (const w of judgmentWarnings) {
    process.stderr.write(`WARNING: ${w}\n`);
  }

  const result = {
    schema_version: "0.1",
    promotions_file: ".hestia/PROMOTIONS.md",
    entries_written: moves.length,
    files_modified: written.filter((p) => p !== ".hestia/PROMOTIONS.md"),
    rules_removed: moves.length,
    status: "ok",
  };
  if (judgmentWarnings.length) result.warnings = judgmentWarnings;
  return result;
}

function _atomicWrite(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpPath = path.join(
    path.dirname(p),
    `${path.basename(p)}.hestia-tmp-${crypto.randomBytes(8).toString("hex")}`
  );
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, p);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    process.stderr.write(
      "usage: placement.js [--prepare-placement <audit.json> | --write-promotions <project_root>]\n"
    );
    process.exit(2);
  }

  const mode = argv[0];

  if (mode === "--prepare-placement") {
    if (argv.length < 2) {
      process.stderr.write("usage: placement.js --prepare-placement <audit.json>\n");
      process.exit(2);
    }
    const auditPath = argv[1];
    const audit = _lib.readJson(auditPath);
    const result = analyzeCorpus(audit);
    _lib.emit(result);
  } else if (mode === "--write-promotions") {
    if (argv.length < 2) {
      process.stderr.write("usage: placement.js --write-promotions <project_root>\n");
      process.exit(2);
    }
    const projectRoot = path.resolve(argv[1]);
    const payload = _lib.readStdinJson();
    const result = writePromotions(payload || {}, projectRoot);
    _lib.emit(result);
    if (result.status !== "ok") process.exit(1);
  } else {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  detectPlacement,
  analyzeCorpus,
  planDeletions,
  assemblePromotionsDoc,
  writePromotions,
  SourceDriftError,
};
