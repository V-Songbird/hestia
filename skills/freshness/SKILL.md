---
name: freshness
description: Scan this project's instruction files (CLAUDE.md, rules, agents, skills, commands) for references that no longer resolve, and recommend read-only fixes. Never edits files.
when_to_use: Use when the user wants to find or refresh stale setup files — "are my setup files stale", "check for stale references", "refresh my CLAUDE.md", "freshness check", or /hestia:freshness. Also where Hestia's freshness nudge points.
allowed-tools: Bash, Read, Grep, Glob
---

# Freshness — find stale setup

Find where the project's instruction files have drifted from the code, and recommend fixes. Read-only — surface what's stale; the user decides what to change.

## Steps

1. **Scan.** MUST invoke `Bash`: `python "${CLAUDE_PLUGIN_ROOT}/scripts/drift.py"`. Read the JSON it prints. If `python` is missing, try `python3`. The output carries `stale_files`, a counted `total_broken`, a `limits` array, and a `staleness` object `{label, commits, days, reason, ...}` — a DERIVED freshness label of the *last* checkup (`fresh`/`aging`/`stale`/`unknown`), computed at read-time from a cheap stored signal, never a stored grade.

2. **Report (cite-or-drop, counted facts).** Lead with one honest staleness line derived from `staleness`: state its `label` and `reason` in plain language (e.g. "Setup last verified 3 commits ago → fresh", or "STALE — 80 days since last checkup; re-run before trusting", or "No prior checkup on record" for `unknown`). It is a derived label, never a stored grade — do not invent a numeric score. Then every line you surface MUST cite a concrete `<file>` → `<ref>` pair from `stale_files`. Never report a vague "things look stale" with no locator. State counts plainly ("3 broken references across 2 files") — never an impact estimate like "this would improve freshness by N%". If `stale_files` is empty, tell the user their setup looks fresh. Otherwise, group by file: "<file> points to `<ref>`, which no longer exists."

3. **Recommend (read-only, triple-shape).** For each broken reference give the symptom (the dead ref), one line on why it bites (Claude follows a path that no longer exists), and the concrete fix — update it to the new path, or remove it if the thing is gone for good. Do not apply changes; show the user where to look so they stay in control.

4. **Close with Limits.** ALWAYS end with a short "Limits — what this run could not check" line built from the `limits` array. State the empty case explicitly ("No stale references found.") — never silence. Carry the residual risk: only resolvable path-like references are checked; prose that describes outdated behavior, and references pointing outside the project tree, are not detected. For semantic staleness — rules or CLAUDE.md directions that describe the project's tools, commands, or structure in ways the code no longer confirms — run `/hestia:prose-drift`.

5. **Route the fix to its owner — Hestia detects, it doesn't rewrite.** Match each stale ref (use its `kind` from `stale_files`) to the tool that repairs it: in **CLAUDE.md** (`kind: claude_md`) → `claude-md-improver` rewrites it against the code — install `claude-md-management` and hand it the dead refs; inside a **skill's `SKILL.md`** (`kind: skills`) → `skill-creator`. For **rules / agents / commands** there is no external owner — update or remove the ref yourself (Hestia's read-only lane). For rule *quality* (do they reach Claude at all), `/hestia:assess-rules`.
