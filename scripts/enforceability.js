"use strict";

const _lib = require("./_lib");
const _sm = require("./score_mechanical");

const _ENF_DATA = _lib.loadData("enforceability");
const _MARKERS_DATA = _lib.loadData("markers");

const _QUALITY_WORDS = [
  ...new Set([
    ..._MARKERS_DATA.abstract_markers.map((w) => w.toLowerCase()),
    ..._ENF_DATA.quality_words.supplemental.map((w) => w.toLowerCase()),
  ]),
].sort((a, b) => b.length - a.length);

const _ENFORCEMENT_PHRASES = _ENF_DATA.enforcement_command_markers.phrases.map((p) =>
  p.toLowerCase()
);

const _BACKTICK = /`([^`]+)`/g;
const _F8_ENFORCEABLE_CEILING = 0.5;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _commandLikeBackticks(text) {
  const out = [];
  _BACKTICK.lastIndex = 0;
  for (const m of text.matchAll(_BACKTICK)) {
    const tok = m[1].trim();
    if (tok.includes(" ") || tok.startsWith("-")) out.push(tok);
  }
  return out;
}

function _enforcementPhrases(textLower) {
  return _ENFORCEMENT_PHRASES.filter((p) => textLower.includes(p)).map((p) => p.trim());
}

function _qualityWords(textLower) {
  const found = [];
  for (const w of _QUALITY_WORDS) {
    const re = new RegExp("(?:^|\\W)" + escapeRegex(w) + "(?:\\W|$)");
    if (re.test(textLower)) {
      if (found.some((longer) => longer.includes(w) && w !== longer)) continue;
      found.push(w);
    }
  }
  return found;
}

function _enforceableEvidence(text, rule) {
  const textLower = text.toLowerCase();
  const evidence = [];
  evidence.push(..._commandLikeBackticks(text));
  evidence.push(..._enforcementPhrases(textLower));
  evidence.push(
    ..._sm._findNumericThresholds(text.replace(_sm._BACKTICK_PATTERN, ""))
  );
  if (rule !== null && rule !== undefined) {
    const f8 = (rule.factors || {}).F8 || {};
    const f8Val = f8.value;
    if (typeof f8Val === "number" && f8Val <= _F8_ENFORCEABLE_CEILING) {
      evidence.push(`F8=${Math.round(f8Val * 100) / 100}`);
    }
  }
  const seen = new Set();
  const out = [];
  for (const e of evidence) {
    const key = e.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

function _directiveVerb(text) {
  const f1 = _sm.scoreF1(text);
  return f1.matched_verb || null;
}

function classifyRule(rule) {
  const text = rule.text || "";

  const enfEvidence = _enforceableEvidence(text, rule);
  const concrete = _sm._findConcreteMarkers(text);
  const quality = _qualityWords(text.toLowerCase());
  const verb = _directiveVerb(text);

  if (enfEvidence.length) {
    return {
      class: "enforceable",
      evidence: enfEvidence,
      concrete_markers: concrete,
      quality_words: quality,
      rationale:
        "names a runnable check (command, threshold, gate, or " +
        "mechanically-enforceable ceiling) a hook/linter/test could verify",
    };
  }

  if (quality.length && !concrete.length) {
    return {
      class: "folklore",
      evidence: [...quality],
      concrete_markers: [],
      quality_words: quality,
      rationale:
        "hinges on unverifiable quality word(s) with no concrete " +
        "construct, command, or threshold to check against",
    };
  }

  const drivers = [];
  if (concrete.length) drivers.push(...concrete);
  if (verb) drivers.push(verb);
  const rationale = drivers.length
    ? "names a concrete construct and/or directive verb Claude can self-check " +
      "at edit time, but no external mechanical check"
    : "no quality-word/concrete signal — conservatively left self-checkable, not flagged";
  return {
    class: "observable",
    evidence: drivers,
    concrete_markers: concrete,
    quality_words: quality,
    rationale,
  };
}

function classifyRules(rules) {
  for (const rule of rules) {
    rule.enforceability = classifyRule(rule);
  }
  return rules;
}

function main() {
  const data = _lib.readStdinJson();
  if (data === null) _lib.fail("empty input");
  const rules = Array.isArray(data) ? data : data.rules || [];
  classifyRules(rules);
  _lib.emit(data);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyRule,
  classifyRules,
};
