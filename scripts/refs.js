"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const BACKTICK = /`([^`\n]+)`/g;
const AT_IMPORT = /(?<!\w)@([~./][\w./-]+)/g;
const MD_LINK = /\]\((\.{0,2}\/[^)\s]+)\)/g;
const EXT = /\.[A-Za-z0-9]{1,8}$/;
const SKIP = ["http://", "https://", "://", "${", "*", " ", "\t", "<", ">"];
const DIR_PREFIXES = ["./", "../", "~/", ".claude/"];

function looksLikePath(tok) {
  const t = tok.trim();
  if (!t || SKIP.some((s) => t.includes(s))) return false;
  if (t.startsWith("...")) return false;
  if (DIR_PREFIXES.some((p) => t.startsWith(p))) return true;
  return t.includes("/") && EXT.test(t);
}

function extractRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(BACKTICK)) {
    const tok = m[1].trim();
    if (looksLikePath(tok)) refs.add(tok);
  }
  for (const m of text.matchAll(AT_IMPORT)) {
    refs.add("@" + m[1]);
  }
  for (const m of text.matchAll(MD_LINK)) {
    const tok = m[1].trim();
    if (!["http://", "https://", "${", "<", ">"].some((s) => tok.includes(s))) {
      refs.add(tok);
    }
  }
  return Array.from(refs).sort();
}

const LINE_SUFFIX = /:\d+$/;

function resolveRef(ref, fileDir, root) {
  let r = ref.startsWith("@") ? ref.slice(1) : ref;
  r = r.split("#", 1)[0];
  r = r.replace(LINE_SUFFIX, "");
  if (r.startsWith("~/")) {
    return path.join(os.homedir(), r.slice(2));
  }
  if (r.startsWith("./") || r.startsWith("../")) {
    const p = path.resolve(fileDir, r);
    if (fs.existsSync(p) || !r.startsWith("./")) return p;
    return path.resolve(root, r.slice(2));
  }
  const p = path.resolve(root, r);
  if (fs.existsSync(p)) return p;
  return path.resolve(fileDir, r);
}

function brokenRefs(filePath, root) {
  filePath = path.resolve(filePath);
  root = path.resolve(root);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const ref of extractRefs(text)) {
    const bare = ref.split("#", 1)[0];
    if (!bare || [".", "./", "~/"].includes(bare)) continue;
    if (!fs.existsSync(resolveRef(ref, path.dirname(filePath), root))) {
      out.push(ref);
    }
  }
  return out;
}

module.exports = {
  extractRefs,
  resolveRef,
  brokenRefs,
};
