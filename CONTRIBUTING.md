# Contributing

Hestia is a Claude Code plugin, currently maintained by a single author. Contributions are welcome in the form of bug reports, suggestions, and pull requests.

## Before opening a PR

- Check existing issues first — the problem may already be tracked or intentionally deferred.
- For substantial changes (new skills, significant refactors), open an issue first to align on direction before writing code.

## Project structure

```
hestia/
├── .claude-plugin/
│   └── plugin.json        # name, description, author, keywords
├── CHANGELOG.md           # Keep a Changelog format
├── LICENSE                # MIT
├── skills/
│   └── skill-name/
│       ├── SKILL.md       # Claude Code skill definition
│       └── references/    # Reference files loaded by the skill
├── hooks/
│   ├── hooks.json         # Hook wiring (SessionStart, SubagentStart, etc.)
│   ├── companion-inject.py
│   └── freshness-nudge.py
├── scripts/               # Python modules (rules engine, audit pipeline)
└── tests/                 # pytest test suite
```

## Tests

Run tests before submitting:

```
pytest tests/ -v
```

PRs that change script behavior without updating tests will not be merged.

## Changelog

Add an entry to `CHANGELOG.md` under `[Unreleased]` for every user-visible change. Follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version bumps happen at release time, not per-PR.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
