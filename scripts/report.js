"use strict";

const _lib = require("./_lib");

const _FRIENDLY_PROBLEMS = {
  F1: "Weak verb — Claude isn't sure if this is a command or a suggestion",
  F2: "Phrased as a prohibition — positive instructions stick better",
  F3: "Unclear when this applies — Claude won't remember it at the right moment",
  F4: "Loaded in the wrong context — Claude won't see this rule when it matters",
  F7: "Too vague — Claude needs specific examples to follow this",
};

const _FRIENDLY_FIXES = {
  F1: "Start with a clear action verb: Use, Always, Never, Run",
  F2: "Flip from 'don't do X' to 'do Y instead'",
  F3: "Add a trigger: 'When editing X...' or 'Before committing...'",
  F4: "Move to a scoped rule file with paths: frontmatter, or broaden the language",
  F7: "Add a file path, code example, or before/after comparison",
};

const _FAILURE_CLASS_LABELS = {
  drift: "drift (rule may not fire at the right moment)",
  ambiguity: "ambiguity (rule reads multiple ways)",
  conflict: "conflict (rule contradicts another rule)",
};

const _FRIENDLY_STRENGTHS = {
  F1: "Strong action verb",
  F2: "Clear positive framing",
  F3: "Specific trigger context",
  F4: "Well-scoped to the right files",
  F7: "Concrete examples or file paths",
};

function _letterGrade(score) {
  if (score >= 0.8) return "A";
  if (score >= 0.65) return "B";
  if (score >= 0.5) return "C";
  if (score >= 0.35) return "D";
  return "F";
}

function _mostFrequentDominantWeakness(rules) {
  const counts = {};
  for (const r of rules) {
    if (r.category !== "mandate") continue;
    const dw = r.dominant_weakness;
    if (dw) counts[dw] = (counts[dw] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return entries.reduce((best, kv) => (kv[1] > best[1] ? kv : best))[0];
}

function _failureClassCounts(rules) {
  const counts = {};
  for (const r of rules) {
    if (r.category !== "mandate") continue;
    const fc = r.failure_class;
    if (fc) counts[fc] = (counts[fc] || 0) + 1;
  }
  return counts;
}

function _renderFailureClassSummary(lines, rules) {
  const counts = _failureClassCounts(rules);
  if (Object.keys(counts).length === 0) return;
  const order = ["drift", "ambiguity", "conflict"];
  const parts = [];
  for (const cls of order) {
    const n = counts[cls] || 0;
    if (n > 0) parts.push(`${n} ${cls}`);
  }
  if (parts.length) lines.push(`**At-risk rules:** ${parts.join(", ")}.\n`);
}

function renderMarkdown(audit, verbose = false) {
  const lines = [];
  const rules = audit.rules || [];

  _renderGradeHeadline(lines, audit);
  _renderFixGroups(lines, rules);
  _renderBestRules(lines, audit);
  _renderPotentialConflicts(lines, audit);
  _renderHookOpportunities(lines, audit);
  _renderFolklore(lines, audit);

  const fixRewrites = audit.rewrites || [];
  if (fixRewrites.length) _renderRewrites(lines, fixRewrites);

  if (verbose) _renderVerboseSection(lines, audit);

  _renderLimits(lines, audit);

  _hr(lines);
  lines.push(
    "*This report measures how clearly Claude can parse and apply your rules. " +
      "Actual compliance depends on factors beyond rule text — this audit optimizes " +
      "the structural part authors control. Counts above are observed tallies, not " +
      "before/after impact estimates.*"
  );

  return lines.join("\n");
}

function _hr(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s === "---") return;
    break;
  }
  lines.push("---\n");
}

function _renderLimits(lines, audit) {
  _hr(lines);
  lines.push("## Limits — what this run could not check\n");

  const notes = audit.limits || [];
  for (const note of notes) {
    const detail = note.detail || "";
    if (!detail) continue;
    lines.push(`- ${detail}`);
    const rr = note.residual_risk;
    if (rr) lines.push(`  - Residual risk: ${rr}`);
  }

  lines.push("- Scoring is English-only; non-English rules get inaccurate scores.");
  lines.push(
    "- Structural clarity only — this does NOT predict whether Claude will " +
      "actually comply, nor whether a rule is correct for your project."
  );

  const conflicts = audit.conflicts || [];
  if (conflicts.length) {
    const n = conflicts.length;
    const pairWord = n === 1 ? "pair" : "pairs";
    lines.push(
      `- Conflict scan flagged ${n} candidate ${pairWord} (vocabulary ` +
        "overlap) — confirm each by reading the rules; some are false positives."
    );
  } else {
    lines.push(
      "- No potential conflicts surfaced. (A clean conflict scan is not a " +
        "proof of consistency — it only checks shared concrete markers.)"
    );
  }

  const degraded = (audit.rules || []).filter(
    (r) => r.category === "mandate" && r.degraded
  ).length;
  if (degraded) {
    const noun = degraded === 1 ? "rule was" : "rules were";
    lines.push(
      `- ${degraded} ${noun} scored on fewer than all factors; missing ` +
        "factors were excluded, not defaulted."
    );
  } else {
    lines.push("- All scored rules had every factor available — no degraded scores.");
  }

  lines.push("");
}

function _renderGradeHeadline(lines, audit) {
  const rules = audit.rules || [];
  const mandateRules = rules.filter((r) => r.category === "mandate");
  const ecq = audit.effective_corpus_quality || {};
  const ecqScore = ecq.score || 0;
  const ecqGrade = _letterGrade(ecqScore);
  const total = mandateRules.length;
  const good = mandateRules.filter((r) => (r.score || 0) >= 0.65).length;
  const needWork = total - good;

  lines.push("# Hestia Rules Audit\n");

  if (needWork === 0 && total > 0) {
    lines.push(
      `**Grade: ${ecqGrade}** — all ${total} rules are clear enough ` +
        "for Claude to follow well.\n"
    );
  } else if (total > 0) {
    lines.push(
      `**Grade: ${ecqGrade}** — ${good} of your ${total} rules are clear enough ` +
        `for Claude to follow well. The other ${needWork} need work.\n`
    );
  } else {
    lines.push(`**Grade: ${ecqGrade}** — no mandate rules found.\n`);
  }

  if (needWork > 0) {
    const corpusDw = _mostFrequentDominantWeakness(rules);
    if (corpusDw) {
      const friendly = _FRIENDLY_PROBLEMS[corpusDw] || corpusDw;
      lines.push(`**Biggest issue:** ${friendly}\n`);
    }
    _renderFailureClassSummary(lines, rules);
  }

  const conflicts = audit.conflicts || [];
  if (conflicts.length) {
    const n = conflicts.length;
    const pairWord = n === 1 ? "pair" : "pairs";
    lines.push(`**Potential conflicts:** ${n} rule ${pairWord} — see section below.\n`);
  }

  const degradedCount = mandateRules.filter((r) => r.degraded || false).length;
  if (degradedCount) {
    const noun = degradedCount === 1 ? "rule was" : "rules were";
    lines.push(
      `**Note:** ${degradedCount} ${noun} scored on fewer than all factors ` +
        "(some factors were not scorable). These rules are marked in the detailed view; " +
        "run with `--verbose` to see which factors were missing.\n"
    );
  }

  lines.push("---\n");
}

function _renderFixGroups(lines, rules) {
  const mandate = rules.filter((r) => r.category === "mandate");
  const weak = mandate.filter((r) => (r.score || 0) < 0.5);

  if (!weak.length) return;

  lines.push("## What to fix first\n");

  const groups = {};
  const noDw = [];
  for (const r of weak) {
    const dw = r.dominant_weakness;
    if (dw) {
      (groups[dw] = groups[dw] || []).push(r);
    } else {
      noDw.push(r);
    }
  }

  const sortedGroups = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  let groupNum = 0;
  const others = [...noDw];

  for (const [dw, groupRules] of sortedGroups) {
    if (groupRules.length < 2) {
      others.push(...groupRules);
      continue;
    }
    groupNum += 1;
    const friendlyProblem = _FRIENDLY_PROBLEMS[dw] || dw;
    const friendlyFix = _FRIENDLY_FIXES[dw] || "Review and improve";
    const shortProblem = friendlyProblem.includes(" — ")
      ? friendlyProblem.split(" — ")[0]
      : friendlyProblem;

    lines.push(`### ${groupNum}. ${shortProblem} (~${groupRules.length} rules)\n`);
    lines.push("| Rule | File | Problem |");
    lines.push("|------|------|---------|");
    for (const r of groupRules.slice(0, 8)) {
      let text = (r.text || "").slice(0, 80);
      if ((r.text || "").length > 80) text += "...";
      const fileLoc = `${r.file || "?"}:${r.line_start !== undefined ? r.line_start : "?"}`;
      lines.push(`| "${text}" | ${fileLoc} | ${shortProblem} |`);
    }
    if (groupRules.length > 8) {
      lines.push(`| ...and ${groupRules.length - 8} more | | |`);
    }
    lines.push(`\n**How to fix:** ${friendlyFix}\n`);
  }

  if (others.length) {
    groupNum += 1;
    lines.push(`### ${groupNum}. Other issues (${others.length} rules)\n`);
    lines.push("| Rule | File | Issue |");
    lines.push("|------|------|-------|");
    for (const r of others) {
      let text = (r.text || "").slice(0, 80);
      if ((r.text || "").length > 80) text += "...";
      const fileLoc = `${r.file || "?"}:${r.line_start !== undefined ? r.line_start : "?"}`;
      const dw = r.dominant_weakness || "";
      const issue = dw
        ? (_FRIENDLY_PROBLEMS[dw] || "Review").split(" — ")[0]
        : "Review";
      lines.push(`| "${text}" | ${fileLoc} | ${issue} |`);
    }
    lines.push("");
  }
}

function _renderBestRules(lines, audit) {
  const positives = audit.positive_findings || [];
  const rules = audit.rules || [];

  if (!positives.length) return;

  lines.push("## Your best rules (use these as templates)\n");
  lines.push(
    "These rules score A because they have clear verbs, concrete examples, " +
      "and specific triggers. Copy their structure when rewriting weak rules.\n"
  );
  lines.push("| Grade | Rule | Why it works |");
  lines.push("|-------|------|--------------|");

  for (const p of positives.slice(0, 5)) {
    let text = (p.text || "").slice(0, 80);
    if ((p.text || "").length > 80) text += "...";
    const score = p.score || 0;
    const grade = _letterGrade(score);
    const prefix = (p.text || "").slice(0, 30);
    const fullRule = rules.find((r) => (r.text || "").startsWith(prefix));
    const why = fullRule ? _bestStrength(fullRule) : "Well-structured rule";
    lines.push(`| ${grade} | "${text}" | ${why} |`);
  }

  lines.push("");
  lines.push("---\n");
}

function _renderPotentialConflicts(lines, audit) {
  const conflicts = audit.conflicts || [];
  if (!conflicts.length) return;

  const n = conflicts.length;
  const pairWord = n === 1 ? "pair" : "pairs";
  lines.push("## Potential conflicts\n");
  lines.push(
    `Found ${n} rule ${pairWord} where one rule prohibits something ` +
      "and another prescribes an action involving the same concrete " +
      "thing (file path, API, domain term). Review each pair — it may " +
      "be a real contradiction (fix one of the rules), a legitimate " +
      "scoping difference (add precedence language to one), or a " +
      "false positive (different behaviors that happen to share " +
      "vocabulary).\n"
  );
  for (const c of conflicts.slice(0, 10)) {
    const ruleA = c.rule_a || {};
    const ruleB = c.rule_b || {};
    const shared = c.shared_markers || [];
    const sharedStr = shared.length ? shared.map((m) => `\`${m}\``).join(", ") : "—";
    const aLoc = `${ruleA.file || "?"}:${ruleA.line_start !== undefined ? ruleA.line_start : "?"}`;
    const bLoc = `${ruleB.file || "?"}:${ruleB.line_start !== undefined ? ruleB.line_start : "?"}`;
    const aText = ruleA.text || "";
    const bText = ruleB.text || "";
    lines.push(`- **Shared:** ${sharedStr}`);
    lines.push(`  - Prohibits (${aLoc}): "${aText}"`);
    lines.push(`  - Prescribes (${bLoc}): "${bText}"`);
  }
  if (n > 10) {
    lines.push(`\n...and ${n - 10} more.`);
  }
  lines.push("");
  lines.push("---\n");
}

function _renderHookOpportunities(lines, audit) {
  const hookOps = audit.hook_opportunities || [];
  if (!hookOps.length) return;

  lines.push("## Hook opportunities\n");
  lines.push(
    `These ${hookOps.length} rules would be more reliable enforced by a hook or linter ` +
      "than as text Claude reads. Text rules depend on Claude remembering and applying them; " +
      "hooks enforce deterministically. Your comprehension score above is unaffected — " +
      "this is a separate suggestion.\n"
  );
  lines.push("| Rule | File | Suggested enforcement |");
  lines.push("|------|------|----------------------|");
  for (const op of hookOps.slice(0, 10)) {
    let text = (op.text || "").slice(0, 80);
    if ((op.text || "").length > 80) text += "...";
    const fileLoc = `${op.file || "?"}:${op.line_start !== undefined ? op.line_start : "?"}`;
    const suggestion = op.suggested_enforcement || "Hook or linter";
    lines.push(`| "${text}" | ${fileLoc} | ${suggestion} |`);
  }
  if (hookOps.length > 10) {
    lines.push(`| ...and ${hookOps.length - 10} more | | |`);
  }
  lines.push("");
  lines.push("---\n");
}

function _renderFolklore(lines, audit) {
  const findings = audit.folklore_findings || [];
  if (!findings.length) return;

  const counts = audit.enforceability_counts || {};
  const n = findings.length;
  const ruleWord = n === 1 ? "rule hinges" : "rules hinge";
  lines.push("## Folklore rules (rewrite or delete)\n");
  lines.push(
    `${n} ${ruleWord} on unverifiable quality words with nothing a hook, ` +
      "linter, test, or Claude itself could check against. An unenforceable rule " +
      "trains Claude that the ruleset contains noise — which discounts the good " +
      "rules sitting next to it. Rewrite each to name a checkable condition " +
      "(a command, a threshold, or a concrete construct), or delete it.\n"
  );
  if (Object.keys(counts).length) {
    lines.push(
      `*Enforceability mix: ${counts.enforceable || 0} enforceable ` +
        `(a tool could catch a violation), ${counts.observable || 0} ` +
        `observable (Claude can self-check), ${counts.folklore || 0} ` +
        "folklore (below).*\n"
    );
  }
  lines.push("| Rule | File | Unverifiable word(s) |");
  lines.push("|------|------|----------------------|");
  for (const f of findings.slice(0, 10)) {
    let text = (f.text || "").slice(0, 80);
    if ((f.text || "").length > 80) text += "...";
    const loc = f.location || f.file || "?";
    const words = f.quality_words || [];
    const wordsStr = words.length ? words.map((w) => `\`${w}\``).join(", ") : "—";
    lines.push(`| "${text}" | ${loc} | ${wordsStr} |`);
  }
  if (n > 10) {
    lines.push(`| ...and ${n - 10} more | | |`);
  }
  lines.push("");
  const sample = findings[0];
  lines.push(`**Why it bites:** ${sample.why || ""}`);
  lines.push(`**How to fix:** ${sample.fix_action || ""}\n`);
  lines.push("---\n");
}

function _renderVerboseSection(lines, audit) {
  const rules = audit.rules || [];
  const mandateRules = rules.filter((r) => r.category === "mandate");
  const nonMandateRules = rules.filter((r) => r.category !== "mandate");

  lines.push("---\n");
  lines.push("## Detailed Scores (--verbose)\n");

  lines.push("| File | Rule (truncated) | Grade | Score | Dominant Weakness | Action |");
  lines.push("|------|-------------------|-------|-------|-------------------|--------|");

  let degradedCount = 0;
  for (const rule of mandateRules) {
    const fileLoc = `${rule.file || "?"}:${rule.line_start !== undefined ? rule.line_start : "?"}`;
    let text = (rule.text || "").slice(0, 100);
    if ((rule.text || "").length > 100) text += "...";
    const score = rule.score || 0;
    const grade = _letterGrade(score);
    const degraded = rule.degraded || false;
    if (degraded) degradedCount += 1;
    const scoreStr = degraded ? `${score.toFixed(2)}*` : score.toFixed(2);
    const dw = rule.dominant_weakness;
    const action = _suggestAction(rule);
    lines.push(`| ${fileLoc} | "${text}" | ${grade} | ${scoreStr} | ${dw || "—"} | ${action} |`);
  }

  if (nonMandateRules.length) {
    lines.push("");
    lines.push("**Guidelines (override + preference):**\n");
    for (const rule of nonMandateRules) {
      const fileLoc = `${rule.file || "?"}:${rule.line_start !== undefined ? rule.line_start : "?"}`;
      let text = (rule.text || "").slice(0, 100);
      if ((rule.text || "").length > 100) text += "...";
      const score = rule.score || 0;
      const grade = _letterGrade(score);
      lines.push(
        `| ${fileLoc} | "${text}" | ${grade} | ${score.toFixed(2)} | ` +
          `${rule.dominant_weakness || "—"} | — |`
      );
    }
  }

  lines.push("");
  if (degradedCount) {
    lines.push("*\\* scored on N/6 factors — missing factors excluded, not defaulted.*");
  }

  lines.push("\n### Per-rule breakdown\n");
  for (const rule of mandateRules) {
    _renderRuleDetail(lines, rule);
  }

  if (nonMandateRules.length) {
    lines.push("*(Guidelines not shown in detail — use --json for full data)*\n");
  }

  const files = audit.files || [];
  if (files.length) {
    lines.push("### Per-file Scores\n");
    lines.push(
      "| File | Mean Quality | Prohibition Ratio | Concreteness Coverage | Dead-zone Rules | Trigger Coherence |"
    );
    lines.push(
      "|------|-------------|-------------------|----------------------|-----------------|-------------------|"
    );
    for (const f of files) {
      lines.push(
        `| ${f.path || "?"} | ${(f.file_score || 0).toFixed(2)} | ` +
          `${(f.prohibition_ratio || 0).toFixed(2)} | ${(f.concreteness_coverage || 0).toFixed(2)} | ` +
          `${f.dead_zone_count || 0} | ${(f.trigger_scope_coherence || 0).toFixed(2)} |`
      );
    }
    lines.push("");
  }
}

function _bestStrength(rule) {
  const factors = rule.factors || {};
  let bestFn = null;
  let bestVal = -1.0;
  for (const fn of ["F1", "F2", "F3", "F4", "F7"]) {
    const fdata = factors[fn] || {};
    const val = fdata.value;
    if (val !== null && val !== undefined && val > bestVal) {
      bestVal = val;
      bestFn = fn;
    }
  }
  if (bestFn) {
    return _FRIENDLY_STRENGTHS[bestFn] || "Well-structured rule";
  }
  return "Well-structured rule";
}

function _renderRewrites(lines, rewrites) {
  lines.push("---\n");
  lines.push("## Suggested Rewrites\n");
  lines.push("LLM-generated rewrite suggestions for rules below their category floor. ");
  lines.push(
    "Before/after grades are computed by re-running the scoring pipeline on the rewrite "
  );
  lines.push("(not projected). Review each suggestion; `--fix` suggests, you apply.\n");

  for (const rw of rewrites) {
    const ruleId = rw.rule_id || "?";
    const fileLoc = `${rw.file || "?"}:${rw.line_start !== undefined ? rw.line_start : "?"}`;
    const oldGrade = rw.old_grade || "?";
    const newGrade = rw.new_grade || "?";
    const oldScore = rw.old_score || 0;
    const newScore = rw.new_score || 0;
    const oldText = rw.original_text || "";
    const newText = rw.suggested_rewrite || "";
    const oldDw = rw.old_dominant_weakness || "-";
    const newDw = rw.new_dominant_weakness || "-";
    const improvements = rw.factor_improvements || {};

    lines.push(`### ${ruleId} - ${fileLoc} (${oldGrade} -> ${newGrade})\n`);
    lines.push(`**Original:** ${oldText}\n`);
    lines.push(`**Suggested rewrite:** ${newText}\n`);
    lines.push(`- Before: ${oldScore.toFixed(2)} (Grade ${oldGrade}) - dominant weakness: ${oldDw}`);
    lines.push(`- After:  ${newScore.toFixed(2)} (Grade ${newGrade}) - dominant weakness: ${newDw}`);

    if (Object.keys(improvements).length) {
      const parts = [];
      for (const [fname, pair] of Object.entries(improvements)) {
        if (Array.isArray(pair) && pair.length === 2) {
          parts.push(`${fname}: ${pair[0].toFixed(2)} -> ${pair[1].toFixed(2)}`);
        }
      }
      if (parts.length) {
        lines.push(`- Factor improvements: ${parts.join(", ")}`);
      }
    }

    const jv = rw.judgment_volatility || {};
    if (jv.flagged) {
      const f3Delta = jv.f3_delta || 0;
      const oldF3 = jv.old_f3;
      const newF3 = jv.new_f3;
      lines.push("");
      lines.push("  **WARNING - Judgment changed** (F3 moved by >0.20): part of the score change comes");
      lines.push("  from the F3 judgment moving, not from the rewrite targeting F1/F2/F7 directly.");
      if (Math.abs(f3Delta) > 0.2 && oldF3 !== null && oldF3 !== undefined && newF3 !== null && newF3 !== undefined) {
        const sign = f3Delta >= 0 ? "+" : "";
        lines.push(`    F3: ${oldF3.toFixed(2)} -> ${newF3.toFixed(2)} (delta ${sign}${f3Delta.toFixed(2)})`);
      }
    }

    const svd = rw.self_verification_delta;
    const projected = rw.projected_score;
    if (svd !== null && svd !== undefined && svd > 0.05 && projected !== null && projected !== undefined) {
      lines.push("");
      if (newScore < projected) {
        lines.push(
          `  **WARNING - Rewrite underdelivered**: projected ${projected.toFixed(2)}, ` +
            `re-scored ${newScore.toFixed(2)}. Review before applying.`
        );
      } else {
        lines.push(
          `  Note: Rewrite exceeded projection (projected ${projected.toFixed(2)}, ` +
            `re-scored ${newScore.toFixed(2)}). The improvement is real - projection is conservative.`
        );
      }
    }

    lines.push("");
  }
}

function _renderRuleDetail(lines, rule) {
  lines.push("```");
  lines.push(`File: ${rule.file || "?"}:${rule.line_start !== undefined ? rule.line_start : "?"}`);
  lines.push(`Rule: "${rule.text || ""}"`);
  lines.push(`Category: ${rule.category || "?"}`);
  lines.push(`Score: ${(rule.score || 0).toFixed(2)}`);
  lines.push("");

  const factors = rule.factors || {};
  const contributions = rule.contributions || {};
  const dw = rule.dominant_weakness;
  const fc = rule.failure_class;

  const factorNames = {
    F1: "verb strength",
    F2: "framing polarity",
    F3: "trigger-action dist",
    F4: "load-trigger align",
    F7: "concreteness",
  };

  if (fc) {
    lines.push(`At risk of: ${_FAILURE_CLASS_LABELS[fc] || fc}`);
    lines.push("");
  }

  for (const fn of ["F1", "F2", "F3", "F4", "F7"]) {
    const fdata = factors[fn] || {};
    const val = fdata.value;
    const contrib = contributions[fn];
    const label = factorNames[fn] || fn;
    const marker = fn === dw ? " <- dominant weakness" : "";

    const method = fdata.method || "";
    const overrideNote = method === "judgment_patch" ? " (judgment override)" : "";

    const paddedLabel = label.padEnd(22, ".");

    if (val === null || val === undefined) {
      lines.push(`  ${fn} ${paddedLabel}    —  (null — excluded)${overrideNote}`);
    } else if (typeof val === "number") {
      const contribVal = contrib !== null && contrib !== undefined ? contrib : 0.0;
      lines.push(
        `  ${fn} ${paddedLabel} ${val.toFixed(2).padStart(5)}  (contribution: ${contribVal.toFixed(3)})${marker}${overrideNote}`
      );
    } else {
      const contribVal = contrib !== null && contrib !== undefined ? contrib : 0.0;
      lines.push(
        `  ${fn} ${paddedLabel} ${String(val).padStart(5)}  (contribution: ${contribVal.toFixed(3)})${marker}${overrideNote}`
      );
    }
  }

  lines.push("");
  const layers = rule.layers || {};
  const clarity = layers.clarity;
  const activation = layers.activation;
  const mechanism = layers.mechanism;
  lines.push(
    `  Clarity: ${clarity !== null && clarity !== undefined ? clarity.toFixed(2) : "—"} | ` +
      `Activation: ${activation !== null && activation !== undefined ? activation.toFixed(2) : "—"} | ` +
      `Mechanism: ${mechanism !== null && mechanism !== undefined ? mechanism.toFixed(2) : "—"}`
  );

  const floor = rule.floor !== undefined ? rule.floor : 1.0;
  if (floor < 1.0) {
    lines.push(`  Floor: ${floor.toFixed(2)} (applied — reduces score from ${(rule.pre_floor_score || 0).toFixed(2)})`);
  }

  const skippedFloors = rule.skipped_floors || [];
  if (skippedFloors.length) {
    lines.push(`  * Soft floor skipped for unmeasured factor(s): ${skippedFloors.join(", ")}`);
  }

  if (rule.degraded || false) {
    const scoredCount = rule.scored_count !== undefined ? rule.scored_count : 6;
    lines.push(`  * scored on ${scoredCount}/6 factors — missing: ${(rule.degraded_factors || []).join(", ")}`);
  }

  lines.push("```\n");
}

function _suggestAction(rule) {
  const dw = rule.dominant_weakness;
  return _FRIENDLY_FIXES[dw] || "—";
}

function renderJson(audit) {
  return JSON.stringify(audit, null, 2);
}

function main() {
  const useJson = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose");

  let inputPath = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && i + 1 < args.length) {
      inputPath = args[i + 1];
      break;
    }
  }

  let audit;
  if (inputPath) {
    audit = _lib.readJson(inputPath);
  } else {
    audit = _lib.readStdinJson();
  }

  let output;
  if (useJson) {
    output = renderJson(audit);
  } else {
    output = renderMarkdown(audit, verbose);
  }

  process.stdout.write(output);
  process.stdout.write("\n");
}

if (require.main === module) {
  main();
}
