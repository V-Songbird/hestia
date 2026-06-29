<div align="center">
  <img src="logo.svg" alt="Hestia" width="120" />
  <h1>Hestia</h1>
  <p><strong>Claude Code's calm companion</strong> — keeps Claude's answers simple and clear, and keeps your project tidy.</p>
</div>

Claude is the expert who can build anything — but ask about his work and he can't stop talking: every step narrated, every decision explained, in language only another engineer would follow. Hestia rests a hand on his shoulder and reminds him of the room he's in: tell the person what changed and why it matters, not the play-by-play. And while he builds, Hestia keeps the workspace tidy — parking deferred work, saving decisions, catching instruction files that have gone stale.

Hestia never tells Claude *how* to code. That's his craft. Hestia only watches how he *talks about it* and what he *leaves behind*.

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
> Two reminders are injected automatically into every session. You never invoke them — they run. They're on by default; turn them off for a project with `/hestia:lean off`.

| Reminder | What it keeps in mind |
| --- | --- |
| **Keep it simple and clear** | Lead with the outcome in plain words — not the step-by-step of how Claude got there, not jargon the user didn't introduce. Terse is welcome; clarity wins when brevity would blur the meaning. Especially: when a message is the user's first look at a long run, re-ground the reader instead of continuing the working thread. |
| **Keep the workspace tidy** | Park out-of-scope finds as `hestia:later <what> — revisit when <trigger>` instead of chasing them. Save decisions and their reasoning to memory — never code or file contents. |

### On demand

| You want to… | Invoke |
| --- | --- |
| Full health check of your Claude Code setup | `/hestia:checkup` |
| Scan for stale setup files | `/hestia:freshness` |
| See all deferred `hestia:later` work | `/hestia:debt` |
| Turn the companion on or off | `/hestia:lean on\|off` |
| Check whether your rules and CLAUDE.md reach Claude | `/hestia:assess-rules` |
| Write new rules with live quality scoring | `/hestia:author-rules` |
| Fix rule formatting | `/hestia:format-rules` |
| Install the curated starter rules file | `/hestia:primer` |

---

## Quick start

```
/hestia:checkup
```

Run this in any project. Hestia inventories your entire Claude Code setup — `CLAUDE.md`, `.claude/rules`, agents, skills, commands, hooks — checks every piece, and hands back a ranked, plain-language report with a clear path to fixing each item. Every other skill is reachable from Checkup.

---

## Read-only by default

> [!NOTE]
> Hestia's audits, watchers, and analysis tools **never modify your files**. Checkup and Freshness only observe and report.

The skills that do write — `author-rules` and `format-rules` — run only on direct invocation and always show you what they intend to create before touching anything.

---

## Files Hestia creates

| Path | Purpose |
| --- | --- |
| `.hestia/` | Persistent state: lean intensity setting, freshness-nudge throttle[^1] |
| `.hestia-tmp/` | Transient audit working files, cleaned up automatically |

[^1]: Add both paths to `.gitignore` — they are local-only and should not be committed.

---

## Status

`1.6.0-beta` — two jobs: communication and housekeeping (code craft is the model's own). Housekeeping now includes event-triggered freshness watchdogs that catch instruction-file references the moment a command breaks them. Beta means validated; stable `1.0.0` follows real-world mileage across diverse projects.

---

## License

MIT — see [LICENSE](LICENSE).
