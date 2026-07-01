'use strict';

// Tests for score_mechanical.js — F1 (verb strength), F2 (framing polarity),
// F4 (load-trigger alignment), F7 (concreteness).
//
// hestia's score_mechanical.js reads a JSON payload from stdin with
// {source_files, rules} and emits the same payload with factors populated.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./helpers');

function scoreRule(text, { globs, alwaysLoaded = true, globMatchCount, staleness } = {}) {
  const rule = {
    id: 'R001',
    file_index: 0,
    text,
    line_start: 1,
    line_end: 1,
    category: 'mandate',
    staleness: staleness || { gated: false, missing_entities: [] },
    factors: {},
  };
  const data = {
    source_files: [
      {
        path: 'test.md',
        globs: globs || [],
        glob_match_count: globMatchCount === undefined ? null : globMatchCount,
        default_category: 'mandate',
        line_count: 10,
        always_loaded: alwaysLoaded,
      },
    ],
    rules: [rule],
  };
  const result = runScript('score_mechanical.js', data);
  return result.rules[0];
}

// ---------------------------------------------------------------------------
// F1: Verb Strength
// ---------------------------------------------------------------------------

describe('F1 worked examples', () => {
  const cases = [
    ['ALWAYS use project-aware methods for command database access', 1.00],
    ['NEVER edit files in src/main/gen/ directly', 0.95],
    ['Use functional components for all new React files', 0.85],
    ['Each test file must import from the module it tests', 1.00],
    ['Prefer named exports over default exports', 0.50],
    ['Use good judgment about error handling', 0.85],
    ['Try to prefer functional components when possible', 0.20],
  ];

  for (const [text, expectedScore] of cases) {
    it(`f1 worked example: ${text}`, () => {
      const rule = scoreRule(text);
      const f1 = rule.factors.F1;
      assert.equal(f1.value, expectedScore,
        `F1 for '${text.slice(0, 50)}' expected ${expectedScore}, got ${f1.value}`);
    });
  }

  it('compound hedging', () => {
    const rule = scoreRule('Try to prefer functional components when possible');
    assert.equal(rule.factors.F1.value, 0.20);
    assert.equal(rule.factors.F1.method, 'lookup');
  });

  it('implicit verb', () => {
    const rule = scoreRule('Test files mirror source paths');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('extraction failure', () => {
    const rule = scoreRule('Stack: generic, TypeScript');
    const f1 = rule.factors.F1;
    assert.ok(['implicit_imperative_default', 'extraction_failed'].includes(f1.method));
  });

  it('method field present', () => {
    const rule = scoreRule('Use functional components');
    assert.ok('method' in rule.factors.F1);
  });

  it('matched_verb field present', () => {
    const rule = scoreRule('Use functional components');
    assert.ok('matched_verb' in rule.factors.F1);
    assert.equal(rule.factors.F1.matched_verb, 'use');
  });
});

// ---------------------------------------------------------------------------
// F1: 'always' dual-tier
// ---------------------------------------------------------------------------

describe('F1 always regression', () => {
  it('always without imperative', () => {
    const rule = scoreRule('Always be careful when refactoring');
    assert.equal(rule.factors.F1.value, 0.70);
    assert.equal(rule.factors.F1.matched_verb, 'always');
  });

  it('always with imperative', () => {
    const rule = scoreRule('Always use consistent naming conventions');
    assert.equal(rule.factors.F1.value, 1.00);
    assert.ok(rule.factors.F1.matched_verb.includes('always + use'));
  });

  it('always alone', () => {
    const rule = scoreRule('Always.');
    assert.equal(rule.factors.F1.value, 0.70);
  });
});

// ---------------------------------------------------------------------------
// F1: Noun-verb ambiguity
// ---------------------------------------------------------------------------

describe('F1 noun-verb ambiguity', () => {
  it('document noun not verb', () => {
    const rule = scoreRule('Document headers must be at the top');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 1.00);
    assert.equal(f1.matched_verb, 'must');
  });

  it('format noun not verb', () => {
    const rule = scoreRule('Format strings should use f-strings');
    const f1 = rule.factors.F1;
    assert.ok(f1.value <= 0.70);
  });

  it('log noun not verb', () => {
    const rule = scoreRule('Log entries for failed requests');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('name noun not verb', () => {
    const rule = scoreRule('Name conventions for exported types');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('set the is imperative', () => {
    const rule = scoreRule('Set the timeout to 30 seconds');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'set');
  });

  it('document the is imperative', () => {
    const rule = scoreRule('Document the API endpoints');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'document');
  });

  it('check the is imperative', () => {
    const rule = scoreRule('Check the logs before deploying');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'check');
  });

  it('test the is imperative', () => {
    const rule = scoreRule('Test the function with edge cases');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'test');
  });

  it('test code is noun phrase', () => {
    const rule = scoreRule('Test code is reviewed regularly');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('test coverage is noun phrase', () => {
    const rule = scoreRule('Test coverage should exceed 80%');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
  });

  it('test runs is noun phrase', () => {
    const rule = scoreRule('Test runs trigger CI builds');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('batch as noun', () => {
    const rule = scoreRule('Batch operations should be atomic.');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });

  it('matched_position reported', () => {
    const rule = scoreRule('Use functional components for all new React files');
    const f1 = rule.factors.F1;
    assert.ok('matched_position' in f1);
    assert.equal(typeof f1.matched_position, 'number');
    assert.ok(Number.isInteger(f1.matched_position));
  });

  it('matched_position none for implicit', () => {
    const rule = scoreRule('Test files mirror source paths');
    const f1 = rule.factors.F1;
    assert.equal(f1.matched_position, null);
  });

  it('matched_position points at verb', () => {
    const rule = scoreRule('ALWAYS use consistent naming conventions');
    const f1 = rule.factors.F1;
    const text = 'always use consistent naming conventions';
    const expectedPos = text.indexOf('use');
    assert.equal(f1.matched_position, expectedPos);
  });
});

// ---------------------------------------------------------------------------
// F1: Verb list expansion
// ---------------------------------------------------------------------------

describe('verb list expansion', () => {
  const cases = [
    ['Reset all state on 401 responses.', 'reset'],
    ['Revert changes if validation fails.', 'revert'],
    ['Avoid circular dependencies.', 'avoid'],
    ['Enforce strict mode in all modules.', 'enforce'],
    ['Sanitize all user input before processing.', 'sanitize'],
    ['Normalize paths before comparison.', 'normalize'],
    ['Optimize images before deployment.', 'optimize'],
    ['Lint all files before committing.', 'lint'],
    ['Encrypt sensitive data at rest.', 'encrypt'],
    ['Retry failed requests up to 3 times.', 'retry'],
    ['Abort requests after 30 seconds.', 'abort'],
    ['Throttle API requests to 100/s.', 'throttle'],
    ['Debounce search input by 300ms.', 'debounce'],
    ['Generate API docs from annotations.', 'generate'],
    ['Execute migrations in a transaction.', 'execute'],
    ['Invoke callbacks asynchronously.', 'invoke'],
    ['Scaffold new services with the template.', 'scaffold'],
    ['Bootstrap the app with environment config.', 'bootstrap'],
    ['Authenticate users via OAuth2.', 'authenticate'],
    ['Authorize access with role-based permissions.', 'authorize'],
  ];

  for (const [text, verb] of cases) {
    it(`new verb recognized: ${verb}`, () => {
      const rule = scoreRule(text);
      const f1 = rule.factors.F1;
      assert.equal(f1.value, 0.85,
        `'${verb}' should score 0.85 but got ${f1.value} (method=${f1.method})`);
      assert.equal(f1.matched_verb, verb);
    });
  }

  it('cache as verb', () => {
    const rule = scoreRule('Cache responses for 5 minutes.');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'cache');
  });

  it('cache as noun', () => {
    const rule = scoreRule('Cache entries must be invalidated after writes.');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 1.00);
    assert.equal(f1.matched_verb, 'must');
  });

  it('scope as verb', () => {
    const rule = scoreRule('Scope CSS to component boundaries.');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.85);
    assert.equal(f1.matched_verb, 'scope');
  });

  it('scope as noun', () => {
    const rule = scoreRule('Scope variables should be minimized.');
    const f1 = rule.factors.F1;
    assert.equal(f1.value, 0.70);
    assert.equal(f1.method, 'implicit_imperative_default');
  });
});

// ---------------------------------------------------------------------------
// F2: Framing Polarity
// ---------------------------------------------------------------------------

describe('F2 worked examples', () => {
  const cases = [
    ['ALWAYS use project-aware methods: `getProjectCommands(project)` not `.database.commands`', 0.95],
    ['Use CachedValuesManager for expensive computations', 0.85],
    ['NEVER edit files in src/main/gen/ directly. Edit the .bnf/.flex source and regenerate.', 0.70],
    ['NEVER edit files in src/main/gen/ directly.', 0.50],
    ['Prefer named exports over default exports', 0.35],
    ['Try to prefer functional components when possible', 0.35],
  ];

  for (const [text, expectedScore] of cases) {
    it(`f2 worked example: ${text}`, () => {
      const rule = scoreRule(text);
      assert.equal(rule.factors.F2.value, expectedScore,
        `F2 for '${text.slice(0, 50)}' expected ${expectedScore}, got ${rule.factors.F2.value}`);
    });
  }

  it('prohibition with alternative', () => {
    const rule = scoreRule('NEVER edit files in src/main/gen/ directly. Edit the .bnf/.flex source and regenerate.');
    assert.equal(rule.factors.F2.value, 0.70);
    assert.equal(rule.factors.F2.matched_category, 'positive_with_negative_clarification');
  });

  it('method field present', () => {
    const rule = scoreRule('Use strict mode');
    assert.ok('method' in rule.factors.F2);
  });

  it('matched_category present', () => {
    const rule = scoreRule('Use strict mode');
    assert.ok('matched_category' in rule.factors.F2);
  });
});

// ---------------------------------------------------------------------------
// F2: Contrast-not disambiguation
// ---------------------------------------------------------------------------

describe('F2 contrast-not regression', () => {
  it('negation not gerund', () => {
    const rule = scoreRule('Functions should be pure, not depending on global state');
    assert.equal(rule.factors.F2.value, 0.85);
    assert.equal(rule.factors.F2.matched_category, 'positive_imperative');
  });

  it('contrast not nouns', () => {
    const rule = scoreRule('Use lists, not tuples');
    assert.equal(rule.factors.F2.value, 0.95);
  });

  it('contrast not backticks', () => {
    const rule = scoreRule('Use `getProjectCommands` not `.database`');
    assert.equal(rule.factors.F2.value, 0.95);
  });

  it('contrast not adjectives', () => {
    const rule = scoreRule('Functions should be pure, not stateful');
    assert.equal(rule.factors.F2.value, 0.95);
  });

  it('instead of unchanged', () => {
    const rule = scoreRule('Use forEach instead of for loops');
    assert.equal(rule.factors.F2.value, 0.95);
  });

  it('rather than unchanged', () => {
    const rule = scoreRule('Use async/await rather than raw promises');
    assert.equal(rule.factors.F2.value, 0.95);
  });
});

// ---------------------------------------------------------------------------
// F4: Load-Trigger Alignment
// ---------------------------------------------------------------------------

describe('F4 worked examples', () => {
  it('always loaded universal', () => {
    const rule = scoreRule('Use TypeScript strict mode');
    assert.ok(rule.factors.F4.value >= 0.90);
    assert.equal(rule.factors.F4.method, 'always_universal');
  });

  it('always loaded specific trigger', () => {
    const rule = scoreRule('When editing API files, validate with Zod');
    assert.ok(rule.factors.F4.value <= 0.50);
    assert.equal(rule.factors.F4.method, 'misaligned');
  });

  it('dead glob', () => {
    const rule = scoreRule('Use strict mode', {
      globs: ['src/nonexistent/**'],
      alwaysLoaded: false,
      globMatchCount: 0,
    });
    assert.equal(rule.factors.F4.value, 0.05);
  });

  it('glob matches trigger', () => {
    const rule = scoreRule('Use Zod for API validation', {
      globs: ['src/api/**/*.ts'],
      alwaysLoaded: false,
      globMatchCount: 5,
    });
    assert.ok(rule.factors.F4.value >= 0.85);
  });

  it('keyword overlap', () => {
    const rule = scoreRule('Use Zod for API validation', {
      globs: ['src/api/**/*.ts'],
      alwaysLoaded: false,
      globMatchCount: 5,
    });
    assert.ok(rule.factors.F4.value >= 0.85);
  });

  it('no overlap implicit scope trust', () => {
    const rule = scoreRule('All public functions must be documented with TSDoc', {
      globs: ['src/api/**/*.ts'],
      alwaysLoaded: false,
      globMatchCount: 5,
    });
    const f4 = rule.factors.F4;
    assert.ok(f4.value >= 0.80);
    assert.equal(f4.method, 'keyword_overlap');
    assert.equal(f4.loading, 'glob-scoped');
    assert.equal(f4.trigger_match, 'implicit_scope_trust');
  });

  it('stale', () => {
    const rule = scoreRule('Run tests for `src/legacy/auth.js`', {
      staleness: { gated: true, missing_entities: ['src/legacy/auth.js'] },
    });
    assert.equal(rule.factors.F4.value, 0.05);
  });

  it('fallback labels', () => {
    const rule = scoreRule('Some rule text', {
      globs: [],
      alwaysLoaded: false,
      globMatchCount: null,
    });
    const f4 = rule.factors.F4;
    assert.equal(f4.method, 'no_signal');
    assert.equal(f4.loading, 'ambiguous');
    assert.equal(f4.value, 0.65);
  });

  it('concise rule not penalized', () => {
    const sourceFileSpec = {
      globs: ['packages/**/*.ts', 'packages/**/*.tsx'],
      alwaysLoaded: false,
      globMatchCount: 10,
    };
    const redundant = scoreRule(
      'When writing TypeScript in packages/ui, add a single-line comment ' +
      'explaining the business reason when logic cannot be inferred.',
      sourceFileSpec,
    );
    const concise = scoreRule(
      'When business logic cannot be inferred from identifiers alone, ' +
      'add a single-line comment explaining the business reason.',
      sourceFileSpec,
    );
    assert.ok(concise.factors.F4.value >= 0.80);
    assert.ok(redundant.factors.F4.value >= 0.80);
    const delta = Math.abs(concise.factors.F4.value - redundant.factors.F4.value);
    assert.ok(delta <= 0.10);
  });
});

// ---------------------------------------------------------------------------
// F7: Concreteness
// ---------------------------------------------------------------------------

describe('F7 worked examples', () => {
  const cases = [
    ['ALWAYS use `getProjectCommands(project)` not `.database.commands`', 0.95, 0.15],
    ['Use functional components for all new React files', 0.85, 0.15],
    ['NEVER edit files in src/main/gen/ directly', 0.85, 0.15],
    ['Use CachedValuesManager for expensive computations over PSI trees', 0.70, 0.15],
    ['Use good judgment about error handling', 0.05, 0.15],
  ];

  for (const [text, expectedScore, tolerance] of cases) {
    it(`f7 worked example: ${text}`, () => {
      const rule = scoreRule(text);
      const f7 = rule.factors.F7;
      assert.ok(Math.abs(f7.value - expectedScore) <= tolerance,
        `F7 for '${text.slice(0, 50)}' expected ~${expectedScore}, got ${f7.value} ` +
        `(C=${f7.concrete_count},A=${f7.abstract_count})`);
    });
  }

  it('concrete markers present', () => {
    const rule = scoreRule('Use `getProjectCommands(project)` not `.database.commands`');
    const f7 = rule.factors.F7;
    assert.ok(f7.concrete_count >= 2);
    assert.ok('concrete_markers' in f7);
  });

  it('abstract markers present', () => {
    const rule = scoreRule('Use good judgment about error handling');
    const f7 = rule.factors.F7;
    assert.ok(f7.abstract_count >= 2);
    assert.ok('abstract_markers' in f7);
  });

  it('no markers scores low', () => {
    const rule = scoreRule('Do the right thing here.');
    const f7 = rule.factors.F7;
    assert.ok(f7.value <= 0.20);
  });
});

describe('F7 numeric thresholds', () => {
  const cases = [
    ['Keep PR titles under 70 characters.', 'under 70 characters'],
    ['Summaries must be fewer than 15 words.', 'fewer than 15 words'],
    ['Include at least 3 examples per rule.', 'at least 3 examples'],
    ['Allow no more than 20 entries in a list.', 'no more than 20 entries'],
    ['Response time budget: 100ms.', '100ms'],
    ['Stall warnings fire after 5 seconds.', '5 seconds'],
    ['Coverage must be at least 80%.', 'at least 80%'],
  ];

  for (const [text, expectedPhrase] of cases) {
    it(`numeric phrase detected: ${expectedPhrase}`, () => {
      const rule = scoreRule(text);
      const f7 = rule.factors.F7;
      const markersLower = f7.concrete_markers.map((m) => m.toLowerCase());
      assert.ok(markersLower.some((m) => m.includes(expectedPhrase.toLowerCase())),
        `Expected '${expectedPhrase}' among markers, got ${f7.concrete_markers}`);
    });
  }

  it('numeric threshold lifts F7 over adjective', () => {
    const sharp = scoreRule('Keep PR titles under 70 characters.');
    const fuzzy = scoreRule('Keep PR titles short.');
    assert.ok(sharp.factors.F7.value > fuzzy.factors.F7.value);
  });

  it('case insensitive match', () => {
    const rule = scoreRule('Keep titles Under 70 Characters.');
    const f7 = rule.factors.F7;
    const markersLower = f7.concrete_markers.map((m) => m.toLowerCase());
    assert.ok(markersLower.some((m) => m.includes('70 characters')));
  });

  it('version number not a threshold', () => {
    // "Node 18" has a number but no unit — should not match as threshold.
    const rule = scoreRule('Use Node 18 for production.');
    const f7 = rule.factors.F7;
    const markers = f7.concrete_markers;
    const thresholdRe = /^.*\d.*(ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|%|kb|mb|gb|bytes?|chars?|characters?|words?|lines?|items?|entries|rows?).*$/i;
    const hasThreshold = markers.some((m) => thresholdRe.test(m));
    assert.ok(!hasThreshold, `Version number incorrectly matched threshold: ${markers}`);
  });
});

describe('F7 confidence flag', () => {
  it('mixed concrete/abstract flagged', () => {
    const rule = scoreRule('Try to prefer functional components when possible');
    const f7 = rule.factors.F7;
    assert.ok(f7.concrete_count >= 1);
    assert.ok(f7.abstract_count >= 1);
    const flags = rule.factor_confidence_low || [];
    assert.ok(flags.includes('F7'), 'Mixed concrete/abstract should flag F7 for judgment');
  });

  it('no flag for clearly concrete', () => {
    const rule = scoreRule('Use `getProjectCommands(project)` not `.database.commands`');
    const f7 = rule.factors.F7;
    if (f7.abstract_count === 0) {
      const flags = rule.factor_confidence_low || [];
      assert.ok(!flags.includes('F7'));
    }
    // If abstract markers also found, flagging is acceptable
  });

  it('marker counting concrete', () => {
    const rule = scoreRule('Use `getProjectCommands(project)` not `.database.commands`');
    const f7 = rule.factors.F7;
    assert.ok(f7.concrete_count >= 2);
  });

  it('marker counting abstract', () => {
    const rule = scoreRule('Use good judgment about error handling');
    const f7 = rule.factors.F7;
    assert.ok(f7.abstract_count >= 2);
    assert.ok(
      f7.abstract_markers.includes('good') ||
      f7.abstract_markers.some((m) => m.toLowerCase().includes('error')),
    );
  });

  it('domain terms detected', () => {
    const rule = scoreRule('Use functional components for all new React files');
    const f7 = rule.factors.F7;
    const concreteNames = f7.concrete_markers.map((n) => n.toLowerCase());
    assert.ok(concreteNames.some((n) => n.includes('functional component')));
  });

  it('has all required keys', () => {
    const rule = scoreRule('Use `React.memo` for expensive components');
    const f7 = rule.factors.F7;
    assert.ok('value' in f7);
    assert.ok('method' in f7);
    assert.ok('concrete_markers' in f7);
    assert.ok('abstract_markers' in f7);
    assert.ok('concrete_count' in f7);
    assert.ok('abstract_count' in f7);
  });

  it('value in range', () => {
    const rule = scoreRule('Use strict TypeScript');
    const f7 = rule.factors.F7;
    assert.ok(f7.value >= 0.0 && f7.value <= 1.0);
  });

  it('no separate F6', () => {
    // F6 is absorbed into F7; pipeline does not add a separate F6.
    const rule = scoreRule('Use `React.memo` for expensive components');
    assert.ok(!('F6' in rule.factors));
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration
// ---------------------------------------------------------------------------

describe('pipeline integration', () => {
  it('all four factors added', () => {
    const rule = scoreRule('Use `React.memo` for expensive components');
    for (const factor of ['F1', 'F2', 'F4', 'F7']) {
      assert.ok(factor in rule.factors, `Missing ${factor}`);
    }
  });

  it('factors have value key', () => {
    const rule = scoreRule('Always validate input');
    for (const factor of ['F1', 'F2', 'F4', 'F7']) {
      assert.ok('value' in rule.factors[factor]);
    }
  });

  it('schema carried forward', () => {
    const data = {
      source_files: [
        {
          path: 'test.md', globs: [], glob_match_count: null,
          default_category: 'mandate', line_count: 10, always_loaded: true,
        },
      ],
      rules: [{
        id: 'R001', file_index: 0, text: 'Always test',
        line_start: 1, line_end: 1, category: 'mandate',
        staleness: { gated: false, missing_entities: [] },
        factors: {},
      }],
      custom_field: 'should_be_preserved',
    };
    const result = runScript('score_mechanical.js', data);
    assert.equal(result.custom_field, 'should_be_preserved');
  });
});
