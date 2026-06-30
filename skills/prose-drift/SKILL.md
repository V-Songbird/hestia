---
name: prose-drift
description: >-
  Detects stale prose in instruction files — rules and CLAUDE.md directions
  that assert facts about the project's tools, structure, commands, or
  dependencies that the actual code no longer confirms. Complements
  /hestia:freshness (broken path references) with semantic reasoning.
when_to_use: >-
  Use when the user suspects CLAUDE.md or rules no longer match the project —
  "are my instructions outdated?", "check if my rules match the code", "my
  CLAUDE.md might be wrong about X", "verify rules against reality", "stale
  instructions", or /hestia:prose-drift. Also triggered from /hestia:checkup
  when the user picks "Scan for stale prose".
allowed-tools: Bash, Read, Grep, Glob
---

# Prose Drift — Semantic Staleness Scan

Find rules and CLAUDE.md directions that assert facts about the project —
tools used, directory structure, commands to run, external services — that the
code no longer confirms. This is the semantic companion to `/hestia:freshness`,
which catches broken path references mechanically. Where freshness asks
"does this path exist?", prose-drift asks "does this claim still describe
reality?"

Read-only. Surface contradictions; the user decides what to fix.

## Phase 1 — Discover instruction files

MUST invoke `Bash` with `description: "Discover instruction files and detect stack"`:

```bash
python "${CLAUDE_PLUGIN_ROOT}/scripts/discover.py" 2>&1
```

If `python` fails, try `python3`. If both fail, tell the user Python 3.10+ is
required and stop.

Read the JSON output. Record:
- `project_root` — working root for all subsequent probes
- `artifacts.claude_md` — list of CLAUDE.md entries (`path`, `scope`)
- `artifacts.rules` — list of rule files (`path`)
- `stack` — tech-stack labels (e.g. `["node", "typescript"]`)

Collect files to scan: all `claude_md` + `rules` entries. Focus on
project-scope files (`scope: "project"` or `"project-dot"`); include nested
and user-scope if they exist.

If no instruction files exist, tell the user the project has no CLAUDE.md or
rules yet (`/hestia:checkup` can help) and stop.

## Phase 2 — Read and extract testable claims

`Read` each instruction file. As you read, identify **testable claims** —
statements that assert a specific, falsifiable fact about the project that a
code probe can verify.

### What counts as testable

| Type | Examples |
|------|---------|
| `tech_stack` | "Built with React", "Uses FastAPI", "This is a Next.js project" |
| `command` | "Run `npm test`", "Build with `make build`", "Start via `./run.sh`" |
| `dependency` | "Uses lodash for utilities", "We use axios for HTTP", "Avoid moment.js" |
| `structure` | "Tests live in `__tests__/`", "Components in `src/components/`" |
| `convention` | "Services are named `*.service.ts`", "Components extend `BaseWidget`" |
| `external_service` | "CI runs on Travis CI", "Deployed to Heroku", "Hosted on Vercel" |

### What to skip (not testable from code)

- **Claude behaviour rules**: "Don't add comments unless asked" — meta-rules,
  not project facts.
- **Process/policy**: "Always rebase before merging", "PRs require two
  approvals" — unverifiable from the codebase.
- **Quality intent**: "Write clean code", "Prefer readability" — no code
  ground truth.
- **Future plans**: "We plan to migrate to TypeScript" — not yet a fact.
- **Bare negation**: "Don't use console.log" — exhaustive absence is
  unverifiable.

### Claim cap

**Extract at most 25 testable claims.** If more exist, prioritize:
`command` > `tech_stack` > `dependency` > `structure` > `external_service`
> `convention`.

For each claim record:
- `rule_location`: `"CLAUDE.md:42"` or `".claude/rules/stack.md:17"`
- `claim_text`: the sentence asserting the claim (≤ 60 chars)
- `claim_type`: one of the six types above
- `probe_target`: the concrete token to look for (library name, dir path,
  command string, service name)

## Phase 3 — Probe each claim

For each claim, use the most direct strategy from this table. Run independent
probes in parallel where possible.

| `claim_type` | Probe strategy |
|--------------|---------------|
| `tech_stack` | `Grep` the framework/library name in the manifest first (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml`). If not in manifest, `Grep` in top-level source files. |
| `command` | `Read` `package.json` (`.scripts`), `Makefile`, or the named script file. `Glob` to verify a path-based command file exists. |
| `dependency` | `Grep` the dependency name in manifest files (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`) — whichever the `stack` label suggests. |
| `structure` | `Glob` for the named directory or file pattern from project root. |
| `convention` | `Grep` the pattern (suffix, base class, naming prefix) across a source-file sample. Limit to 3 `Grep` calls — this is sampling, not exhaustive. |
| `external_service` | `Glob` for CI/deploy configs (`.github/workflows/*.yml`, `.travis.yml`, `.circleci/config.yml`, `Dockerfile`, `fly.toml`, `vercel.json`, `netlify.toml`, `heroku.yml`). `Read` any that exist to identify the actual service. |

For each probe record:
- `result`:
  - `confirmed` — positive evidence matches the claim
  - `contradicted` — evidence directly contradicts the claim (see threshold
    below)
  - `not_found` — searched in the right place, found nothing either way
  - `unverifiable` — claim type doesn't map to a viable probe
- `evidence_location`: file(s) where the probe ran (`file:line` when
  available)
- `evidence_summary`: one line describing what was found or not found

**Contradiction threshold — conservative.** Mark `contradicted` only when
you have POSITIVE evidence of contradiction, not mere absence. Absence of X is
`not_found`, not `contradicted`. Contradiction requires BOTH: (a) X is absent
where expected AND (b) a clear replacement Y is present serving the same role.

> Example: claim says "uses Redux" → `package.json` has `"zustand"` but no
> `"redux"` entry → `contradicted` (Redux absent, Zustand present as
> replacement). But if `package.json` simply lacks `"redux"` with no
> alternative → `not_found`.

## Phase 4 — Report (cite-or-drop, finding contract)

Every finding in Section 1 MUST cite both:
- the rule location (`rule_location`) — where the claim lives in an
  instruction file
- the code evidence (`evidence_location`) — where in the code the
  contradiction was found

Findings without both locators go to Section 2 (advisory) or Section 4
(limits), never Section 1.

State counted facts only. Never estimate impact percentages.

---

### Section 1 — Contradicted claims (findings)

Surface only `result == "contradicted"` claims. Lead with the count
("2 contradicted claims across 1 file" or "No contradicted claims found").

For each:

```
[rule_location] — "[claim_text]"
  Code says: [evidence_summary] ([evidence_location])
  Fix: Update to reflect "[what was actually found]", or remove if no longer
       relevant. Route CLAUDE.md rewrites to claude-md-improver
       (claude-md-management plugin); rules can be edited directly.
```

Group by instruction file.

---

### Section 2 — Advisory: claims with no confirming evidence

Claims where `result == "not_found"`. These are possibly stale — or possibly
correct and just not reached by the probe. State this explicitly.

```
Advisory — [N] claims with no confirming evidence (possibly stale, possibly
fine — the probe is a sample, not an exhaustive audit):

- [rule_location]: "[claim_text]"
  Searched: [what was probed, what was found (nothing)]
```

Omit this section entirely if N == 0.

---

### Section 3 — Confirmed (brief)

If any claims were `confirmed`:

```
Confirmed: [N] claims verified against the code — [first 3 claim texts].
```

Omit if N == 0.

---

### Section 4 — Limits (always)

Always close with a Limits section:

1. **Claim count**: how many claims were extracted vs the cap ("Extracted 18
   testable claims; cap is 25; [N] additional claims were not prioritized").
2. **Skipped types**: which claim types were not reached due to the cap (if
   any).
3. **Out of scope**: "Policy rules (branching strategy, review counts, meeting
   cadence), vague quality instructions, bare negations, and future-plan
   statements were not checked — they have no code ground truth."
4. **Confidence**: "Contradiction detection is conservative: `not_found` means
   no confirming evidence was found in the probe, not that the claim is wrong.
   Probes are targeted samples, not exhaustive scans."
5. **Fix routing**: "To rewrite contradicted claims in CLAUDE.md, route to
   `claude-md-improver` (install the `claude-md-management` plugin). For rule
   files, edit directly — Hestia is read-only. For broken path references
   (separate surface), run `/hestia:freshness`."
