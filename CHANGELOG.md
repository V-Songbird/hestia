# Changelog

All notable changes to Hestia are documented here. Versions are owned by `plugin.json` in this repo — bump here, not in the marketplace index.

## [1.8.0-beta] — 2026-06-30

### Added — CI drift gate

- **`drift.py --check`** — exits non-zero when any instruction-file reference is stale, so a pipeline can fail the build on drift. The team/CI path for the sync mission; reuses the existing scan (one flag, `raise SystemExit(1)`). 3 tests.

Considered and dropped: running `freshness-nudge` on `UserPromptSubmit` for mid-session drift warnings. The per-turn scan is free of tokens, but `freshness-nudge`'s `setup_stale` override bypasses its throttle — harmless once-per-session on `SessionStart`, but per-turn token spam on `UserPromptSubmit` for a stale-setup project. The mid-session external-drift gap is narrow (SessionStart covers it next session), so it isn't worth an event-aware guard right now.

617 tests pass (3 new).

## [1.7.0-beta] — 2026-06-30

### Changed — housekeeping pillar refocused on whole-`.claude/`-tree sync + detect-and-route

Repositioned around the niche the shipping competitors (mex, Caliber) leave open: keeping the entire `.claude/` tree — rules, skills, agents, commands, hooks, CLAUDE.md — in sync with the code, read-only, and routing each fix to the tool that owns it rather than rewriting config itself. The communication pillar is unchanged.

- **Orchestration core (new).** `scripts/_data/handoff_routes.json` maps each drift class to its owning plugin; `scripts/handoff.py` (`routes`/`stage`/`list`/`clear`) stages a handoff payload under `.hestia/handoffs/` and names the tool. Claude Code exposes no programmatic cross-plugin invocation API (verified against the plugins reference), so Hestia detects and *prepares* a handoff — it never dispatches. 10 tests.
- **`freshness` routes the fix.** A dead ref in CLAUDE.md → `claude-md-improver`; inside a skill → `skill-creator`; in rules/agents/commands → Hestia's own read-only lane. `checkup` routes through `freshness`, so the external routing is transitive — no separate wiring. No in-session file-staging; the report is the surfacing.
- **Removed `format-rules`.** It only reformatted rule files (split bullets, blank-line separation) — pure presentation, zero contribution to keeping config in sync. (−283 lines.)
- **Narrowed the rules engine.** `assess-rules` now leads with whether a rule *reaches* Claude (enforceable vs folklore) and routes hook-candidate rules to the `hookify` plugin; `author-rules` reframed to capture a *detected* gap/drift. The F1–F8 scoring engine is untouched — it computes the enforceability signal the new framing leads with.
- Deferred (await the installed Claude Code version): the CI/team path (a `Setup`-mode check) and moving watchdogs onto the observability-only `FileChanged`/`ConfigChange` hooks. `handoff.py`'s `stage`/`list`/`clear` persistence is the bridge those hooks will use.

614 tests pass (10 new).

## [1.6.0-beta] — 2026-06-29

### Added — vanished-path citation alarm (PostToolUse)

The freshness skill forward-scans instruction files for dead references, but only at session start — so a path a command renames or deletes mid-session goes unnoticed until the next launch, long after the cheap moment to fix it. A new `PostToolUse` hook closes that gap from the other direction: when a `Bash`/`PowerShell` command moves or deletes a path that no longer exists on disk, it pivots on that vanished path and reverse-looks-up every `CLAUDE.md` / rule / agent / skill / command reference that named it — exact match for a file, prefix match for a directory (one `git mv scripts/ tools/` flags every `scripts/*` citation at once) — and injects an advisory **in the same turn**, citing each `file:line`.

- **`hooks/vanished-path-alarm.py`** — new hook. Reuses `scripts/discover.py` (inventory) and `scripts/refs.py` (`extract_refs`). It deliberately does *not* use `refs.resolve()`: that helper chooses between a root-relative and a file-relative reading of a bare path by which one currently exists, but the matched path has just been deleted, so it resolves both interpretations itself (`_candidate_targets`) — without which a bare ref cited from a nested `.claude/rules/` file is mis-resolved and missed.
- **`hooks/hooks.json`** — new `PostToolUse` matcher `^(Bash|PowerShell)$`.
- **Existence guard, not exit-code parsing** — a path argument is treated as "vanished" only if it no longer exists on disk, which cleanly separates a move's gone source from its surviving destination and silences failed/no-op commands without inspecting the command's result.
- **Signature throttle** (`.hestia/vanished-alarm.json`) — suppresses an identical back-to-back alarm; unlike the freshness nudge it has no time component, since each destructive command is a discrete event.
- **Conservative by design** — globbed deletes (`rm *.py`), `$VAR` paths, and out-of-tree paths are skipped (a miss preferred to a false alarm); it sees through `sudo` / `env` / `VAR=val` prefixes and flags after the verb (`git rm -f`), but deliberately bails on `git -C` / `--work-tree` (which relocate the base a path resolves against); PowerShell `\` separators are normalized so the reverse lookup resolves identically on every OS.
- Never blocks the tool; any error exits 0 silently.

604 tests pass (24 new).

## [1.5.0-beta] — 2026-06-29

### Added — boundary re-injection (PostToolUse)

The re-grounding reminder previously fired only at SessionStart — hundreds of tool calls away from the long-run handoff it governs (recency decay). A new `PostToolUse` hook now counts tool calls since the last user prompt and re-injects the reminder once a run crosses `BOUNDARY_THRESHOLD` (10), then every 10 calls after, so the last re-anchor lands within ~10 tool calls of the handoff instead of back at session start. The counter resets on each user prompt; it's silent below threshold and when `lean off`.

- **`hooks/hooks.json`** — new `PostToolUse` matcher (all tools, to count the whole run).
- **`hooks/companion-inject.py`** — per-run tool counter in `.hestia/.run-state.json` (session-scoped, best-effort), `BOUNDARY_NUDGE`, `_boundary_due` / `_reset_run`; `read_input` now also reads `session_id`.
- Known limits: periodic, not exact-boundary (no hook fires *before* the final message, so it can't land exactly at the handoff); `BOUNDARY_NUDGE` is hook-owned text that mirrors the doctrine and could drift.

### Changed — identity copy leads with "simple and clear"

Reframed the README, `plugin.json`, and marketplace descriptions away from "talk to you as a stakeholder" (that was one illustration) toward the real premise: keep Claude's answers simple and clear — the outcome, not the jargon or the step-by-step most users don't want. The injected doctrine is unchanged.

580 tests pass (7 new boundary tests).

## [1.4.0-beta] — 2026-06-29

### Changed — communication reminder rewritten; verbosity levels removed

- **doctrine.md** — the communication reminder is now a single *triggered* instruction adapted from Anthropic's Claude Fable 5 prompting guidance: when a message is the user's first look at work they didn't watch, write it as a re-grounding — outcome first, drop the working shorthand. This replaces the eight generic communication sub-rules, which restated defaults the model already follows (and which over-prescription can degrade). Inter-step narration is explicitly left alone — the guidance blesses it; the target is the final message after a long run.
- **`/hestia:lean` is now on/off only.** The `trim` / `lean` / `bare` verbosity levels are gone — the companion is injected or it isn't. Legacy `.hestia/lean-mode` values (`lean`/`trim`/`bare`) are read as on. The `critical=` order attribute (which only existed to support `bare`) is removed; `read_mode` → `is_off`.
- READMEs updated to `/hestia:lean on\|off`.

Rationale: four runs (incl. a `/lean off` control) plus a two-session A/B showed the old generic, always-on communication prose had no attributable effect on the deliverable. The fix targets the one moment where injection has a real delta — the final summary of a long agentic run — with empirically-tuned wording.

573 tests pass.

## [1.3.1-beta] — 2026-06-29

### Changed — checkup routing + lean pass (skill polish + over-engineering review)

- **checkup** now points to `format-rules` when rules exist and to `primer` during onboarding — the two skills earned discoverability through the front door instead of being merged away.
- **primer** — dropped the four-task tracking ceremony; it was overkill for a one-file copy and cited task tools missing from `allowed-tools`.
- **Dead code removed** (ponytail-review): `JUDGMENT_FACTORS` (parse_judgment.py), `KNOWN_ORDERS` (injection_ledger.py), `_count_gap_rules` (report.py), and `_should_ignore` + its never-reached caller guard (extract.py).
- **Fixed** — `--write-promotions` raised `TypeError`: `run_audit.py` passed a `state_dir` kwarg that `placement.write_promotions` doesn't accept, so the assess-rules Promote path crashed. Removed the kwarg.
- **Dead feature removed** — the orphaned `generate_overview.py` (its intention-map / coverage-gaps job moved into the assess-rules skill) and its test, plus the unused `gap_threshold` weight (its only consumer was the deleted `_count_gap_rules`; the "what to fix first" report already exists, grouped by dominant weakness).

577 tests pass (the orphan's 25 tests removed with it).

## [1.3.0-beta] — 2026-06-29

### Changed — scribe/proofreader retired; rules engine refaced around the user

Continues the 1.2.0 refocus. The instruction-artifact authoring + QA tooling is ceded as craft, and the rules engine now speaks from the user's side.

- **Retired** `scribe`, `proofreader`, and `run-tests` — authoring and linting Claude Code artifacts (frontmatter, tool-shapes, token budgets) is mechanics-correctness craft, the artifact-equivalent of code. Their one keeper — *name the consequence, not the mechanism* — folds into the communication reminder in `doctrine.md`.
- **Rules-engine lens reframed** — `assess-rules` now measures "whether your instruction reaches Claude intact" rather than "structural clarity for Claude" (`quality-model.md`). Same scoring, the user's-intent frame.
- **Reports calmed (dogfood)** — `assess-rules` leads with the plain consequence, not the grade, and surfaces "rules that can't be checked or self-verified" instead of the internal "folklore" label; `author-rules` drops the bare decimal; the fix-menu loses the "primitive" jargon.
- **checkup** — still flags malformed/oversized/unparseable instruction files (a broken file is housekeeping), but no longer routes the fix to the retired scribe; the scribe/proofread next-step options are gone.
- Governing principle: Hestia keeps what judges whether *meaning lands*; it cedes what judges whether *mechanics are correct*.

602 tests pass.

## [1.2.0-beta] — 2026-06-29

### Changed — refocused on communication and housekeeping; code craft ceded

Hestia now does exactly two things: keep Claude talking to the user as a stakeholder, and keep the workspace tidy. It no longer tells Claude how to write code — that craft is the model's own. The seven standing orders collapse to two calm reminders, and the voice softened from barking imperatives to a hand on the shoulder.

- **`skills/lean/doctrine.md`** — rewritten around two reminders: **Talk to the stakeholder** (lead with the outcome, the user's words, no play-by-play, give depth when asked, be honest about uncertainty, say the plan before big work, let structure earn its place) and **Keep the workspace tidy** (`hestia:later` parking, save decisions not code). The `lean` ladder/YAGNI/ceiling-comment doctrine, the `phases`, `formatting`, and code-process `truth-grounding` orders are gone; their durable kernels fold into the two reminders.
- **`hooks/companion-inject.py`** — the `build=` axis (which orders reach subagents) is renamed `subagent=`; only communication reaches a worker now. Fallback text rewritten to the stakeholder voice.
- **`hooks/hooks.json`** — `PreToolUse` matcher narrowed to the tools that still carry a nudge (Bash/PowerShell/WebSearch/WebFetch/AskUserQuestion/SQL); edit/write/dispatch/plan nudges removed with the code doctrine.
- **Retired skills** — `lean-audit`, `lean-review` (code-leanness auditors) and `prepare` (code-terrain grounding) removed; all three taught code craft.
- **`scripts/injection_ledger.py`** — canonical order ids reduced to `communication`, `housekeeping`.
- **Identity** — `plugin.json` and `README.md` rewritten to describe a calm companion that protects the *user's* experience, not guardrails aimed at Claude. `checkup` no longer routes to the retired `lean-audit`.

`/hestia:lean` still tunes how assertively the two reminders fire (`trim`/`lean`/`bare`/`off`); `bare` now keeps only the communication reminder. 602 tests pass (companion-hook suite rewritten to the two-pillar contract).

## [1.1.0-beta] — 2026-06-29

### Added — situational and rotating doctrine injection

Doctrine injection is now tailored to the moment instead of repeating one fixed brief, keeping the standing orders loyal across long sessions and context compression. Supersedes the 1.0.6 per-turn micro-nudge (a single fixed line every turn, which a long session learns to discount as boilerplate).

- **`hooks/hooks.json`** — `SessionStart` now matches `startup|resume|clear|compact`, so the brief re-injects after compaction instead of silently dropping out. New `PreToolUse` group fires the companion hook on edit / write / shell / dispatch / web / plan / ask / skill / SQL / build tools.
- **`hooks/companion-inject.py`** — routes five moments. `SessionStart` `source` selects the preamble: `startup`/`clear` get the initial preamble, `resume`/`compact` get a re-anchor preamble (anti-drift framing) while keeping the full order bodies, so a re-brief after compaction never loses detail. `UserPromptSubmit` now emits ONE line picked at random from a rotation pool (instead of the same four-in-one line every turn), so no fixed string is there to tune out. `PreToolUse` injects a situational nudge matched to the tool about to run (JSON-wrapped `additionalContext`), and stays silent for unmatched tools — injection only, never gates the call.
- **`skills/lean/doctrine.md`** — preamble strengthened from descriptive to prescriptive: the orders are instructions in force every response and tool call, off only via `/hestia:lean off`, and "if you are unsure whether an order applies, it does." Adds a re-anchor preamble (`REANCHOR` marker) and a `NUDGES` block holding the rotation + situational lines. Every NUDGES line is an `id`-tagged restatement of an existing order — no rule the order bodies don't already mandate. The now-unused `turn`/`micro` order attributes were removed.

32 companion-hook tests (19 new: re-anchor source routing, turn rotation, PreToolUse JSON contract and silence on unmatched tools); 602 total in the suite.

## [1.0.7-beta] — 2026-06-29

### Fixed — freshness skill false positives in refs.py

Three distinct false-positive classes eliminated from the reference scanner, plus a pre-existing `:line` suffix gap:

- **Class 1 — `./knowledge/...` from `prepare` skill:** `resolve()` now tries project-root-relative as a fallback when `./foo` doesn't exist file-relative. The `prepare` skill example paths are also corrected to bare `knowledge/...` (no `./` prefix), aligning its output with the scanner's project-root-relative convention for bare paths.
- **Class 2 — `references/xxx.md` inside skill subdirs:** `resolve()` now tries file-relative as a fallback when root-relative lookup fails, correctly handling SKILL.md files that cite their own `references/` subfolder.
- **Class 3 — `.../tasks/Foo.kt` prose ellipsis:** `_looks_like_path()` now rejects tokens starting with `...`, preventing prose shorthand from being treated as a broken file reference.
- **Bonus — `:line` suffix stripping:** `resolve()` now strips `:\d+` suffixes before the existence check (e.g. `File.kt:10` → checks `File.kt`). This was a pre-existing gap that masked Class 1.

Adds `tests/test_refs.py` with 21 tests covering all three classes and verifying existing correct behaviours are preserved.

## [1.0.6-beta] — 2026-06-29

### Added — per-turn doctrine re-injection via UserPromptSubmit hook

Hestia now re-anchors its four most actionable standing orders on every user prompt, not just at session start. As context grows long the session brief loses its hold; the per-turn micro-nudge keeps doctrine active throughout.

- **`hooks/hooks.json`** — new `UserPromptSubmit` entry pointing at `companion-inject.py`.
- **`hooks/companion-inject.py`** — new `build_turn_context()` function assembles a single-line micro-nudge from all `turn=yes` orders (`lean`, `truth-grounding`, `scope`, `communication`). New `UserPromptSubmit` branch in `main()` dispatches to it. Attribute parser upgraded to handle quoted values (for `micro="..."`) and hyphenated identifiers (for `id=truth-grounding`).
- **`skills/lean/doctrine.md`** — preamble updated with persistence anchor ("remain active even as context grows long"). Four `ORDER` markers gain `turn=yes micro="..."` attributes.

Per-turn payload (~25 tokens): `[Hestia] Lean: smallest change that fully solves the problem. · Truth-ground: flag niche-tech knowledge gaps before coding. · Scope: park discoveries with hestia:later <what> — revisit when <trigger>. · Communicate: answer first, match their vocabulary, no hedging.`

`off` mode suppresses the nudge. All other verbosity levels produce the same compact payload — the per-turn injection is already at its terse floor.

## [1.0.5-beta] — 2026-06-28

### Fixed — lean doctrine extraction

`scripts/extract.py` now preserves `Memory` and `Formatting` terse forms intact instead of fragmenting them into sub-bullets. Added `tests/test_extract.py` to guard against regressions.

## [1.0.4-beta] — 2026-06-28

### Added — companion communication & formatting orders

Two new always-on standing orders added to `doctrine.md`, with full support across all verbosity levels (`lean`, `trim`, `bare`, `off`) and the injection ledger.

- **Communication:** Lead with the answer, not the reasoning. Match technical depth to the vocabulary the user used. Skip hedging, over-explanation, and jargon the user did not introduce first.
- **Formatting:** Use tables, bullets, headers, and separators when they genuinely reduce scanning effort — comparing options, parallel items, distinct topic shifts. Do not impose structure on a flat answer.

Both orders are `critical=no build=no`: injected in full at `lean`, terse at `trim`, dropped at `bare`, excluded from subagent context (communication style is the orchestrating session's concern, not the subagent's).

`KNOWN_ORDERS` in `scripts/injection_ledger.py` updated to include `communication` and `formatting` so the self-audit ledger can track whether they earn their always-on slot.

## [1.0.3-beta] — 2026-06-28

### Changed — `/hestia:prepare` improvements
- **Migration mode (Step 1):** new mode gate distinguishes fresh terrain from migrating existing Skills that reference machine-specific absolute paths. Migration path scans `.claude/skills/` for hardcoded roots, skips the YAGNI gate, and repoints refs to `./knowledge/<repo>/...` at Step 5.
- **Large-repo guard (Step 3):** before cloning, checks estimated repo size. Over ~500 MB, surfaces a choice — clone shallow, add as git submodule, or skip and rely on docs. Prevents silent multi-GB pulls.
- **Sharper triggers:** `when_to_use` now explicitly names "knowledge folder", "clone repo into project", "my skills have hardcoded paths", "repoint existing skills". Added explicit "Do NOT confuse with `/hestia:primer`" note to prevent misrouting.

### Fixed
- `/hestia:primer` was missing from the README skills table.

### Added
- `CODE_OF_CONDUCT.md` and `CONTRIBUTING.md`.
- GitHub Actions CI workflow (`pytest tests/ -v` on Ubuntu, macOS, Windows — Python 3.13).
- `.gitignore` for `__pycache__`, `.hestia/`, `.hestia-tmp/`, test cache.

### Changed — housekeeping
- Hestia moved to its own standalone repo (`V-Songbird/hestia`); monorepo sources it as a git submodule.
- Version ownership moved from `marketplace.json` to this `plugin.json`.
- Marketplace description and keywords tightened.

## [1.0.2-beta] — 2026-06-27

### Changed — sharper lean doctrine (token reduction)
- **Response shape rule:** "one line max — what was skipped and when it matters." Replaces the vague "a few short lines" with a concrete ceiling.
- **No-defense rule:** never explain why you made something simple. The urge to justify a short solution is the bug — cut it.
- **Inline ceiling comments:** `// lean: <what this skips> — upgrade when <trigger>` marks deliberate simplifications at the site in code. Distinct from `hestia:later` (scope drift) — a ceiling comment stays with the code; `hestia:later` parks work the current task doesn't own.

## [1.0.1-beta] — 2026-06-27

### Changed — smarter truth-grounding in `/hestia:prepare`
- **YAGNI gate (Step 4):** before proposing Skills or Rules, prepare now checks whether a real gap exists. If training knowledge plus the gathered sources show no significant gaps, it skips artifact creation and notes the self-assessment is available in conversation — no noise for domains Claude already knows well.
- **Knowledge folder (Step 3):** GitHub repository URLs are now cloned shallow (`git clone --depth 1`) into `./knowledge/<lib-name>/` so the source is navigable on disk. Documentation and non-repo URLs stay as `WebFetch`.
- **Pointer-index Skills (Step 5):** Skills are now authored as pointer-indexes — each entry names a concept, states its constraint in one line, and points to a `./knowledge/<lib>/path:line` location in the cloned source. Claude reads the file directly when it needs depth. Narrative summaries are no longer written, eliminating the telephone-game distortion where source → Claude summary → skill adds two lossy hops.

## [1.0.0-beta] — 2026-06-27

First feature-complete, dogfooded release. All six pillars built, conformed to the official Claude Code spec, and hardened with an evidence-driven epistemics layer. Both interactive flows (`/hestia:checkup`, `/hestia:assess-rules`) were driven end-to-end as a live session — including the human F3/F8 judgment loop — before this promotion.

### Added — epistemics upgrade (evidence-driven)
- Finding contract: cite-or-drop (every finding must point at a `file:line` or it is dropped), triple-shape (symptom / why / fix), honest-limits ("what this run could not check"), counted-facts-only (no fabricated impact %).
- Folklore check: `/hestia:assess-rules` classifies every rule as enforceable / observable / folklore and flags unenforceable rules for rewrite-or-delete.
- Staleness-as-honesty: checkup/freshness derive a fresh/aging/stale label from cheap signals instead of storing a grade; cleared surfaces are recorded so repeat runs skip unchanged inputs.
- Lean + measurable injection: SubagentStart receives only the build-governing standing orders (~30% smaller); a confirm/dispute ledger makes the standing orders self-auditing.
- `hestia:later <what> — revisit when <trigger>`; debt flags trigger-less markers as silent-rot risk.
- Verify-the-detector: every probe has a known-bad fixture proving it fires.

### Changed — spec conformance
- Rules engine now parses rule frontmatter (`paths:` canonical; `globs:` legacy alias), making the F4 load-trigger factor live; recursive discovery of nested rules/commands; `@`-import resolution; `CLAUDE.local.md` and opt-in `~/.claude` user scope.
- Corrected the docs Hestia teaches (the `Setup` hook event, `@`-import depth, `disallowed-tools`, `PreToolUse` enforcement framing); subagent frontmatter keys (`tools:`/`skills:`).
- Curse-of-Knowledge framing for `prepare` + truth-grounding standing order.

### Fixed
- Numerous engine + skill-contract fixes found by an 11-agent docs audit and a live dogfood (the `--build-analysis` mode, `examples.json` regex, drift worktree noise, the `.hestia-tmp` same-directory rule, and more).

### Status
- 561 tests passing; manifest clean. Beta = feature-complete and dogfooded; real-world mileage across diverse projects earns the stable `1.0.0`.

## [0.1.0-alpha] — 2026-06-27

Initial scaffold. Absorbs the planned `virgil` freshness scope into a single setup-health toolbox.

### Added
- Flagship front door: `/hestia:checkup` — prioritized plain-language audit of CLAUDE.md, rules, agents, skills, hooks, commands
- Minimalism pillar: always-on lean doctrine (SessionStart hook), `/hestia:lean` mode control, `/hestia:lean-review`, `/hestia:lean-audit`, `/hestia:debt`
- Freshness watch: SessionStart nudge hook (throttled, signature-based), `/hestia:freshness` full staleness scan
- Rules engine: full 8-factor quality model (F1/F2/F3/F4/F7/F8) — `/hestia:assess-rules`, `/hestia:author-rules`, `/hestia:format-rules`, `/hestia:primer`
- Authoring pillar: `/hestia:scribe` (8-item pre-completion checklist), `proofreader` agent (13-item checklist, read-only), `/hestia:proofread`, `/hestia:run-tests`
- Plugin manifest and marketplace registration.
- Project scaffold: shared script library, setup-discovery module, state/coordination namespaces (`.hestia/`, `.hestia-tmp/`).
- All scripts stdlib-only; Python 3.10+; inter-script JSON contract

### Supersedes
- `virgil` (planned, never shipped) — staleness detection absorbed into freshness pillar

### Notes
- Read-only posture for all audit and watch surfaces; authoring/format skills write only on direct invocation behind approval gates.
- Build is phased — see the project plan for the full task breakdown.
