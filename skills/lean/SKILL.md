---
name: lean
description: Turns Hestia's companion reminder on or off for the current project. The housekeeping reminder — keep the workspace tidy — is on by default.
when_to_use: Use when the user wants to switch Hestia's companion reminder off or back on — "turn off hestia", "stop the companion", "mute the reminders", "turn hestia back on", or invokes /hestia:lean [on|off].
argument-hint: [on|off]
allowed-tools: Read, Write, AskUserQuestion
---

# Companion on/off

Toggle Hestia's housekeeping reminder for the current project. State stored in `.hestia/lean-mode`; read by the session hook. Default is on.

## Steps

1. **Read `$ARGUMENTS`.** If `on` or `off` → step 3. Otherwise → step 2.

2. **Ask.** Read `.hestia/lean-mode` (absent = `on`). MUST invoke `AskUserQuestion`:
   - header: `Companion`
   - options: `on` (reminder injected, default) and `off` (silent), marking the current value.

3. **Save.** MUST invoke `Write` with the single word (`on` or `off`) to `.hestia/lean-mode`.

4. **Confirm.** One sentence: companion is now on/off, applies to this project. `off` takes effect immediately for per-turn nudges; full brief suppressed from next session start.
