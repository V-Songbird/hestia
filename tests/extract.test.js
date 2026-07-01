'use strict';

// Tests for extract.js — instruction parser.
//
// hestia's extract.js takes --project-root and runs discover() internally,
// so tests create real temp dirs with CLAUDE.md files instead of piping
// project_context.json on stdin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runScript, FIXTURES_DIR } = require('./helpers');
const extract = require('../scripts/extract');

// ---------------------------------------------------------------------------
// Helper: create a temp project with CLAUDE.md content
// ---------------------------------------------------------------------------

function makeTmpPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hestia-extract-'));
}

/** Write content to CLAUDE.md in a fresh temp directory and return it. */
function makeProject(content, tmpPath) {
  const root = tmpPath || makeTmpPath();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), content, 'utf-8');
  return root;
}

/** Write a rule file at projectRoot/relPath, creating parent dirs. */
function makeRuleFile(projectRoot, relPath, content) {
  const p = path.join(projectRoot, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** Return the source_files entry whose path ends with pathSuffix. */
function sourceFor(result, pathSuffix) {
  const sf = result.source_files.find((s) => s.path.endsWith(pathSuffix));
  if (!sf) {
    throw new Error(
      `no source_file ending in ${JSON.stringify(pathSuffix)}: ${JSON.stringify(result.source_files.map((s) => s.path))}`
    );
  }
  return sf;
}

/** Run extract.js on a project root and return the parsed output. */
function runExtract(projectRoot) {
  return runScript('extract.js', undefined, ['--project-root', String(projectRoot)]);
}

// ---------------------------------------------------------------------------
// Basic extraction from a real temp directory
// ---------------------------------------------------------------------------

describe('BasicExtraction', () => {
  test('extracts rules from CLAUDE.md', () => {
    const root = makeProject('- ALWAYS validate user input.\n- Use strict mode.\n');
    const result = runExtract(root);
    assert.ok('rules' in result);
    assert.ok(result.rules.length >= 2);
  });

  test('output has source_files', () => {
    const root = makeProject('- Always test.\n');
    const result = runExtract(root);
    assert.ok('source_files' in result);
    assert.ok(result.source_files.length >= 1);
  });

  test('output has project_root', () => {
    const root = makeProject('- Always test.\n');
    const result = runExtract(root);
    assert.ok('project_root' in result);
  });

  test('rules have required fields', () => {
    const root = makeProject('- Always test.\n');
    const result = runExtract(root);
    const rule = result.rules[0];
    assert.ok('id' in rule);
    assert.ok('text' in rule);
    assert.ok('line_start' in rule);
    assert.ok('line_end' in rule);
    assert.ok('category' in rule);
    assert.ok('file_index' in rule);
    assert.ok('factors' in rule);
  });

  test('rule ids are sequential', () => {
    const root = makeProject('- Always validate.\n- Use strict mode.\n- Run tests.\n');
    const result = runExtract(root);
    const ids = result.rules.map((r) => r.id);
    assert.equal(ids[0], 'R001');
    assert.equal(ids[1], 'R002');
  });

  test('empty file no rules', () => {
    const root = makeProject('');
    const result = runExtract(root);
    assert.deepEqual(result.rules, []);
  });

  test('only prose no rules', () => {
    const content = 'This file provides guidance for the project.\nNote that background information follows.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.every((r) => !r.text.includes('This file provides')));
  });
});

// ---------------------------------------------------------------------------
// Sample project fixture (worked example)
// ---------------------------------------------------------------------------

const WORKED_EXAMPLE =
  '---\n' +
  'globs: "src/api/**/*.ts"\n' +
  'default-category: mandate\n' +
  '---\n' +
  '\n' +
  '# API Rules\n' +
  '\n' +
  '- Validate all request bodies at the handler boundary.\n' +
  '- Return consistent error shapes: `{ error: string, code: number }`.\n' +
  '  This ensures clients can parse errors uniformly.\n' +
  '- Use middleware for cross-cutting concerns (auth, logging) — not inline checks.\n' +
  '\n' +
  '## Database Access\n' +
  '\n' +
  '<!-- category: preference -->\n' +
  '- Prefer transactions for queries spanning multiple tables.\n' +
  '- Consider using read replicas for heavy read operations where latency is acceptable.\n' +
  '\n' +
  'The API layer uses Express with TypeScript strict mode enabled.\n';

describe('WorkedExample', () => {
  test('worked example rule count', () => {
    const root = makeProject(WORKED_EXAMPLE);
    const result = runExtract(root);
    assert.equal(result.rules.length, 5);
  });

  test('worked example rule texts', () => {
    const root = makeProject(WORKED_EXAMPLE);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('Validate all request bodies')));
    // Rule 2 should merge with clarification
    assert.ok(texts.some((t) => t.includes('Return consistent error shapes') && t.includes('clients can parse')));
    assert.ok(texts.some((t) => t.includes('Use middleware')));
    assert.ok(texts.some((t) => t.includes('Prefer transactions')));
    assert.ok(texts.some((t) => t.includes('Consider using read replicas')));
  });

  test('worked example prose excluded', () => {
    const root = makeProject(WORKED_EXAMPLE);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(!texts.some((t) => t.includes('The API layer uses Express')));
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('ExtractionDeterminism', () => {
  test('extraction determinism', () => {
    const root = makeProject('- ALWAYS use strict mode.\n- Prefer named exports.\n');
    const result1 = runExtract(root);
    const result2 = runExtract(root);
    assert.deepEqual(result1.rules, result2.rules);
  });
});

// ---------------------------------------------------------------------------
// Metadata stripping
// ---------------------------------------------------------------------------

describe('MetadataStripping', () => {
  test('frontmatter stripped', () => {
    const content = '---\nglobs: "src/**"\n---\n\n- Use strict mode.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 1);
    assert.ok(!result.rules[0].text.includes('globs'));
  });

  test('headings stripped', () => {
    const content = '# Rules\n\n- Use strict mode.\n\n## More\n\n- Always test.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(!result.rules.some((r) => r.text.includes('# Rules')));
    assert.ok(!result.rules.some((r) => r.text.includes('## More')));
  });

  test('fenced code block excluded', () => {
    const content =
      '- Use this RTK Query pattern:\n\n' +
      '```typescript\n' +
      "export const userApi = createApi({\n" +
      "  reducerPath: 'userApi',\n" +
      '});\n' +
      '```\n\n' +
      '- Always validate input.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('validate input')));
    assert.ok(!texts.some((t) => t.includes('createApi')));
    assert.ok(!texts.some((t) => t.includes('reducerPath')));
  });

  test('markdown table rows excluded', () => {
    const content =
      '## File naming\n\n' +
      '| Type | Convention |\n' +
      '|------|------------|\n' +
      '| Components | PascalCase.tsx |\n' +
      '| Hooks | useCamelCase.ts |\n\n' +
      '- Always validate user input.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('validate user input')));
    assert.ok(!texts.some((t) => t.includes('PascalCase')));
    assert.ok(!texts.some((t) => t.includes('useCamelCase')));
  });

  test('bare reference link excluded', () => {
    const content =
      '## References\n\n' +
      '- [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)\n' +
      '- [WCAG 2.2](https://www.w3.org/WAI/WCAG22/)\n' +
      '- Always check [the docs](./docs.md) before modifying the API.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(!texts.some((t) => t.includes('DESIGN_SYSTEM.md](./')));
    assert.ok(!texts.some((t) => t.includes('WCAG 2.2](')));
    assert.ok(texts.some((t) => t.includes('check') && t.includes('docs')));
  });

  test('horizontal rule excluded', () => {
    const content = '- Always test.\n\n---\n\n- Use strict mode.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const texts = result.rules.map((r) => r.text);
    assert.ok(!texts.some((t) => t.includes('---')));
    assert.ok(texts.some((t) => t.includes('Always test')));
    assert.ok(texts.some((t) => t.includes('strict mode')));
  });
});

// ---------------------------------------------------------------------------
// Compound split
// ---------------------------------------------------------------------------

describe('CompoundSplit', () => {
  test('compound split', () => {
    const content = '- Run tests before committing and ensure no warnings remain.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 2);
  });

  test('compound nosplit', () => {
    const content = '- Edit the .bnf source and regenerate.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 1);
  });

  test('noun list and-not split', () => {
    // "tables, bullets, and separators" is a noun list — the continuation
    // "separators when..." does not start with an imperative verb, so it
    // must not be treated as an independent clause.
    const content =
      "- Use tables, bullets, and separators when structure reduces " +
      "scanning effort. Don't impose it on a flat answer.\n";
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 1);
  });

  test('adverb prefixed clause still splits', () => {
    // "never" and "always" before a verb must still count as clause starts.
    const content = '- Validate all input and never trust client-supplied IDs.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Clarification merge
// ---------------------------------------------------------------------------

describe('ClarificationMerge', () => {
  test('clarification merge', () => {
    const content =
      '- Use TypeScript strict mode for all new files.\n' +
      '  This ensures type safety across the codebase.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 1);
    assert.ok(result.rules[0].text.includes('type safety'));
  });
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe('Categories', () => {
  test('category annotation', () => {
    const content = '<!-- category: preference -->\n- Prefer named exports over default exports.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules[0].category, 'preference');
  });

  test('default category is mandate', () => {
    const content = '- Always validate input.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules[0].category, 'mandate');
  });
});

// ---------------------------------------------------------------------------
// Architecture description bullets (prose filter)
// ---------------------------------------------------------------------------

describe('DescriptionBulletFilter', () => {
  test('architecture description bullets not extracted', () => {
    const content =
      '## Architecture\n' +
      '\n' +
      '- **src/primitives/** — Headless behavior hooks and state management\n' +
      '- **src/components/** — Visual components with Radix UI integration\n' +
      '- **src/tokens/** — Design tokens and theming\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const ruleTexts = result.rules.map((r) => r.text);
    assert.ok(!ruleTexts.some((t) => t.includes('primitives')));
    assert.ok(!ruleTexts.some((t) => t.includes('tokens')));
    assert.equal(result.rules.length, 0);
  });

  test('directive bullets still extracted', () => {
    const content =
      '## Architecture\n' +
      '\n' +
      '- **src/primitives/** — Headless behavior hooks\n' +
      '\n' +
      '## Rules\n' +
      '\n' +
      '- Use early returns over nested ifs.\n' +
      '- Never mutate props directly.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const ruleTexts = result.rules.map((r) => r.text);
    assert.ok(ruleTexts.some((t) => t.includes('early returns')));
    assert.ok(ruleTexts.some((t) => t.includes('mutate props')));
    assert.ok(!ruleTexts.some((t) => t.includes('primitives')));
  });

  test('bold description with verb stays rule', () => {
    const content = "- **Auth**: Always use `getAccessToken()` for silent refresh. Reset all state on 401.\n";
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.length >= 1);
    assert.ok(result.rules.some((r) => r.text.includes('Auth')));
  });
});

// ---------------------------------------------------------------------------
// Reader-addressing prose / navigation pointers
// ---------------------------------------------------------------------------

describe('NavigationPointerAndReaderProse', () => {
  test('reader addressing paragraphs not extracted', () => {
    const content =
      '# Game-logic rules\n' +
      '\n' +
      "These rules load when you're editing pure game logic.\n" +
      '\n' +
      'This file provides guidance to Claude Code when working with code in this repository.\n' +
      '\n' +
      'The following rules apply to every test file in tests/.\n' +
      '\n' +
      '- Always run `npm test` before committing.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const ruleTexts = result.rules.map((r) => r.text);
    assert.ok(!ruleTexts.some((t) => t.includes('These rules load when')));
    assert.ok(!ruleTexts.some((t) => t.includes('This file provides guidance')));
    assert.ok(!ruleTexts.some((t) => t.includes('The following rules apply')));
    assert.ok(ruleTexts.some((t) => t.includes('npm test')));
  });

  test('navigation pointer backtick md not extracted', () => {
    const content =
      '## Scoped rules\n' +
      '\n' +
      '- `.claude/rules/comments.md` — when to write comments\n' +
      '- `.claude/rules/naming.md` — naming conventions\n' +
      '- Always run `npm test` before committing.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const ruleTexts = result.rules.map((r) => r.text);
    assert.ok(!ruleTexts.some((t) => t.includes('comments.md')));
    assert.ok(!ruleTexts.some((t) => t.includes('naming.md')));
    assert.ok(ruleTexts.some((t) => t.includes('npm test')));
  });
});

// ---------------------------------------------------------------------------
// Heading-context propagation for orphaned bullets
// ---------------------------------------------------------------------------

describe('HeadingBulletMerge', () => {
  test('heading bullet list merged', () => {
    const content =
      '## When comments are NOT allowed\n' +
      '\n' +
      '- Restating the code\n' +
      '- Narrating sections\n' +
      '- Decorative banners\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.length <= 1);
  });

  test('merged text includes heading context', () => {
    const content =
      '## When comments are NOT allowed\n' +
      '\n' +
      '- Restating the code\n' +
      '- Narrating sections\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 1);
    assert.ok(result.rules[0].text.includes('When comments are NOT allowed'));
    assert.ok(result.rules[0].text.includes('Restating the code'));
  });

  test('heading with verb bullets stay standalone', () => {
    const content =
      '## Code style\n' +
      '\n' +
      '- Use early returns over nested ifs.\n' +
      "- Match the file's existing style.\n";
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.length >= 2);
  });

  test('different headings stay separate', () => {
    const content =
      '## Section A\n' +
      '\n' +
      '- Alpha item\n' +
      '- Beta item\n' +
      '\n' +
      '## Section B\n' +
      '\n' +
      '- Gamma item\n' +
      '- Delta item\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.equal(result.rules.length, 2);
    const texts = result.rules.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('Section A') && t.includes('Alpha')));
    assert.ok(texts.some((t) => t.includes('Section B') && t.includes('Gamma')));
  });

  test('mixed verb and verbless under heading', () => {
    const content =
      '## Error handling\n' +
      '\n' +
      '- Error messages sound like a person wrote them\n' +
      '- No catch-rethrow unless adding context\n' +
      '- Always log the original error before wrapping.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    const verbRules = result.rules.filter((r) => r.text.includes('Always log'));
    assert.equal(verbRules.length, 1);
    assert.equal(result.rules.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Directive bullet merge (Phase H pattern)
// ---------------------------------------------------------------------------

describe('DirectiveBulletMerge', () => {
  test('verbless bullets merged into parent directive', () => {
    const content = "These scream AI. Don't use them anywhere:\n- Synergy\n- Leverage\n- Innovative\n";
    const root = makeProject(content);
    const result = runExtract(root);
    const rules = result.rules;
    assert.equal(
      rules.length,
      1,
      `Expected 1 merged rule, got ${rules.length}: ${JSON.stringify(rules.map((r) => r.text.slice(0, 50)))}`
    );
    assert.ok(rules[0].text.includes("Don't use"));
    assert.ok(rules[0].text.includes('Synergy'));
  });

  test('verb bearing bullets stay standalone', () => {
    const content =
      'Write clean, readable code.\n' +
      '- Use early returns over nested ifs.\n' +
      '- Prefer flat objects over deep nesting.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.length >= 3);
  });
});

// ---------------------------------------------------------------------------
// Sample project fixture (end-to-end from disk)
// ---------------------------------------------------------------------------

describe('SampleProjectFixture', () => {
  const sampleProject = path.join(FIXTURES_DIR, 'sample_project');

  test('sample project extracts rules', () => {
    const result = runExtract(sampleProject);
    assert.ok(result.rules.length >= 4);
  });

  test('sample project has source_files', () => {
    const result = runExtract(sampleProject);
    const paths = result.source_files.map((sf) => sf.path);
    assert.ok(paths.some((p) => p.includes('CLAUDE.md')));
  });

  test('sample project has validate rule', () => {
    const result = runExtract(sampleProject);
    const texts = result.rules.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('validate user input')));
  });
});

// ---------------------------------------------------------------------------
// Non-BMP / Unicode content
// ---------------------------------------------------------------------------

describe('NonBMPContent', () => {
  test('non-bmp content extracted', () => {
    const src = path.join(FIXTURES_DIR, 'non_bmp_content', 'CLAUDE.md');
    const tmpPath = makeTmpPath();
    fs.copyFileSync(src, path.join(tmpPath, 'CLAUDE.md'));
    const result = runExtract(tmpPath);
    assert.ok(result.rules.length >= 1);
  });

  test('unicode arrows in text', () => {
    const content = '- Use → for flow arrows in documentation.\n';
    const root = makeProject(content);
    const result = runExtract(root);
    assert.ok(result.rules.length >= 1);
    assert.ok(result.rules[0].text.includes('→'));
  });
});

// ---------------------------------------------------------------------------
// parse_scoping: paths: (canonical), globs: (legacy alias), value forms
// ---------------------------------------------------------------------------

describe('ParseScoping', () => {
  test('imported module', () => {
    // parseScoping / findImports are importable directly (stdlib pipeline).
    assert.ok('parseScoping' in extract);
    assert.ok('findImports' in extract);
    assert.ok('countGlobMatches' in extract);
  });

  test('paths block list', () => {
    const fm = '---\npaths:\n  - "src/**/*.ts"\n  - "lib/**/*.ts"\n---\n# x\n';
    assert.deepEqual(extract.parseScoping(fm), ['src/**/*.ts', 'lib/**/*.ts']);
  });

  test('paths single string', () => {
    assert.deepEqual(extract.parseScoping('---\npaths: "src/api/**/*.ts"\n---\n'), ['src/api/**/*.ts']);
  });

  test('paths comma separated string', () => {
    assert.deepEqual(extract.parseScoping('---\npaths: "src/**, lib/**"\n---\n'), ['src/**', 'lib/**']);
  });

  test('paths flow list', () => {
    assert.deepEqual(extract.parseScoping('---\npaths: ["a/**", "b/**"]\n---\n'), ['a/**', 'b/**']);
  });

  test('globs legacy alias', () => {
    assert.deepEqual(extract.parseScoping('---\nglobs: "src/**/*.ts"\n---\n'), ['src/**/*.ts']);
  });

  test('paths wins over globs when both present', () => {
    const fm = '---\nglobs: "LEGACY/**"\npaths: "WINNER/**"\n---\n';
    assert.deepEqual(extract.parseScoping(fm), ['WINNER/**']);
  });

  test('no frontmatter returns empty', () => {
    assert.deepEqual(extract.parseScoping('# heading\n- a rule\n'), []);
  });

  test('unterminated frontmatter returns empty', () => {
    assert.deepEqual(extract.parseScoping('---\npaths: "x/**"\n# never closed\n'), []);
  });

  test('unrelated frontmatter key ignored', () => {
    assert.deepEqual(extract.parseScoping('---\ndefault-category: mandate\n---\n'), []);
  });
});

// ---------------------------------------------------------------------------
// always_loaded logic: scoped rule vs always-loaded rule vs nested CLAUDE.md
// ---------------------------------------------------------------------------

describe('AlwaysLoaded', () => {
  test('scoped rule not always loaded', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, '.claude/rules/api.md', '---\npaths: "src/api/**/*.ts"\n---\n- Validate with Zod.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'rules/api.md');
    assert.deepEqual(sf.globs, ['src/api/**/*.ts']);
    assert.equal(sf.always_loaded, false);
  });

  test('unscoped rule always loaded', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, '.claude/rules/style.md', '- Use 2-space indent.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'rules/style.md');
    assert.deepEqual(sf.globs, []);
    assert.equal(sf.always_loaded, true);
  });

  test('root CLAUDE.md always loaded', () => {
    const root = makeProject('# root\n- Always lint.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'CLAUDE.md');
    assert.equal(sf.scope, 'project');
    assert.equal(sf.always_loaded, true);
  });

  test('nested CLAUDE.md not always loaded', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, 'packages/api/CLAUDE.md', '# api\n- Use Knex.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'packages/api/CLAUDE.md');
    assert.equal(sf.scope, 'nested');
    assert.equal(sf.always_loaded, false);
  });
});

// ---------------------------------------------------------------------------
// glob_match_count
// ---------------------------------------------------------------------------

describe('GlobMatchCount', () => {
  test('counts matching files', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, 'src/api/a.ts', 'export const a = 1;\n');
    makeRuleFile(root, 'src/api/b.ts', 'export const b = 2;\n');
    makeRuleFile(root, '.claude/rules/api.md', '---\npaths: "src/api/**/*.ts"\n---\n- Validate with Zod.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'rules/api.md');
    assert.equal(sf.glob_match_count, 2);
  });

  test('dead glob counts zero', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, '.claude/rules/ghost.md', '---\npaths: "src/nonexistent/**/*.ts"\n---\n- Do something.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'rules/ghost.md');
    assert.equal(sf.glob_match_count, 0);
  });

  test('glob match prunes node_modules', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, 'node_modules/pkg/x.ts', 'x\n');
    makeRuleFile(root, 'src/x.ts', 'x\n');
    makeRuleFile(root, '.claude/rules/all.md', '---\npaths: "**/*.ts"\n---\n- Type everything.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'rules/all.md');
    // node_modules pruned -> only src/x.ts counts.
    assert.equal(sf.glob_match_count, 1);
  });
});

// ---------------------------------------------------------------------------
// F4 is live: scoped rule takes a glob branch, not the always-loaded fallback
// ---------------------------------------------------------------------------

describe('F4IsLive', () => {
  test('scoped rule drives glob branch', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, 'src/api/handler.ts', 'export const x = 1;\n');
    makeRuleFile(
      root,
      '.claude/rules/api.md',
      '---\npaths: "src/api/**/*.ts"\n---\n' + '- Validate all request bodies with Zod at the API boundary.\n'
    );
    const extracted = runExtract(root);
    const scored = runScript('score_mechanical.js', extracted);
    const scoped = scored.rules.find((r) => r.text.includes('Zod'));
    const f4 = scoped.factors.F4;
    // The glob branch, NOT the always-loaded fallback.
    assert.equal(f4.loading, 'glob-scoped');
    assert.notEqual(f4.method, 'always_universal');
  });
});

// ---------------------------------------------------------------------------
// @-import resolution: following, depth cap, cycles, unresolved
// ---------------------------------------------------------------------------

describe('Imports', () => {
  test('relative import followed', () => {
    const root = makeProject('# root\n- Lint.\nSee @docs/a.md\n');
    makeRuleFile(root, 'docs/a.md', '- Use 2-space indent.\n');
    const result = runExtract(root);
    const sf = sourceFor(result, 'docs/a.md');
    assert.ok(sf.imported_from.endsWith('CLAUDE.md'));
    assert.equal(sf.import_depth, 1);
    assert.equal(sf.always_loaded, true);
    // Its rules are extracted too.
    assert.ok(result.rules.some((r) => r.text.includes('2-space indent')));
  });

  test('literal backtick import not followed', () => {
    const root = makeProject('# root\n- Lint.\nMention `@README` literally.\n');
    makeRuleFile(root, 'README', '- Should not be imported.\n');
    const result = runExtract(root);
    const paths = result.source_files.map((sf) => sf.path);
    assert.ok(!paths.some((p) => p.endsWith('README')));
    assert.deepEqual(result.unresolved_imports, []);
  });

  test('fenced code import not followed', () => {
    const content = '# root\n- Lint.\n\n```\n@infence.md\n```\n';
    const root = makeProject(content);
    makeRuleFile(root, 'infence.md', '- Should not be imported.\n');
    const result = runExtract(root);
    const paths = result.source_files.map((sf) => sf.path);
    assert.ok(!paths.some((p) => p.endsWith('infence.md')));
  });

  test('import depth cap at four', () => {
    const root = makeProject('# root\n@l1.md\n');
    makeRuleFile(root, 'l1.md', '@l2.md\n- r1\n');
    makeRuleFile(root, 'l2.md', '@l3.md\n- r2\n');
    makeRuleFile(root, 'l3.md', '@l4.md\n- r3\n');
    makeRuleFile(root, 'l4.md', '@l5.md\n- r4\n');
    makeRuleFile(root, 'l5.md', '- r5 at depth 5\n');
    const result = runExtract(root);
    const paths = result.source_files.map((sf) => sf.path);
    assert.ok(paths.some((p) => p === 'l4.md')); // depth 4 loads
    assert.ok(!paths.some((p) => p === 'l5.md')); // depth 5 does not
  });

  test('import cycle guarded', () => {
    const root = makeProject('# root\n@a.md\n');
    makeRuleFile(root, 'a.md', '@b.md\n- ra\n');
    makeRuleFile(root, 'b.md', '@a.md\n- rb\n');
    const result = runExtract(root);
    // a.md appears once (cycle does not re-add it), b.md once.
    const aCount = result.source_files.filter((sf) => sf.path === 'a.md').length;
    const bCount = result.source_files.filter((sf) => sf.path === 'b.md').length;
    assert.equal(aCount, 1);
    assert.equal(bCount, 1);
  });

  test('unresolved import surfaced not crash', () => {
    const root = makeProject('# root\n- Lint.\nSee @docs/missing.md\n');
    const result = runExtract(root);
    const refs = result.unresolved_imports.map((u) => u.ref);
    assert.ok(refs.includes('docs/missing.md'));
  });
});

// ---------------------------------------------------------------------------
// project_context population
// ---------------------------------------------------------------------------

describe('ProjectContext', () => {
  test('project_context present', () => {
    const root = makeProject('# root\n- Always lint.\n');
    const result = runExtract(root);
    assert.ok('project_context' in result);
    const ctx = result.project_context;
    for (const key of ['stack', 'always_loaded_files', 'glob_scoped_files', 'tooling']) {
      assert.ok(key in ctx);
    }
  });

  test('project_context splits always and glob', () => {
    const root = makeProject('# root\n- Always lint.\n');
    makeRuleFile(root, 'src/api/h.ts', 'x\n');
    makeRuleFile(root, '.claude/rules/api.md', '---\npaths: "src/api/**/*.ts"\n---\n- Validate.\n');
    makeRuleFile(root, '.claude/rules/style.md', '- Use 2-space indent.\n');
    const ctx = runExtract(root).project_context;
    assert.ok(ctx.always_loaded_files.includes('CLAUDE.md'));
    assert.ok(ctx.always_loaded_files.some((p) => p.endsWith('rules/style.md')));
    const globPaths = ctx.glob_scoped_files.map((gf) => gf.path);
    assert.ok(globPaths.some((p) => p.endsWith('rules/api.md')));
    assert.ok(ctx.glob_scoped_files.every((gf) => 'globs' in gf));
  });

  test('project_context stack from discover', () => {
    const root = makeProject('# root\n- Always lint.\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf-8');
    const ctx = runExtract(root).project_context;
    assert.ok(ctx.stack.includes('node'));
  });

  test('project_context tooling empty when none', () => {
    const root = makeProject('# root\n- Always lint.\n');
    const ctx = runExtract(root).project_context;
    assert.deepEqual(ctx.tooling, {});
  });

  test('project_context tooling detects hooks', () => {
    const root = makeProject('# root\n- Always lint.\n');
    const settings = '{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": []}]}}';
    makeRuleFile(root, '.claude/settings.json', settings);
    const ctx = runExtract(root).project_context;
    assert.equal(ctx.tooling.hooks, true);
  });
});
