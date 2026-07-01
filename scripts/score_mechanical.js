"use strict";

const _lib = require("./_lib");

const _VERBS_DATA = _lib.loadData("verbs");
const _FRAMING_DATA = _lib.loadData("framing");
const _WEIGHTS_DATA = _lib.loadData("weights");
const _MARKERS_DATA = _lib.loadData("markers");

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pre-compile verb patterns sorted by length (longest first for greedy matching).
const _VERB_TIERS = [];
for (const tier of _VERBS_DATA.patterns) {
  for (const verb of tier.verbs) {
    const verbLower = verb.toLowerCase();
    const pattern = new RegExp(
      "(?:^|[\\s,;(])(" + escapeRegex(verbLower) + ")(?:[\\s,;.)!?]|$)"
    );
    _VERB_TIERS.push([verbLower, tier.score, tier.label, pattern]);
  }
}
_VERB_TIERS.sort((a, b) => b[0].length - a[0].length);

// Pre-compile F7 patterns at module load to avoid per-rule recompilation.
const _BACKTICK_PATTERN = /`([^`]+)`/g;
const _CONCRETE_REGEX_COMPILED = [];
for (const patStr of _MARKERS_DATA.concrete_regex) {
  try {
    _CONCRETE_REGEX_COMPILED.push(new RegExp(patStr, "g"));
  } catch {
    continue;
  }
}

const _NUMERIC_THRESHOLD_REGEX_COMPILED = [];
for (const patStr of _MARKERS_DATA.numeric_threshold_regex || []) {
  try {
    _NUMERIC_THRESHOLD_REGEX_COMPILED.push(new RegExp(patStr, "gi"));
  } catch {
    continue;
  }
}

const _CONCRETE_TERMS_LOWER = (_MARKERS_DATA.concrete_terms || []).map((term) => [
  term,
  term.toLowerCase(),
]);

// ---------------------------------------------------------------------------
// F1: Verb Strength
// ---------------------------------------------------------------------------

function scoreF1(ruleText) {
  const textLower = ruleText.toLowerCase();

  const matches = [];
  for (const [verb, score, label, pattern] of _VERB_TIERS) {
    const m = pattern.exec(textLower);
    if (m) {
      matches.push([verb, score, label, m.index + m[0].indexOf(m[1])]);
    }
  }

  if (matches.length === 0) {
    if (_looksLikeStatement(textLower)) {
      return {
        value: _VERBS_DATA.implicit_verb_default,
        method: "implicit_imperative_default",
        matched_verb: null,
        matched_score_tier: null,
        matched_position: null,
      };
    }
    return {
      value: null,
      method: "extraction_failed",
      matched_verb: null,
      matched_score_tier: null,
      matched_position: null,
    };
  }

  const bestMatchScore = Math.max(...matches.map((m) => m[1]));
  if (_looksLikeStatement(textLower) && bestMatchScore <= 0.85) {
    return {
      value: _VERBS_DATA.implicit_verb_default,
      method: "implicit_imperative_default",
      matched_verb: null,
      matched_score_tier: null,
      matched_position: null,
    };
  }

  const hedgingLabels = new Set(["hedged", "suggestion", "weak_suggestion", "preference"]);
  const hedgingMatches = matches.filter((m) => hedgingLabels.has(m[2]));

  let best;
  if (hedgingMatches.length >= 2) {
    best = hedgingMatches.reduce((a, b) => (b[1] < a[1] ? b : a));
  } else {
    best = matches.reduce((a, b) => (b[1] > a[1] ? b : a));
  }

  if (matches.some((m) => m[0] === "always")) {
    const nonAlways = matches.filter((m) => m[0] !== "always" && m[2] === "bare_imperative");
    if (nonAlways.length > 0) {
      return {
        value: 1.0,
        method: "lookup",
        matched_verb: `always + ${nonAlways[0][0]}`,
        matched_score_tier: 1.0,
        matched_position: nonAlways[0][3],
      };
    }
  }

  return {
    value: best[1],
    method: "lookup",
    matched_verb: best[0],
    matched_score_tier: best[1],
    matched_position: best[3],
  };
}

const _NOUN_VERB_AMBIGUOUS = new Set([
  "document", "format", "log", "name", "set", "watch",
  "report", "display", "record", "test", "check",
  "cache", "scope", "limit", "batch", "profile",
  "audit", "benchmark", "aggregate", "archive",
  "guard", "pin", "drain",
]);

const _NOUN_FOLLOWERS = new Set([
  "headers", "files", "strings", "entries", "requests", "messages",
  "logs", "values", "types", "fields", "options",
  "conventions", "names", "rules", "paths", "settings",
  "keys", "items", "objects", "results", "records",
  "operations", "endpoints", "variables", "pages", "data",
  "clauses", "layers", "levels", "lines", "traits",
  "pipes", "pools", "connections", "events", "configs",
]);

function _looksLikeStatement(textLower) {
  const words = textLower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const statementStarts = [
    /^(?:all|each|every|the|a|an|this|that|these|those)\s/,
    /^(?:files?|code|modules?|components?|functions?|classes|methods)\s/,
    /^tests?\s+(?!the\s|a\s|an\s)/,
  ];
  for (const pat of statementStarts) {
    if (pat.test(textLower)) return true;
  }

  if (words.length >= 2 && _NOUN_VERB_AMBIGUOUS.has(words[0])) {
    if (_NOUN_FOLLOWERS.has(words[1])) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// F2: Framing Polarity
// ---------------------------------------------------------------------------

function scoreF2(ruleText, f1Evidence) {
  const textLower = ruleText.toLowerCase();

  const prohibitionPatterns = _FRAMING_DATA.categories[3].patterns;
  const isProhibition = prohibitionPatterns.some((p) => textLower.includes(p));

  const hedgedPatterns = _FRAMING_DATA.categories[4].patterns;
  const isHedged = hedgedPatterns.some((p) => textLower.includes(p));

  const altPatterns = _FRAMING_DATA.categories[0].patterns;
  let hasAlternative = altPatterns.some((p) => textLower.includes(p));

  if (!hasAlternative) {
    const [isContrast] = _hasContrastNot(ruleText);
    if (isContrast) hasAlternative = true;
  }

  if (isProhibition) {
    const sentences = ruleText.split(/(?<=[.!?])\s+(?=[A-Z])|[;—–]\s*/);
    if (sentences.length >= 2) {
      const followUp = sentences.slice(1).join(" ");
      if (_hasPositiveImperative(followUp)) {
        return { value: 0.70, method: "classify", matched_category: "positive_with_negative_clarification" };
      }
    }
    return { value: 0.50, method: "classify", matched_category: "prohibition" };
  }

  if (isHedged) {
    return { value: 0.35, method: "classify", matched_category: "hedged_preference" };
  }

  if (hasAlternative) {
    return { value: 0.95, method: "classify", matched_category: "positive_with_alternative" };
  }

  const sentences = ruleText.split(/(?<=[.!?])\s+(?=[A-Z])/);
  if (sentences.length >= 2) {
    const firstPositive = _hasPositiveImperative(sentences[0]);
    const restHasProhibition = sentences
      .slice(1)
      .some((s) => prohibitionPatterns.some((p) => s.toLowerCase().includes(p)));
    if (firstPositive && restHasProhibition) {
      return { value: 0.70, method: "classify", matched_category: "positive_with_negative_clarification" };
    }
  }

  return { value: 0.85, method: "classify", matched_category: "positive_imperative" };
}

function _hasPositiveImperative(text) {
  const textLower = text.toLowerCase().trim();
  const prohibitionMarkers = ["never", "do not", "don't", "avoid", "must not"];
  if (prohibitionMarkers.some((p) => textLower.startsWith(p))) return false;
  for (const [verb, , label] of _VERB_TIERS) {
    if (
      (label === "bare_imperative" || label === "unconditional_mandate") &&
      new RegExp("(?:^|\\s)" + escapeRegex(verb) + "(?:\\s|$|[,.])").test(textLower)
    ) {
      return true;
    }
  }
  return false;
}

function _hasContrastNot(text) {
  if (/`[^`]+`\s*[,;:]?\s+not\s+`[^`]+`/.test(text)) {
    return [true, true];
  }

  const NEGATION_PATTERNS = [
    /\b(?:is|are|was|were|be|been|being)\s+not\b/i,
    /,\s+not\s+\w+(?:ing|ed|ly)\b/i,
    /,\s+not\s+\w+\s+(?:on|to|in|with|from|by|at|of|as|for|after|before)\b/i,
  ];
  for (const pat of NEGATION_PATTERNS) {
    if (pat.test(text)) return [false, true];
  }

  if (/,\s+not\s+\w+/i.test(text)) return [true, false];

  return [false, true];
}

// ---------------------------------------------------------------------------
// F4: Load-Trigger Alignment
// ---------------------------------------------------------------------------

function scoreF4(rule, sourceFile) {
  const globs = sourceFile.globs || [];
  const alwaysLoaded = sourceFile.always_loaded !== undefined ? sourceFile.always_loaded : true;
  const globMatchCount = sourceFile.glob_match_count;
  const ruleText = rule.text.toLowerCase();
  const staleness = rule.staleness || {};

  if (staleness.gated) {
    return { value: 0.05, method: "stale", loading: globs.length ? "glob-scoped" : "always-loaded", trigger_match: null };
  }

  if (globs.length && globMatchCount === 0) {
    return { value: 0.05, method: "dead_glob", loading: "glob-scoped", trigger_match: null };
  }

  if (alwaysLoaded && !globs.length) {
    const triggerKeywords = _extractTriggerScope(ruleText);
    if (triggerKeywords.size) {
      return { value: 0.40, method: "misaligned", loading: "always-loaded", trigger_match: "specific_trigger_in_universal_file" };
    }
    return { value: 0.95, method: "always_universal", loading: "always-loaded", trigger_match: "universal" };
  }

  if (globs.length) {
    const triggerKeywords = _extractTriggerScope(ruleText);
    const globKeywords = _extractGlobKeywords(globs);

    if (triggerKeywords.size) {
      const overlap = _setIntersect(triggerKeywords, globKeywords);
      if (overlap.size) {
        return { value: 0.95, method: "glob_match", loading: "glob-scoped", trigger_match: "explicit_match" };
      }
      return { value: 0.25, method: "wrong_scope", loading: "glob-scoped", trigger_match: "explicit_mismatch" };
    }

    const ruleKeywords = _extractRuleKeywords(ruleText);
    const overlap = _setIntersect(ruleKeywords, globKeywords);
    if (overlap.size) {
      return {
        value: 0.90,
        method: "keyword_overlap",
        loading: "glob-scoped",
        trigger_match: `overlap:${[...overlap].sort().join(",")}`,
      };
    }

    const noOverlapScore = _WEIGHTS_DATA.F4_no_overlap_score ?? 0.85;
    return { value: noOverlapScore, method: "keyword_overlap", loading: "glob-scoped", trigger_match: "implicit_scope_trust" };
  }

  const ambiguousScore = _WEIGHTS_DATA.F4_ambiguous_score ?? 0.65;
  return { value: ambiguousScore, method: "no_signal", loading: "ambiguous", trigger_match: "fallback" };
}

function _setIntersect(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function _extractTriggerScope(text) {
  const triggers = new Set();
  const patterns = [
    /\bwhen\s+(?:editing|working\s+(?:on|with)|modifying|creating)\s+(\w+)\s+files?\b/gi,
    /\bfor\s+(\w+)\s+files?\b/gi,
    /\bin\s+(?:the\s+)?(\w+)\s+(?:directory|folder|module)\b/gi,
    /\bduring\s+(\w+)\b/gi,
  ];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      triggers.add(m[1].toLowerCase());
    }
  }
  return triggers;
}

function _extractGlobKeywords(globs) {
  const keywords = new Set();
  for (const g of globs) {
    const parts = g.split(/[/\\*?.[\]{}]+/);
    for (let part of parts) {
      part = part.toLowerCase().trim();
      if (part && part.length > 1 && !["src", "lib", "test", "tests"].includes(part)) {
        keywords.add(part);
      }
    }
  }
  return keywords;
}

const _STOP_WORDS = new Set([
  "the", "and", "for", "all", "new", "with", "not", "use", "when",
  "this", "that", "from", "into", "over", "than", "must", "should",
  "always", "never", "before", "after", "each", "every", "where",
  "only", "also", "just", "about", "more", "most", "some", "any",
]);

function _extractRuleKeywords(text) {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  return new Set(words.filter((w) => !_STOP_WORDS.has(w)));
}

// ---------------------------------------------------------------------------
// F7: Concreteness
// ---------------------------------------------------------------------------

function _findNumericThresholds(text) {
  const markers = [];
  for (const pattern of _NUMERIC_THRESHOLD_REGEX_COMPILED) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const phrase = m[0].trim();
      if (markers.some((existing) => phrase.includes(existing) || existing.includes(phrase))) {
        const longer = markers.filter((existing) => phrase.includes(existing) && existing !== phrase);
        for (const existing of longer) {
          const idx = markers.indexOf(existing);
          if (idx !== -1) markers.splice(idx, 1);
        }
        if (!markers.includes(phrase)) markers.push(phrase);
        continue;
      }
      markers.push(phrase);
    }
  }
  return markers;
}

function _findConcreteMarkers(text) {
  const markers = [];

  _BACKTICK_PATTERN.lastIndex = 0;
  for (const m of text.matchAll(_BACKTICK_PATTERN)) {
    markers.push(m[1]);
  }

  const textStripped = text.replace(_BACKTICK_PATTERN, "");

  for (const pattern of _CONCRETE_REGEX_COMPILED) {
    pattern.lastIndex = 0;
    for (const m of textStripped.matchAll(pattern)) {
      const name = m[0];
      if (!markers.includes(name)) markers.push(name);
    }
  }

  for (const phrase of _findNumericThresholds(textStripped)) {
    if (!markers.includes(phrase)) markers.push(phrase);
  }

  const textLower = text.toLowerCase();
  const existingLower = markers.map((m) => m.toLowerCase());
  for (const [term, termLower] of _CONCRETE_TERMS_LOWER) {
    if (textLower.includes(termLower)) {
      const alreadyCovered = existingLower.some(
        (mLower) => termLower.includes(mLower) || mLower.includes(termLower)
      );
      if (!alreadyCovered) {
        markers.push(term);
        existingLower.push(termLower);
      }
    }
  }

  return markers;
}

function _findAbstractMarkers(text) {
  const markers = [];
  const textLower = text.toLowerCase();
  for (const abstract of _MARKERS_DATA.abstract_markers) {
    if (textLower.includes(abstract.toLowerCase())) markers.push(abstract);
  }
  return markers;
}

function _scoreFromRatio(concreteCount, abstractCount) {
  if (concreteCount === 0 && abstractCount === 0) return 0.05;

  if (concreteCount === 0) return 0.10;

  if (abstractCount === 0) {
    if (concreteCount >= 4) return 0.95;
    if (concreteCount >= 2) return 0.85;
    return 0.80;
  }

  const ratio = concreteCount / (concreteCount + abstractCount);

  if (ratio >= 0.80) return 0.75 + 0.10 * Math.min(concreteCount / 4, 1.0);
  if (ratio >= 0.50) return 0.45 + 0.20 * ratio;
  if (ratio >= 0.25) return 0.25 + 0.15 * ratio;
  return 0.10 + 0.10 * ratio;
}

function scoreF7(ruleText) {
  const concrete = _findConcreteMarkers(ruleText);
  const abstract = _findAbstractMarkers(ruleText);

  const value = _scoreFromRatio(concrete.length, abstract.length);

  return {
    value: Math.round(value * 100) / 100,
    method: "count",
    concrete_markers: concrete,
    abstract_markers: abstract,
    concrete_count: concrete.length,
    abstract_count: abstract.length,
  };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function main() {
  const data = _lib.readStdinJson();
  if (data === null) _lib.fail("empty input");

  const sourceFiles = data.source_files || [];
  const rules = data.rules || [];

  for (const rule of rules) {
    const fileIdx = rule.file_index || 0;
    const sf = fileIdx < sourceFiles.length ? sourceFiles[fileIdx] : {};

    if (!("factors" in rule)) rule.factors = {};

    const f1 = scoreF1(rule.text);
    rule.factors.F1 = f1;

    const f2 = scoreF2(rule.text, f1);
    rule.factors.F2 = f2;

    const f4 = scoreF4(rule, sf);
    rule.factors.F4 = f4;

    const f7 = scoreF7(rule.text);
    rule.factors.F7 = f7;

    if (f7.concrete_count > 0 && f7.abstract_count > 0) {
      if (!("factor_confidence_low" in rule)) rule.factor_confidence_low = [];
      if (!rule.factor_confidence_low.includes("F7")) rule.factor_confidence_low.push("F7");
    }

    if (f1.method === "extraction_failed") {
      if (!("factor_confidence_low" in rule)) rule.factor_confidence_low = [];
      if (!rule.factor_confidence_low.includes("F1")) rule.factor_confidence_low.push("F1");
    }
  }

  _lib.emit(data);
}

if (require.main === module) {
  main();
}

module.exports = {
  scoreF1,
  scoreF2,
  scoreF4,
  scoreF7,
  _findNumericThresholds,
  _findConcreteMarkers,
  _findAbstractMarkers,
  _BACKTICK_PATTERN,
};
