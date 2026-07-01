'use strict';

// Shared fixtures and helpers for hestia tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function buildStdin(stdinData) {
  if (stdinData === null || stdinData === undefined) return undefined;
  if (typeof stdinData === 'string') return stdinData;
  return JSON.stringify(stdinData);
}

/**
 * Run a script from scripts/ and return its parsed JSON stdout.
 * Throws if the script exits non-zero or stdout isn't valid JSON.
 */
function runScript(name, stdinData, args) {
  const result = runScriptRaw(name, stdinData, args);
  if (result.status !== 0) {
    const err = new Error(`${name} exited ${result.status}\n${result.stderr}`);
    err.result = result;
    throw err;
  }
  return JSON.parse(result.stdout);
}

/** Run a script and return the raw spawnSync result (for testing failures). */
function runScriptRaw(name, stdinData, args) {
  const cmd = [path.join(SCRIPTS_DIR, name), ...(args || [])];
  return spawnSync('node', cmd, {
    input: buildStdin(stdinData),
    encoding: 'utf-8',
    timeout: 30000,
    env: process.env,
  });
}

/** Load a fixture file. .json files are parsed; others returned as a string. */
function loadFixture(name) {
  const filePath = path.join(FIXTURES_DIR, name);
  const text = fs.readFileSync(filePath, 'utf-8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

/** Create a temp copy of the sample_project fixture tree; returns its path. */
function makeSampleProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-sample-'));
  const dst = path.join(tmpDir, 'sample_project');
  fs.cpSync(path.join(FIXTURES_DIR, 'sample_project'), dst, { recursive: true });
  return dst;
}

/** Create a fresh empty temp directory usable as a project root. */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-project-'));
  const project = path.join(tmpDir, 'project');
  fs.mkdirSync(project);
  return project;
}

module.exports = {
  runScript,
  runScriptRaw,
  loadFixture,
  makeSampleProject,
  makeTmpProject,
  FIXTURES_DIR,
};
