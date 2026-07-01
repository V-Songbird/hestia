"use strict";

const path = require("path");
const os = require("os");
const { parseArgs } = require("util");

const { emit, loadData, readText, rel } = require("./_lib");
const { discover, PRUNE_DIRS } = require("./discover");

const _BARE_LINK_PATTERN = /^\s*[-*]?\s*\[.*?\]\(.*?\)\s*$/;

function stripMetadata(content) {
  const lines = content.split("\n");
  const result = [];
  const annotations = {};

  let frontmatterEnd = 0;
  if (lines.length && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        frontmatterEnd = i + 1;
        break;
      }
    }
  }

  const fenceRegions = new Set();
  let inFence = false;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      fenceRegions.add(i);
    } else if (inFence) {
      fenceRegions.add(i);
    }
  }

  const tableRegions = new Set();
  let i = frontmatterEnd;
  while (i < lines.length) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("|") && !fenceRegions.has(i)) {
      if (i + 1 < lines.length && /^\|[\s:]*-/.test(lines[i + 1].trim())) {
        let j = i;
        while (j < lines.length && lines[j].trim().startsWith("|")) {
          tableRegions.add(j);
          j++;
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNum = idx + 1;

    if (idx < frontmatterEnd) continue;
    if (fenceRegions.has(idx)) continue;
    if (tableRegions.has(idx)) continue;

    const stripped = line.trim();

    const catMatch = stripped.match(/^<!--\s*category:\s*(\w+)\s*-->/);
    if (catMatch) {
      annotations[lineNum] = catMatch[1];
      continue;
    }

    if (/^#{1,6}\s/.test(stripped)) {
      result.push({ line_num: lineNum, text: "", is_content: false, is_blank: false, is_heading: true, raw: stripped });
      continue;
    }

    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(stripped)) {
      continue;
    }

    if (!stripped) {
      result.push({ line_num: lineNum, text: "", is_content: false, is_blank: true, is_heading: false, raw: "" });
      continue;
    }

    if (_BARE_LINK_PATTERN.test(stripped)) {
      continue;
    }

    result.push({ line_num: lineNum, text: stripped, is_content: true, is_blank: false, is_heading: false, raw: line });
  }

  return [result, annotations];
}

function identifyChunks(lines) {
  const chunks = [];
  let currentChunk = null;
  let currentHeading = null;
  let currentHeadingLine = null;

  for (const line of lines) {
    if (!line.is_content) {
      if (line.is_heading) {
        const raw = line.raw || "";
        const headingText = raw.replace(/^#{1,6}\s+/, "").trim();
        if (headingText) {
          currentHeading = headingText;
          currentHeadingLine = line.line_num;
        }
      }
      if (line.is_blank && currentChunk !== null) {
        chunks.push(currentChunk);
        currentChunk = null;
      }
      continue;
    }

    const text = line.text;
    const raw = line.raw;

    const isBullet = /^(?:[-*]|\d+\.)\s/.test(text);
    const isContinuation = /^(?:\s{2,}|\t)/.test(raw) && !isBullet;

    if (isBullet) {
      if (currentChunk !== null) chunks.push(currentChunk);
      currentChunk = {
        lines: [line],
        line_start: line.line_num,
        line_end: line.line_num,
        text: text.replace(/^(?:[-*]|\d+\.)\s+/, ""),
        is_bullet: true,
        section_heading: currentHeading,
        section_heading_line: currentHeadingLine,
      };
    } else if (isContinuation && currentChunk !== null) {
      currentChunk.lines.push(line);
      currentChunk.line_end = line.line_num;
      currentChunk.text += " " + text;
    } else if (currentChunk === null) {
      currentChunk = {
        lines: [line],
        line_start: line.line_num,
        line_end: line.line_num,
        text,
        is_bullet: false,
        section_heading: currentHeading,
        section_heading_line: currentHeadingLine,
      };
    } else {
      currentChunk.lines.push(line);
      currentChunk.line_end = line.line_num;
      currentChunk.text += " " + text;
    }
  }

  if (currentChunk !== null) chunks.push(currentChunk);

  return chunks;
}

const _IMPERATIVE_VERBS = loadData("verbs");
const _ALL_VERBS = new Set();
for (const tier of _IMPERATIVE_VERBS.patterns) {
  for (const v of tier.verbs) {
    _ALL_VERBS.add(v.toLowerCase());
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _VERB_BOUNDARY_PATTERNS = [..._ALL_VERBS].map(
  (v) => new RegExp("(?:^|\\s|,)" + escapeRe(v) + "(?:\\s|$|,|\\.)")
);

const _CONSTRAINT_KEYWORDS = ["only", "required", "forbidden", "mandatory"];
const _CONSTRAINT_PATTERNS = _CONSTRAINT_KEYWORDS.map((kw) => new RegExp("\\b" + escapeRe(kw) + "\\b"));

const _VERBS_BY_LEN_DESC = [..._ALL_VERBS].sort((a, b) => b.length - a.length);
const _CONDITIONAL_PATTERN = new RegExp(
  "\\b(?:when|if|for)\\b.*?,\\s*(?:" + _VERBS_BY_LEN_DESC.map(escapeRe).join("|") + ")\\b",
  "i"
);

const _PROSE_STARTERS = new RegExp(
  "^(?:this means|this is because|the reason|note that|background:|overview:|for context" +
    "|these rules|this rule|this file|these files|this section|the following" +
    "|detailed conventions|scoped rules)",
  "i"
);
const _MECHANISM_PATTERN = new RegExp(
  "^(?:the\\s+\\w+\\s+(?:pipeline|agent|system|layer|service)\\s+(?:runs|handles|manages|processes))",
  "i"
);
const _REFERENCE_PATTERN = new RegExp("^see\\s+[`\"\\[].*?\\b(?:for|about)\\b", "i");
const _DESCRIPTION_BULLET_PATTERN = /^\*\*[^*]+\*\*\s*(?:—|--|:)\s/;
const _NAVIGATION_POINTER_PATTERN = new RegExp(
  "^`[^`]+\\.md`\\s*(?:—|--|:|→|→)\\s" +
    "|^\\*\\*[^*]+\\*\\*\\s*(?:→|→|—|--)\\s*\\[?`?[\\w./-]*\\.md" +
    "|^\\[[^\\]]+\\]\\([^)]*\\.md\\)\\s*(?:—|--|:|→|→)\\s"
);

function hasImperativeVerb(text) {
  const textLower = text.toLowerCase();
  for (const pattern of _VERB_BOUNDARY_PATTERNS) {
    if (pattern.test(textLower)) return true;
  }
  return false;
}

function hasConstraintKeyword(text) {
  const textLower = text.toLowerCase();
  for (const pattern of _CONSTRAINT_PATTERNS) {
    if (pattern.test(textLower)) return true;
  }
  return false;
}

function classifyChunk(chunk) {
  const text = chunk.text;
  const textPlain = text.replace(/\*\*([^*]+)\*\*/g, "$1");

  if (_PROSE_STARTERS.test(text)) return "prose";
  if (_MECHANISM_PATTERN.test(text)) return "prose";
  if (_REFERENCE_PATTERN.test(text)) return "prose";

  if (chunk.is_bullet && _NAVIGATION_POINTER_PATTERN.test(text)) return "prose";

  if (hasImperativeVerb(textPlain)) return "rule";
  if (hasConstraintKeyword(text)) return "rule";
  if (_CONDITIONAL_PATTERN.test(text)) return "rule";

  if (chunk.is_bullet) {
    if (_DESCRIPTION_BULLET_PATTERN.test(text)) return "prose";
    return "rule";
  }

  return "prose";
}

const _CLARIFICATION_STARTERS = new RegExp(
  "^(?:this means|for example|i\\.e\\.|e\\.g\\.|in other words|specifically|that is)",
  "i"
);

function _isVerblessBullet(chunk) {
  return Boolean(chunk.is_bullet) && !hasImperativeVerb(chunk.text) && !hasConstraintKeyword(chunk.text);
}

function mergeClarifications(chunks) {
  const classified = chunks.map((chunk) => [chunk, classifyChunk(chunk)]);
  const merged = [];

  let i = 0;
  while (i < classified.length) {
    let [chunk, cls] = classified[i];

    if (cls === "rule") {
      if (_isVerblessBullet(chunk) && chunk.section_heading) {
        const heading = chunk.section_heading;
        const headingLine = chunk.section_heading_line !== undefined ? chunk.section_heading_line : chunk.line_start;
        const synthetic = {
          lines: [],
          line_start: headingLine,
          line_end: chunk.line_start,
          text: heading + ":",
          is_bullet: false,
          section_heading: heading,
        };
        let mergedChunk = _mergeTwoChunks(synthetic, chunk);
        let j = i + 1;
        while (j < classified.length) {
          const [nextChunk, nextCls] = classified[j];
          if (nextCls === "rule" && _isVerblessBullet(nextChunk) && nextChunk.section_heading === heading) {
            mergedChunk = _mergeTwoChunks(mergedChunk, nextChunk);
            j++;
          } else {
            break;
          }
        }
        merged.push([mergedChunk, "rule"]);
        i = j;
        continue;
      }

      let j = i + 1;
      while (j < classified.length) {
        const [nextChunk, nextCls] = classified[j];
        if (nextCls === "prose" && _isClarification(nextChunk)) {
          chunk = _mergeTwoChunks(chunk, nextChunk);
          j++;
        } else if (
          nextCls === "rule" &&
          nextChunk.is_bullet &&
          !chunk.is_bullet &&
          !hasImperativeVerb(nextChunk.text) &&
          !hasConstraintKeyword(nextChunk.text)
        ) {
          chunk = _mergeTwoChunks(chunk, nextChunk);
          j++;
        } else {
          break;
        }
      }
      merged.push([chunk, "rule"]);
      i = j;
    } else {
      merged.push([chunk, cls]);
      i++;
    }
  }

  return merged;
}

function _isClarification(chunk) {
  const text = chunk.text;
  if (_CLARIFICATION_STARTERS.test(text)) return true;
  if (text.startsWith("```")) return true;
  return false;
}

function _mergeTwoChunks(ruleChunk, clarification) {
  return {
    lines: ruleChunk.lines.concat(clarification.lines),
    line_start: ruleChunk.line_start,
    line_end: clarification.line_end,
    text: ruleChunk.text + " " + clarification.text,
    is_bullet: Boolean(ruleChunk.is_bullet),
    section_heading: ruleChunk.section_heading,
  };
}

function splitCompoundRules(chunks) {
  const result = [];
  for (const [chunk, cls] of chunks) {
    if (cls !== "rule") {
      result.push([chunk, cls]);
      continue;
    }
    const parts = _trySplit(chunk);
    for (const part of parts) {
      result.push([part, "rule"]);
    }
  }
  return result;
}

function wouldFragment(text) {
  const fakeChunk = { text, lines: [], line_start: 0, line_end: 0, is_bullet: false };
  const parts = _trySplit(fakeChunk);
  return parts.map((p) => p.text);
}

function _trySplit(chunk) {
  const text = chunk.text;

  if (text.includes(";")) {
    const parts = text.split(";");
    if (parts.length >= 2 && parts.filter((p) => p.trim()).every((p) => _hasOwnVerb(p.trim()))) {
      return parts.filter((p) => p.trim()).map((p) => _makeSubchunk(chunk, p.trim()));
    }
  }

  const andParts = text.split(/,\s+and\s+|\s+and\s+/);
  if (andParts.length >= 2 && andParts.every((p) => _hasOwnVerb(p.trim()))) {
    if (!_isSingleProcess(text)) {
      if (andParts.slice(1).every((p) => _startsAsClause(p.trim()))) {
        return andParts.map((p) => _makeSubchunk(chunk, p.trim()));
      }
    }
  }

  return [chunk];
}

function _hasOwnVerb(text) {
  return hasImperativeVerb(text);
}

function _startsAsClause(text) {
  const t = text.trim().toLowerCase();
  for (const verb of _ALL_VERBS) {
    const v = verb.toLowerCase();
    if (t.startsWith(v) && (t.length === v.length || " ,.".includes(t[v.length]))) {
      return true;
    }
  }
  return false;
}

function _isSingleProcess(text) {
  const textLower = text.toLowerCase();
  const singleProcessPatterns = [
    /\b(?:edit|modify|change).*\band\b.*\b(?:regenerate|rebuild|recompile|restart)/,
    /\b(?:save|write).*\band\b.*\b(?:commit|push)/,
    /\b(?:create|add).*\band\b.*\b(?:register|configure|setup)/,
  ];
  for (const pat of singleProcessPatterns) {
    if (pat.test(textLower)) return true;
  }
  return false;
}

function _makeSubchunk(parent, text) {
  return {
    lines: parent.lines,
    line_start: parent.line_start,
    line_end: parent.line_end,
    text,
    is_bullet: Boolean(parent.is_bullet),
  };
}

// paths: is canonical per the docs (Rules and memory.md — "Path-specific rules").
// globs: is a tolerated legacy alias; paths: wins when both are present.
const _SCOPE_KEYS = new Set(["paths", "globs"]);

// Max recursion for @path imports, per the docs ("a maximum depth of four hops").
const _IMPORT_MAX_DEPTH = 4;

// @path imports inside CLAUDE.md. The docs allow relative (foo/bar.md and
// ./foo.md), home (~/...), and absolute paths. refs._AT_IMPORT only matches
// refs that begin with ~ . or /, so it misses bare relative imports like
// `@docs/git.md`; this pattern is broader on purpose. Code spans / fenced code
// blocks are stripped before this runs (the docs say import parsing skips them).
const _AT_IMPORT_PATTERN = /(?<![\w`])@([~\w./\\-]+)/g;

function _frontmatterLines(content) {
  const lines = content.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return [];
  const out = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return out;
    out.push(line);
  }
  return []; // unterminated frontmatter -> treat as none
}

function _normalizeGlobValue(raw) {
  raw = raw.trim();
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(",")) {
    const item = part.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
    if (item) out.push(item);
  }
  return out;
}

function parseScoping(content) {
  const fm = _frontmatterLines(content);
  if (!fm.length) return [];

  const results = {};
  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!m || !_SCOPE_KEYS.has(m[1])) {
      i++;
      continue;
    }

    const key = m[1];
    const inline = m[2].trim();
    const globs = [];

    if (inline) {
      let flow = inline;
      if (flow.startsWith("[") && flow.endsWith("]")) {
        flow = flow.slice(1, -1);
      }
      globs.push(..._normalizeGlobValue(flow));
      i++;
    } else {
      i++;
      while (i < fm.length) {
        const item = fm[i].match(/^\s*-\s*(.+?)\s*$/);
        if (!item) break;
        const val = item[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
        if (val) globs.push(val);
        i++;
      }
    }

    if (globs.length) results[key] = globs;
  }

  if (results.paths && results.paths.length) return results.paths;
  return results.globs || [];
}

function countGlobMatches(globs, projectRoot) {
  if (!globs.length) return 0;
  const fs = require("fs");
  const matched = new Set();
  for (const pattern of globs) {
    const pat = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!pat) continue;
    for (const p of _rglob(projectRoot, pat)) {
      let relParts;
      try {
        if (!fs.statSync(p).isFile()) continue;
        relParts = path.relative(projectRoot, p).split(path.sep).filter(Boolean);
      } catch {
        continue;
      }
      if (relParts.some((part) => PRUNE_DIRS.has(part))) continue;
      matched.add(p);
    }
  }
  return matched.size;
}

// ponytail: Path.rglob(pattern) has no direct Node stdlib equivalent; this
// walks the tree and matches each file's path against the glob pattern.
function _rglob(root, pattern) {
  const fs = require("fs");
  const regex = _globToRegex(pattern);
  const out = [];
  (function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const relPath = path.relative(root, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && regex.test(relPath)) {
        out.push(full);
      }
    }
  })(root);
  return out;
}

function _globToRegex(pattern) {
  // Supports Python Path.rglob semantics used here: ** matches across
  // directories, * matches within a segment, ? matches one char.
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp("(?:^|.*/)" + re + "$");
}

function _stripForImports(content) {
  const lines = content.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ""));
  }
  return out.join("\n");
}

function findImports(content) {
  const cleaned = _stripForImports(content);
  const seen = [];
  for (const m of cleaned.matchAll(_AT_IMPORT_PATTERN)) {
    const ref = m[1];
    if (ref && !seen.includes(ref)) seen.push(ref);
  }
  return seen;
}

function _resolveImport(ref, fileDir, projectRoot) {
  if (ref.startsWith("~/") || ref === "~") {
    return ref.length > 2 ? path.resolve(path.join(os.homedir(), ref.slice(2))) : os.homedir();
  }
  if (path.isAbsolute(ref)) return path.resolve(ref);
  return path.resolve(path.join(fileDir, ref));
}

function resolveImports(seedFiles, projectRoot) {
  const fs = require("fs");
  const imported = [];
  const unresolved = [];
  const visited = new Set();
  for (const sf of seedFiles) {
    try {
      visited.add(path.resolve(path.join(projectRoot, sf.path)));
    } catch {
      // ignore
    }
  }

  const queue = [];
  for (const sf of seedFiles) {
    if (sf.kind !== "claude_md") continue;
    const absPath = path.resolve(path.join(projectRoot, sf.path));
    queue.push([absPath, 0, sf.path]);
  }

  while (queue.length) {
    const [absPath, depth, importerRel] = queue.shift();
    if (depth >= _IMPORT_MAX_DEPTH) continue; // already at max hops; do not expand further
    const content = readText(absPath);
    if (!content) continue;
    for (const ref of findImports(content)) {
      const target = _resolveImport(ref, path.dirname(absPath), projectRoot);
      let exists = false;
      let isFile = false;
      try {
        exists = fs.existsSync(target);
        isFile = exists && fs.statSync(target).isFile();
      } catch {
        // ignore
      }
      if (!exists || !isFile) {
        unresolved.push({ ref, from: importerRel, resolved: target });
        continue;
      }
      if (visited.has(target)) continue; // cycle / already-included guard
      visited.add(target);
      const targetRel = rel(target, projectRoot);
      imported.push({
        path: targetRel,
        kind: "rules",
        default_category: "mandate",
        globs: [],
        always_loaded: true, // imports expand into context at launch
        glob_match_count: 0,
        scope: "imported",
        imported_from: importerRel,
        import_depth: depth + 1,
      });
      queue.push([target, depth + 1, targetRel]);
    }
  }

  return [imported, unresolved];
}

// Maps discover() artifact kinds to source_file entries
const _ARTIFACT_KINDS = ["claude_md", "rules", "agents", "skills", "commands"];

// CLAUDE.md scopes that load in full at launch (always-loaded). Nested
// (monorepo subpackage) CLAUDE.md load on demand, so they are NOT always-loaded.
const _ALWAYS_LOADED_CLAUDE_SCOPES = new Set(["project", "project-dot", "project-local", "user"]);

function _buildSourceFiles(artifacts, projectRoot) {
  const sourceFiles = [];
  for (const kind of _ARTIFACT_KINDS) {
    for (const entryItem of artifacts[kind] || []) {
      const sf = {
        path: entryItem.path,
        kind,
        default_category: "mandate",
      };
      if ("scope" in entryItem) sf.scope = entryItem.scope;

      if (kind === "rules") {
        const content = readText(path.join(projectRoot, entryItem.path));
        const globs = content ? parseScoping(content) : [];
        sf.globs = globs;
        sf.always_loaded = !globs.length;
        sf.glob_match_count = countGlobMatches(globs, projectRoot);
      } else if (kind === "claude_md") {
        const scope = entryItem.scope || "project";
        sf.globs = [];
        sf.always_loaded = _ALWAYS_LOADED_CLAUDE_SCOPES.has(scope);
      }

      sourceFiles.push(sf);
    }
  }
  return sourceFiles;
}

function _buildTooling(inventory) {
  const tooling = {};
  const hooks = inventory.hooks || {};
  const events = hooks.events || {};
  if (Object.keys(events).length) tooling.hooks = true;
  const mcp = inventory.mcp || {};
  if (mcp.servers && mcp.servers.length) tooling.mcp = true;
  return tooling;
}

function _buildProjectContext(inventory, sourceFiles) {
  const alwaysLoadedFiles = [];
  const globScopedFiles = [];
  for (const sf of sourceFiles) {
    const globs = sf.globs || [];
    if (globs.length && !sf.always_loaded) {
      globScopedFiles.push({ path: sf.path, globs });
    } else if (sf.always_loaded === undefined ? true : sf.always_loaded) {
      alwaysLoadedFiles.push(sf.path);
    }
  }
  return {
    stack: inventory.stack || [],
    always_loaded_files: alwaysLoadedFiles,
    glob_scoped_files: globScopedFiles,
    tooling: _buildTooling(inventory),
  };
}

function extractRules(projectRootArg) {
  const inventory = discover(projectRootArg);
  const projectRoot = path.resolve(inventory.project_root);

  const sourceFiles = _buildSourceFiles(inventory.artifacts, projectRoot);

  // Follow @path imports out of CLAUDE.md files (max depth 4, cycle-guarded).
  // Resolved imports become additional rule sources; unresolved ones are a
  // staleness signal surfaced under unresolved_imports.
  const [imported, unresolvedImports] = resolveImports(sourceFiles, projectRoot);
  sourceFiles.push(...imported);

  const projectContext = _buildProjectContext(inventory, sourceFiles);

  const allRules = [];
  let ruleCounter = 0;

  for (let fileIdx = 0; fileIdx < sourceFiles.length; fileIdx++) {
    const sf = sourceFiles[fileIdx];
    const absPath = path.join(projectRoot, sf.path);
    const content = readText(absPath);
    if (!content) continue;

    const [lines, annotations] = stripMetadata(content);
    const chunks = identifyChunks(lines);
    const merged = mergeClarifications(chunks);
    const split = splitCompoundRules(merged);

    for (const [chunk, cls] of split) {
      if (cls !== "rule") continue;

      ruleCounter++;
      const ruleId = "R" + String(ruleCounter).padStart(3, "0");
      const ruleText = chunk.text;

      let category = sf.default_category || "mandate";
      for (let lineNum = chunk.line_start - 2; lineNum < chunk.line_start; lineNum++) {
        if (lineNum in annotations) {
          category = annotations[lineNum];
          break;
        }
      }

      allRules.push({
        id: ruleId,
        file_index: fileIdx,
        text: ruleText,
        line_start: chunk.line_start,
        line_end: chunk.line_end,
        category,
        factors: {},
      });
    }
  }

  return {
    project_root: String(projectRoot),
    source_files: sourceFiles,
    rules: allRules,
    project_context: projectContext,
    unresolved_imports: unresolvedImports,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string", default: undefined },
    },
  });
  emit(extractRules(values["project-root"]));
}

if (require.main === module) {
  main();
}

module.exports = {
  stripMetadata,
  identifyChunks,
  classifyChunk,
  hasImperativeVerb,
  hasConstraintKeyword,
  mergeClarifications,
  splitCompoundRules,
  wouldFragment,
  parseScoping,
  countGlobMatches,
  findImports,
  resolveImports,
  extractRules,
};
