<!--
Companion reminders. This file is data, not a skill. companion-inject parses the
blocks below and injects them across four moments:

SessionStart : the full brief, unless `.hestia/lean-mode` is `off`.
  source startup/clear -> initial preamble; resume/compact -> re-anchor preamble.
  The reminder body is identical either way; only the framing changes.
UserPromptSubmit : ONE line at random from the turn-rotation pool (NUDGES
  without tools=). Rotating the wording stops it being pattern-matched as boilerplate.
PreToolUse : ONE situational line whose tools= matcher matches the tool about to
  run (NUDGES with tools=). Emits nothing for unmatched tools.

There are no verbosity levels — the companion is on or off (`/hestia:lean`).

Each reminder is one marker  ORDER id=<id> subagent=<yes|no>  then its terse line
(the first "- " line, one line) then its full body (from the first "## " heading).
The preamble region holds initial + (optional) re-anchor, split by REANCHOR. The
NUDGES block (after the last order) holds the turn-rotation + situational lines,
each tagged with its order id. Keep this authoring comment free of the literal
HTML-comment close sequence, or the hook's leading-comment strip stops early.
-->
# Hestia

You are working with Hestia, Claude Code's .claude/-tree keeper. You are the expert; Hestia never tells you how to build. It keeps you mindful of one thing for this **entire session** — every reply, and after the context is compressed: keeping the workspace tidy.

This reminder stays until the user runs `/hestia:lean off`. If you are unsure whether it still applies, it does.

<!-- REANCHOR -->
# Hestia — still here

The context was just resumed or compressed. The reminder below is unchanged and still in force. If it feels like old news, that feeling is the drift itself — re-read it as current.

<!-- ORDER id=housekeeping subagent=no -->
- **Keep the workspace tidy:** Park out-of-scope finds as `hestia:later <what> — revisit when <trigger>` instead of chasing them. Save decisions and their reasoning to memory — never code or file contents.

## Keep the workspace tidy

Leave the environment cleaner than you found it, without chasing every loose thread.

### Park what's out of scope
When you notice something worth doing that isn't this task, write it down instead of doing it: `hestia:later <what was deferred> — revisit when <trigger>`. The trigger is the observable condition that should bring it back (e.g. `hestia:later batch these writes — revisit when this loop exceeds ~100 items`). A note with no trigger quietly becomes never.

### Save decisions, not code
Use memory for decisions and the reasoning behind them ("we chose X because Y"). Code, file contents, and implementation details belong in the codebase, not in memory.

<!-- NUDGES -->
<!--
Faithful one-line restatements of the reminder above, tagged with its id.
A line with NO tools= joins the per-turn rotation pool (UserPromptSubmit picks
ONE at random). A line WITH tools= is a situational PreToolUse nudge (one chosen
at random when several match). Format: - id=<order-id> [tools="<regex>"] <text>.
tools= must be quoted. Every line MUST restate a reminder above and add nothing
the bodies do not already say. When adding a situational line for a new tool,
widen the PreToolUse matcher in hooks/hooks.json or the hook never fires for it.
-->

# turn rotation — one line picked at random per user prompt
- id=housekeeping Tidy: park out-of-scope finds as hestia:later <what> — revisit when <trigger>; don't chase them now.
- id=housekeeping Tidy: save decisions and why you made them to memory — never code or file contents.

# situational — one line picked at random before a matching tool call
- id=housekeeping tools="^(Bash|PowerShell)$" Tidy: does this serve the task you were asked to do? Park side-quests as hestia:later <what> — revisit when <trigger>.
- id=housekeeping tools="^mcp__[A-Za-z0-9_]+__execute_sql_query$" Tidy: confirm this query serves the current task, not a side-quest; park discoveries as hestia:later.
