---
name: lean
description: Turns Hestia's companion reminders on or off for the current project. The two reminders — talk to the user as a stakeholder, and keep the workspace tidy — are on by default.
when_to_use: Use when the user wants to switch Hestia's companion reminders off or back on — "turn off hestia", "stop the companion", "mute the reminders", "turn hestia back on", or invokes /hestia:lean [on|off].
argument-hint: [on|off]
allowed-tools: Read, Write, AskUserQuestion
---

# Companion on/off

Hestia injects two calm reminders into every session automatically — talk to the user as a stakeholder, and keep the workspace tidy. This skill turns those reminders on or off for the current project, or shows the current setting. The state is stored in `.hestia/lean-mode` and read by the session hook.

- **on** (default) — the reminders are injected.
- **off** — nothing is injected; the companion is silent for this project.

There are no verbosity levels — it is on or off.

## Steps

1. **Read `$ARGUMENTS`.**
   - If it is `on` or `off` → go to step 3.
   - Otherwise → go to step 2.

2. **No clear choice given — ask.** First Read `.hestia/lean-mode` (absent means `on`). Then MUST invoke `AskUserQuestion`:
   - header: `Companion`
   - multiSelect: false
   - options: `on` and `off`, each with its one-line description above, and mark which one is current.

3. **Save it.** MUST invoke `Write` to put the single lowercase word (`on` or `off`) in `.hestia/lean-mode` (create the `.hestia/` folder if it does not exist). Writing `on` is equivalent to removing the file — either form means on.

4. **Confirm in plain language.** Tell the user whether the companion is now on or off, what that means in one sentence, and that it applies to this project. `off` takes effect immediately for the per-turn nudges and from the next session start for the full brief.

## Standing-order self-audit (optional)

An always-on reminder that is frequently irrelevant trains Claude to tune out both. The injection ledger turns that risk into a measurable signal: each session can record whether a reminder *mattered* (`confirm`) or *fired but was irrelevant* (`dispute`), and the summary shows which reminders earn their always-on slot.

- **Record a verdict** when a reminder demonstrably mattered or clearly didn't this session. MUST invoke `Bash` with `description: "Record a reminder verdict"` and command `python "${CLAUDE_PLUGIN_ROOT}/scripts/injection_ledger.py" confirm <order-id>` (or `dispute <order-id>`). Order ids: `communication`, `housekeeping`. Example: a `hestia:later` marker caught real scope creep → `confirm housekeeping`.
- **Show the summary** when the user asks how the standing orders are performing, or wants to know which to drop or rescope. MUST invoke `Bash` with `description: "Summarize the injection ledger"` and command `python "${CLAUDE_PLUGIN_ROOT}/scripts/injection_ledger.py" summary`, then relay the output. The summary reports plain confirm/dispute counts and a descriptive note (e.g. "order X: 0 confirms / N sessions — candidate to drop or rescope"). The candidacy is descriptive only — never auto-drop an order; that is a human decision.

This is a self-audit signal, not enforcement. The ledger lives in `.hestia/injection-ledger.jsonl` (gitignored) and is created on first write.
