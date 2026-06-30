<div align="center">
  <img src="logo.svg" alt="Hestia" width="120" />
  <h1>Hestia</h1>
  <p><strong>Claude Code's .claude/-tree keeper</strong> — keeps your project tidy and your instruction files honest.</p>
</div>

Hestia tends the whole `.claude/` tree — rules, skills, agents, commands, CLAUDE.md — keeping references in sync with the code and routing each fix to the tool that owns it. Read-only, never overwriting. And while Claude works, Hestia keeps the workspace tidy: parking deferred finds, saving decisions to memory, and stopping scope creep before it accumulates.

Hestia never tells Claude *how* to code. That's his craft. Hestia only tends what he *leaves behind*.

---

## Install

```
/plugin marketplace add V-Songbird/claude-plugins
/plugin install hestia
```

> [!TIP]
> Hestia starts working at the next session. No configuration required.

---

## How it works

Hestia runs on two tracks: **always-on** reminders injected into every session, and **on-demand** skills you invoke when you need them.

### Always on

> [!NOTE]
> One reminder is injected automatically into every session. You never invoke it — it runs. On by default; turn it off for a project with `/hestia:lean off`.

| Reminder | What it keeps in mind |
| --- | --- |
| **Keep the workspace tidy** | Park out-of-scope finds as `hestia:later <what> — revisit when <trigger>` instead of chasing them. Save decisions and their reasoning to memory — never code or file contents. |

### On demand

| You want to… | Invoke |
| --- | --- |
| Full health check of your Claude Code setup | `/hestia:checkup` |
| Scan for stale setup files (broken path references) | `/hestia:freshness` |
| Scan for semantically stale prose (tools, commands, structure no longer matching the code) | `/hestia:prose-drift` |
| See all deferred `hestia:later` work | `/hestia:debt` |
| Turn the companion on or off | `/hestia:lean on\|off` |
| Check whether your rules and CLAUDE.md reach Claude | `/hestia:assess-rules` |
| Write new rules with live quality scoring | `/hestia:author-rules` |
| Install the curated starter rules file | `/hestia:primer` |

---

## Quick start

```
/hestia:checkup
```

Run this in any project. Hestia inventories your entire Claude Code setup — `CLAUDE.md`, `.claude/rules`, agents, skills, commands, hooks — checks every piece, and hands back a ranked, plain-language report with a clear path to fixing each item. Every other skill is reachable from Checkup.

---

## In CI

Fail a build when an instruction-file reference goes stale:

```bash
python scripts/drift.py --check   # exits non-zero on any stale reference
```

Point it at the installed plugin's `scripts/drift.py` (outside a Claude session, `${CLAUDE_PLUGIN_ROOT}` is unset).

---

## Read-only by default

> [!NOTE]
> Hestia's audits, watchers, and analysis tools **never modify your files**. Checkup and Freshness only observe and report.

The skill that does write — `author-rules` — runs only on direct invocation and always shows you what it intends to create before touching anything.

---

## Files Hestia creates

| Path | Purpose |
| --- | --- |
| `.hestia/` | Persistent state: lean intensity setting, freshness-nudge throttle[^1] |
| `.hestia-tmp/` | Transient audit working files, cleaned up automatically |

[^1]: Add both paths to `.gitignore` — they are local-only and should not be committed.

---

## Status

`2.1.0-beta` — sync + housekeeping. Communication pillar removed; housekeeping and all sync/freshness features intact. Beta means validated; stable `1.0.0` follows real-world mileage across diverse projects.

---

## License

MIT — see [LICENSE](LICENSE).
