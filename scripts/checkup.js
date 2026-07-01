"use strict";

const path = require("path");
const { parseArgs } = require("util");

const discoverMod = require("./discover");
const freshMod = require("./freshness_state");
const refsMod = require("./refs");
const { Finding, emit, limitNote, rankFindings, readText } = require("./_lib");

const CLAUDE_MD_SOFT_MAX = 200;
const SKILL_SOFT_MAX = 500;

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const FM_KEY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

function parseFrontmatter(text) {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const keys = {};
  for (const line of m[1].split("\n")) {
    const km = FM_KEY.exec(line);
    if (km) keys[km[1]] = km[2].trim();
  }
  return keys;
}

function audit(projectRoot = null) {
  const inv = discoverMod.discover(projectRoot);
  const root = path.resolve(inv.project_root);
  const art = inv.artifacts;
  const findings = [];
  const limits = [];
  const skippedCleared = [];

  const staleness = freshMod.stalenessFor(root);

  const projectMd = art.claude_md.filter((c) => ["project", "project-dot"].includes(c.scope));
  if (!art.claude_md.length) {
    findings.push(Finding.cited({
      severity: "high", artifact: "claude-md",
      symptom: "No CLAUDE.md found",
      why: "Claude has no always-on project memory, so every session starts cold on your build/test commands and conventions.",
      fixAction: "Add a short CLAUDE.md at the project root with build/test commands and key conventions.",
      file: "CLAUDE.md",
      fix: "onboarding", tags: ["missing"],
    }));
  }

  for (const c of projectMd) {
    if (c.lines > CLAUDE_MD_SOFT_MAX) {
      findings.push(Finding.cited({
        severity: "medium", artifact: "claude-md",
        symptom: `CLAUDE.md is long (${c.lines} lines)`,
        why: "Long instruction files dilute attention — Claude weights every line less when there are too many.",
        fixAction: `Trim under ${CLAUDE_MD_SOFT_MAX} lines; move path-scoped detail into .claude/rules/ so it loads only when relevant.`,
        file: c.path, fix: "assess-rules", tags: ["size"],
      }));
    }
  }

  const refInputs = [...art.claude_md, ...art.rules].map((c) => path.join(root, c.path));
  const refSurface = "broken-refs";
  const refSig = freshMod.surfaceSignature(refInputs);
  if (freshMod.isCleared(root, refSurface, refSig)) {
    const rec = freshMod.clearedRecord(root, refSurface) || {};
    skippedCleared.push({
      surface: refSurface,
      verified_ts: rec.ts,
      verified_sha: rec.sha,
      inputs: refInputs.length,
    });
  } else {
    const refFindingsBefore = findings.length;
    for (const c of [...art.claude_md, ...art.rules]) {
      const broken = refsMod.brokenRefs(path.join(root, c.path), root);
      if (broken.length) {
        const shown = broken.slice(0, 6).join(", ") + (broken.length > 6 ? " …" : "");
        findings.push(Finding.cited({
          severity: "high", artifact: "reference",
          symptom: `${broken.length} reference(s) point to missing files`,
          why: "Stale references quietly mislead Claude — it follows a path that no longer exists.",
          fixAction: `Update or remove the broken refs: ${shown}`,
          file: c.path, fix: "freshness", tags: ["stale"],
        }));
      }
    }
    if (findings.length === refFindingsBefore) {
      freshMod.recordCleared(root, refSurface, refSig);
    } else {
      freshMod.clearSurface(root, refSurface);
    }
  }

  for (const a of art.agents) {
    const fm = parseFrontmatter(readText(path.join(root, a.path)));
    if (fm === null) {
      findings.push(Finding.cited({
        severity: "high", artifact: "agent",
        symptom: "Agent has no frontmatter",
        why: "Without YAML frontmatter (name + description), Claude can't reliably discover or dispatch this agent.",
        fixAction: "Add a YAML frontmatter block with at least `name` and `description`.",
        file: a.path, tags: ["frontmatter"],
      }));
    } else if (!fm.name || !fm.description) {
      const missing = ["name", "description"].filter((k) => !fm[k]).join(" and ");
      findings.push(Finding.cited({
        severity: "medium", artifact: "agent",
        symptom: `Agent frontmatter missing ${missing}`,
        why: "The description is what makes Claude pick the agent at the right moment.",
        fixAction: `Add the missing frontmatter field(s): ${missing}.`,
        file: a.path, tags: ["frontmatter"],
      }));
    }
  }

  for (const s of art.skills) {
    if (s.lines > SKILL_SOFT_MAX) {
      findings.push(Finding.cited({
        severity: "medium", artifact: "skill",
        symptom: `SKILL.md is long (${s.lines} lines)`,
        why: "A bloated SKILL.md body stops being a clean orchestrator and buries the steps Claude needs.",
        fixAction: `Trim under ${SKILL_SOFT_MAX} lines; move payloads and references into sibling files.`,
        file: s.path, tags: ["size"],
      }));
    }
  }

  for (const bad of inv.hooks.parse_errors || []) {
    findings.push(Finding.cited({
      severity: "medium", artifact: "hook",
      symptom: "settings file is not valid JSON",
      why: "Hooks and permissions in this file are being ignored entirely until the JSON parses.",
      fixAction: "Fix the JSON syntax error so the settings file loads.",
      file: bad, tags: ["parse"],
    }));
  }
  if (inv.mcp.parse_error) {
    findings.push(Finding.cited({
      severity: "medium", artifact: "mcp",
      symptom: ".mcp.json is not valid JSON",
      why: "MCP servers declared here are being ignored until the JSON parses.",
      fixAction: "Fix the JSON syntax error in .mcp.json.",
      file: inv.mcp.path || ".mcp.json", tags: ["parse"],
    }));
  }

  limits.push(limitNote(
    "rule-quality",
    "Heuristic scan only — rule clarity/scoring (grades, weak verbs, triggers) " +
    "is NOT graded here. Run /hestia:assess-rules for the model-judged pass.",
    "A rule can parse fine and still be vague or unenforceable."));
  limits.push(limitNote(
    "references",
    "Reference checks are conservative: only path-like tokens (./ ../ ~/ " +
    ".claude/ or slash+extension), @imports, and relative markdown links are " +
    "verified. Prose mentions of files and external URLs are not checked.",
    "A renamed concept referred to in prose won't be flagged."));
  limits.push(limitNote(
    "scope",
    "Read-only structural scan: file presence, sizes, frontmatter, and JSON " +
    "validity. It does not run hooks, execute MCP servers, or evaluate " +
    "whether your instructions are correct for this project."));

  for (const sk of skippedCleared) {
    const when = sk.verified_ts || "a previous run";
    limits.push(limitNote(
      "freshness-skip",
      `Surface '${sk.surface}' skipped: ${sk.inputs} input file(s) ` +
      `unchanged since verified clean at ${when}. Re-scanned automatically ` +
      `once any of those files changes.`,
      "Skipped on file size/mtime/path signature, not content " +
      "hash; a same-size, same-mtime edit would not be detected."));
  }

  const ranked = rankFindings(findings);
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of ranked) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  const nearEmpty = !art.claude_md.length && !art.rules.length && !art.agents.length && !art.skills.length;

  if (!nearEmpty) {
    freshMod.recordCheckup(root);
  }

  return {
    status: "ok",
    project_root: root,
    stack: inv.stack,
    summary: inv.summary,
    near_empty: nearEmpty,
    staleness,
    skipped_cleared: skippedCleared,
    counts,
    findings: ranked,
    limits,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string", default: undefined },
    },
  });
  emit(audit(values["project-root"]));
}

if (require.main === module) {
  main();
}

module.exports = { audit, parseFrontmatter };
