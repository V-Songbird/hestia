"use strict";

const _lib = require("./_lib");

const _CONFIDENCE_DATA = _lib.loadData("semi_confidence");

function _evidenceF3(rule) {
  const factors = rule.factors || {};
  const f3 = factors.F3 || {};
  return {
    value: f3.value ?? null,
    level: f3.level ?? null,
    method: f3.method || "",
    rule_id: rule.id || "",
  };
}

function shouldFlagF3(evidence) {
  const conf = _CONFIDENCE_DATA.F3;
  if (!conf) return false;
  const value = evidence.value;
  if (value === null || value === undefined) return true;
  const [low, high] = conf.flag_when_value_between || [0.35, 0.7];
  return low <= value && value <= high;
}

function _evidenceF8(rule) {
  const factors = rule.factors || {};
  const f8 = factors.F8 || {};
  return {
    value: f8.value ?? null,
    level: f8.level ?? null,
    method: f8.method || "",
    rule_id: rule.id || "",
  };
}

function shouldFlagF8(evidence) {
  const conf = _CONFIDENCE_DATA.F8;
  if (!conf) return false;
  const value = evidence.value;
  if (value === null || value === undefined) return true;
  const [low, high] = conf.flag_when_value_between || [0.35, 0.7];
  return low <= value && value <= high;
}

function main() {
  const data = _lib.readStdinJson();
  if (!data) {
    _lib.fail("empty input");
    return;
  }
  const rules = data.rules || [];

  for (const rule of rules) {
    const flags = rule.factor_confidence_low || [];

    const f3Ev = _evidenceF3(rule);
    if (shouldFlagF3(f3Ev)) {
      if (!flags.includes("F3")) flags.push("F3");
    }

    const f8Ev = _evidenceF8(rule);
    if (shouldFlagF8(f8Ev)) {
      if (!flags.includes("F8")) flags.push("F8");
    }

    if (flags.length) {
      rule.factor_confidence_low = flags;
    }
  }

  _lib.emit(data);
}

if (require.main === module) {
  main();
}

module.exports = { shouldFlagF3, shouldFlagF8, main };
