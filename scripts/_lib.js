"use strict";

const fs = require("fs");
const path = require("path");

const SCRIPT_DIR = __dirname;
const DATA_DIR = path.join(SCRIPT_DIR, "_data");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJson(p, obj, indent = 2) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, indent), "utf-8");
}

function readText(p) {
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf-8");
}

function loadData(name) {
  return readJson(path.join(DATA_DIR, `${name}.json`));
}

function readStdinJson() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    raw = "";
  }
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function fail(reason, extra = {}) {
  const payload = { status: "failed", reason, ...extra };
  emit(payload);
  process.exit(1);
}

function findProjectRoot(start) {
  let cur = path.resolve(start || process.cwd());
  const parts = [];
  let dir = cur;
  while (true) {
    parts.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of parts) {
    if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
  }
  return cur;
}

function rel(p, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(p);
  const relPath = path.relative(resolvedRoot, resolvedPath);
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return resolvedPath.split(path.sep).join("/");
  }
  return relPath.split(path.sep).join("/");
}

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };

class Finding {
  constructor({
    severity,
    artifact,
    symptom,
    why = "",
    fixAction = "",
    file = "",
    line = null,
    fix = "",
    advisory = false,
    tags = [],
  }) {
    this.severity = severity;
    this.artifact = artifact;
    this.symptom = symptom;
    this.why = why;
    this.fix_action = fixAction;
    this.file = file;
    this.line = line === null || line === undefined ? null : String(line);
    this.fix = fix;
    this.advisory = advisory;
    this.tags = [...tags];

    if (!this.advisory && !this.file) {
      throw new Error(
        "cite-or-drop: a normal Finding requires a `file` locator. " +
          "Use Finding.advisoryNote(...) for an unverified, locator-less hunch."
      );
    }
  }

  static cited({
    severity,
    artifact,
    symptom,
    why,
    fixAction,
    file,
    line = null,
    fix = "",
    tags = null,
  }) {
    if (!file) {
      throw new Error("cite-or-drop: Finding.cited requires a `file` locator.");
    }
    return new Finding({
      severity,
      artifact,
      symptom,
      why,
      fixAction,
      file,
      line: line === null || line === undefined ? null : String(line),
      fix,
      advisory: false,
      tags: tags || [],
    });
  }

  static advisoryNote({
    severity,
    artifact,
    symptom,
    why = "",
    fixAction = "",
    fix = "",
    tags = null,
  }) {
    return new Finding({
      severity,
      artifact,
      symptom,
      why,
      fixAction,
      file: "",
      line: null,
      fix,
      advisory: true,
      tags: tags || [],
    });
  }

  get location() {
    if (!this.file) return "";
    return this.line ? `${this.file}:${this.line}` : this.file;
  }

  toDict() {
    return {
      severity: this.severity,
      artifact: this.artifact,
      symptom: this.symptom,
      why: this.why,
      fix_action: this.fix_action,
      file: this.file,
      line: this.line,
      fix: this.fix,
      advisory: this.advisory,
      tags: this.tags,
      location: this.location,
    };
  }
}

function rankFindings(findings) {
  const dicts = findings.map((f) => (f instanceof Finding ? f.toDict() : f));
  dicts.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
  );
  return dicts;
}

function limitNote(scope, detail, residualRisk = "") {
  const note = { scope, detail };
  if (residualRisk) note.residual_risk = residualRisk;
  return note;
}

module.exports = {
  SCRIPT_DIR,
  DATA_DIR,
  readJson,
  writeJson,
  readText,
  loadData,
  readStdinJson,
  emit,
  fail,
  findProjectRoot,
  rel,
  SEVERITY_RANK,
  Finding,
  rankFindings,
  limitNote,
};
