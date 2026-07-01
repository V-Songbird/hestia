"use strict";

const fs = require("fs");

function warn(msg) {
  process.stderr.write(`WARNING: ${msg}\n`);
}

function fatal(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

const F3_LEVELS = [
  [4, 0.9, 1.0],
  [3, 0.65, 0.85],
  [2, 0.4, 0.6],
  [1, 0.15, 0.35],
  [0, 0.0, 0.1],
];

const F8_LEVELS = [
  [3, 0.85, 1.0],
  [2, 0.55, 0.8],
  [1, 0.3, 0.5],
  [0, 0.1, 0.25],
];

const REASONING_MAX_LEN = 80;
const KNOWN_PATCH_FIELDS = ["F6_patch", "F7_patch", "F1_patch"];

const OPENING_FENCE_PATTERN = /^```\w*\s*\n/;
const CLOSING_FENCE_PATTERN = /\n```\s*$/;

function stripFences(text) {
  text = text.trim();
  text = text.replace(OPENING_FENCE_PATTERN, "");
  text = text.replace(CLOSING_FENCE_PATTERN, "");
  return text;
}

function findBalancedArray(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function extractJsonArray(text) {
  let pos = 0;
  while (true) {
    const start = text.indexOf("[", pos);
    if (start === -1) break;

    const end = findBalancedArray(text, start);
    if (end === null) {
      pos = start + 1;
      continue;
    }

    const substr = text.slice(start, end + 1);
    let parsed;
    try {
      parsed = JSON.parse(substr);
    } catch {
      pos = start + 1;
      continue;
    }

    if (Array.isArray(parsed)) return parsed;

    pos = start + 1;
  }

  throw new Error("No valid JSON array found in input");
}

function resolveLevel(value, levelTable) {
  for (const [level, lower] of levelTable) {
    if (value >= lower) return level;
  }
  return levelTable[levelTable.length - 1][0];
}

function levelMidpoint(level, levelTable) {
  for (const [lev, lower, upper] of levelTable) {
    if (lev === level) return Math.round(((lower + upper) / 2) * 100) / 100;
  }
  return 0.5;
}

function validateValueRange(ruleId, factorName, value, statedLevel, levelTable) {
  if (value === null || value === undefined || statedLevel === null || statedLevel === undefined) {
    return [null, null];
  }

  let statedRange = null;
  for (const [lev, lower, upper] of levelTable) {
    if (lev === statedLevel) {
      statedRange = [lower, upper];
      break;
    }
  }

  if (statedRange === null) {
    warn(`${ruleId} ${factorName}: unknown level ${statedLevel}, keeping value ${value}`);
    return [value, statedLevel];
  }

  const [lower, upper] = statedRange;
  if (lower <= value && value <= upper) {
    return [value, statedLevel];
  }

  const resolvedLevel = resolveLevel(value, levelTable);
  if (resolvedLevel === statedLevel) {
    return [value, statedLevel];
  }

  const correctedValue = levelMidpoint(statedLevel, levelTable);
  warn(
    `${ruleId} ${factorName}: value ${value} outside level ${statedLevel} ` +
      `range [${lower}, ${upper}]. Corrected to ${correctedValue} (level midpoint).`
  );
  return [correctedValue, statedLevel];
}

function truncateReasoning(reasoning) {
  if (reasoning.length <= REASONING_MAX_LEN) return reasoning;
  return reasoning.slice(0, REASONING_MAX_LEN - 3) + "...";
}

function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (typeof v === "object") return "dict";
  return typeof v;
}

function isDict(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v) {
  return typeof v === "number";
}

function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

function validateFactor(ruleId, factorName, factorData, levelTable) {
  if (!isDict(factorData)) {
    warn(`${ruleId} ${factorName}: expected dict, got ${typeName(factorData)}`);
    return null;
  }

  let value = Object.prototype.hasOwnProperty.call(factorData, "value") ? factorData.value : undefined;
  let level = Object.prototype.hasOwnProperty.call(factorData, "level") ? factorData.level : undefined;
  const reasoning = Object.prototype.hasOwnProperty.call(factorData, "reasoning") ? factorData.reasoning : "";

  if ((value === null || value === undefined) && (level === null || level === undefined)) {
    return {
      value: null,
      level: null,
      reasoning: reasoning ? truncateReasoning(pyStr(reasoning)) : "model_could_not_score",
    };
  }

  if (!isNumber(value)) {
    warn(`${ruleId} ${factorName}: value must be a number, got ${typeName(value)}`);
    return null;
  }
  if (!isInt(level)) {
    warn(`${ruleId} ${factorName}: level must be an integer, got ${typeName(level)}`);
    return null;
  }

  value = Number(value);

  if (value < 0.0 || value > 1.0) {
    warn(`${ruleId} ${factorName}: value ${value} outside [0, 1], clamping`);
    value = Math.max(0.0, Math.min(1.0, value));
  }

  [value, level] = validateValueRange(ruleId, factorName, value, level, levelTable);

  return {
    value,
    level,
    reasoning: truncateReasoning(pyStr(reasoning)),
  };
}

function validateEntry(entry, idx) {
  if (!isDict(entry)) {
    warn(`Entry ${idx}: expected dict, got ${typeName(entry)}, skipping`);
    return [null, {}];
  }

  const ruleId = entry.id;
  if (!ruleId || typeof ruleId !== "string") {
    warn(`Entry ${idx}: missing or invalid 'id' field, skipping`);
    return [null, {}];
  }

  const patches = {};

  const f3Data = entry.F3;
  if (f3Data !== null && f3Data !== undefined) {
    const validated = validateFactor(ruleId, "F3", f3Data, F3_LEVELS);
    if (validated !== null) {
      patches.F3 = validated;
    } else {
      patches.F3 = { value: null, level: null, reasoning: "parse_validation_failed" };
    }
  } else {
    patches.F3 = { value: null, level: null, reasoning: "model_omitted" };
    warn(`${ruleId}: F3 missing from entry`);
  }

  const f8Data = entry.F8;
  if (f8Data !== null && f8Data !== undefined) {
    const validated = validateFactor(ruleId, "F8", f8Data, F8_LEVELS);
    if (validated !== null) {
      patches.F8 = validated;
    } else {
      patches.F8 = { value: null, level: null, reasoning: "parse_validation_failed" };
    }
  } else {
    patches.F8 = { value: null, level: null, reasoning: "model_omitted" };
    warn(`${ruleId}: F8 missing from entry`);
  }

  for (const fieldName of KNOWN_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entry, fieldName)) {
      const patchData = entry[fieldName];
      if (!isDict(patchData)) {
        warn(`${ruleId}: ${fieldName} must be an object with a 'value' key, got ${typeName(patchData)}; dropping`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(patchData, "value")) {
        warn(`${ruleId}: ${fieldName} is missing required 'value' key; dropping (keys present: ${JSON.stringify(Object.keys(patchData).sort())})`);
        continue;
      }
      const val = patchData.value;
      if (val !== null && val !== undefined && !isNumber(val)) {
        warn(`${ruleId}: ${fieldName}.value must be a number or null, got ${typeName(val)}; dropping`);
        continue;
      }
      if (isNumber(val) && !(0.0 <= Number(val) && Number(val) <= 1.0)) {
        warn(`${ruleId}: ${fieldName}.value must be in [0, 1], got ${val}; dropping`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(patchData, "reasoning")) {
        patchData.reasoning = truncateReasoning(pyStr(patchData.reasoning));
      }
      patches[fieldName] = patchData;
    }
  }

  return [ruleId, patches];
}

function buildPatches(entries, expectedIds) {
  const patches = {};
  const seenIds = new Set();

  entries.forEach((entry, idx) => {
    const [ruleId, rulePatches] = validateEntry(entry, idx);
    if (ruleId === null) return;
    if (seenIds.has(ruleId)) {
      warn(`${ruleId}: duplicate entry, last one wins`);
    }
    seenIds.add(ruleId);
    patches[ruleId] = rulePatches;
  });

  const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));
  if (missingIds.length > 0) {
    const total = expectedIds.size;
    const tolerance = Math.max(2, Math.ceil(0.05 * total));

    for (const mid of [...missingIds].sort()) {
      warn(`${mid}: not found in model output, inserting null entry`);
      patches[mid] = {
        F3: { value: null, level: null, reasoning: "model_omitted" },
        F8: { value: null, level: null, reasoning: "model_omitted" },
      };
    }

    if (missingIds.length > tolerance) {
      const sortedMissing = [...missingIds].sort();
      fatal(
        `${missingIds.length} of ${total} rule IDs missing from model output ` +
          `(tolerance: ${tolerance}). Model may have truncated. ` +
          `Missing: ${sortedMissing.slice(0, 10).join(", ")}${missingIds.length > 10 ? "..." : ""}`
      );
    }
  }

  const unexpected = [...seenIds].filter((id) => !expectedIds.has(id));
  for (const uid of unexpected.sort()) {
    warn(`${uid}: in model output but not in scored_semi.json, ignoring`);
    delete patches[uid];
  }

  return patches;
}

function loadExpectedRuleIds(scoredSemiPath) {
  const data = JSON.parse(fs.readFileSync(scoredSemiPath, "utf-8"));

  const schemaVersion = data.schema_version;
  if (schemaVersion === null || schemaVersion === undefined) {
    warn("scored_semi.json has no schema_version field; assuming 0.1");
  } else if (schemaVersion !== "0.1") {
    fatal(
      `scored_semi.json schema_version is '${schemaVersion}', expected '0.1'. ` +
        `Pipeline version skew — regenerate scored_semi.json with the current scripts.`
    );
  }

  const rules = data.rules || [];
  return new Set(rules.filter((r) => r && Object.prototype.hasOwnProperty.call(r, "id")).map((r) => r.id));
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    fatal(
      "Usage: parse_judgment.js <scored_semi.json> [--expected-ids R001,...] " +
        "[--input file] [--output file]"
    );
  }

  let inputPath = null;
  let outputPath = null;
  let expectedIdsOverride = null;
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--input" && i + 1 < argv.length) {
      inputPath = argv[i + 1];
      i += 2;
    } else if (argv[i] === "--output" && i + 1 < argv.length) {
      outputPath = argv[i + 1];
      i += 2;
    } else if (argv[i] === "--expected-ids" && i + 1 < argv.length) {
      expectedIdsOverride = new Set(argv[i + 1].split(","));
      i += 2;
    } else {
      positional.push(argv[i]);
      i += 1;
    }
  }

  if (positional.length === 0) {
    fatal("Missing scored_semi.json argument");
  }
  const scoredSemiPath = positional[0];

  let allIds;
  try {
    allIds = loadExpectedRuleIds(scoredSemiPath);
  } catch (e) {
    fatal(`Cannot read scored_semi.json: ${e.message}`);
  }

  if (!allIds || allIds.size === 0) {
    fatal("scored_semi.json contains no rules");
  }

  const expectedIds = expectedIdsOverride || allIds;

  let rawInput;
  if (inputPath) {
    rawInput = fs.readFileSync(inputPath, "utf-8");
  } else {
    rawInput = readStdin();
  }
  if (!rawInput.trim()) {
    fatal("Empty input" + (inputPath ? ` from ${inputPath}` : " on stdin"));
  }

  const cleaned = stripFences(rawInput);

  let entries;
  try {
    entries = extractJsonArray(cleaned);
  } catch (e) {
    fatal(e.message);
  }

  const patches = buildPatches(entries, expectedIds);

  const output = {
    schema_version: "0.1",
    model_version: "unknown",
    patches,
  };
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  } else {
    process.stdout.write(JSON.stringify(output, null, 2));
    process.stdout.write("\n");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  stripFences,
  extractJsonArray,
  resolveLevel,
  levelMidpoint,
  validateValueRange,
  truncateReasoning,
  validateFactor,
  validateEntry,
  buildPatches,
  loadExpectedRuleIds,
  main,
};
