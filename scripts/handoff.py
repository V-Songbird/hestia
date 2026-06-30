#!/usr/bin/env python3
"""Detect + prepare handoff — Hestia's orchestration core.

Hestia detects config drift but does not repair it; the repair belongs to the
plugin that owns the artifact. Claude Code exposes NO programmatic cross-plugin
invocation API (verified against the plugins reference), so a handoff is three
deterministic steps, none of which invoke another plugin directly:

  1. look up the owning tool for a drift class in the routing table
     (scripts/_data/handoff_routes.json),
  2. STAGE a payload under .hestia/handoffs/ — the locator, the stale items, and
     (where known) the correct values the owner needs to act, and
  3. let the caller surface the route's one-line ``action`` so the user, or
     Claude's description-matching delegation, triggers the target.

Modes (JSON in on stdin where noted, JSON out on stdout):
  routes            Emit the routing table.
  stage   (stdin)   Record a decided handoff. Payload: {drift_class, locator,
                    items[], correct_values?}. Returns the written record + path.
  list              Summarize pending staged handoffs under .hestia/handoffs/.
  clear   (stdin)   Remove a staged handoff by id ({id}) — or all if {"all": true}.

State lives under .hestia/ (gitignored, local — never committed). Read-only with
respect to the user's project. Standard library only. Python 3.10+.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import emit, find_project_root, load_data, read_stdin_json, rel  # noqa: E402

HANDOFF_DIR = ".hestia/handoffs"


def routes() -> dict:
    """The routing table (drift class -> owning plugin + payload + action)."""
    try:
        return load_data("handoff_routes")
    except (OSError, ValueError):
        return {"routes": []}


def _route_for(drift_class: str) -> dict | None:
    for r in routes().get("routes", []):
        if r.get("drift_class") == drift_class:
            return r
    return None


def _handoff_id(drift_class: str, locator: str, items: list) -> str:
    basis = f"{drift_class}|{locator}|{json.dumps(items, sort_keys=True, ensure_ascii=False)}"
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:8]


def stage(payload: dict, root: Path) -> dict:
    """Record a decided handoff. Deterministic id from class+locator+items, so
    re-staging the identical finding overwrites rather than duplicates."""
    drift_class = str(payload.get("drift_class") or "")
    locator = str(payload.get("locator") or "")
    items = payload.get("items") or []
    route = _route_for(drift_class)
    hid = _handoff_id(drift_class, locator, items)

    record = {
        "id": hid,
        "drift_class": drift_class,
        "locator": locator,
        "items": items,
        "correct_values": payload.get("correct_values"),
        "owner_plugin": route.get("owner_plugin") if route else None,
        "target": route.get("target") if route else None,
        "install_hint": route.get("install_hint") if route else None,
        "action": route.get("action") if route else
        "No registered owner for this drift class — surface the finding to the user directly.",
        "caveat": route.get("caveat") if route else None,
        "routed": route is not None,
        "staged_at": datetime.now(timezone.utc).isoformat(),
    }
    out = Path(root) / HANDOFF_DIR / f"{drift_class or 'unrouted'}-{hid}.json"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        return {"status": "failed", "reason": str(e)}
    return {"status": "staged", "path": rel(out, root), "record": record}


def list_pending(root: Path) -> dict:
    d = Path(root) / HANDOFF_DIR
    out: list[dict] = []
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
    # Group the human-facing summary by owner so a report can route at a glance.
    by_owner: dict[str, int] = {}
    for h in out:
        by_owner[h.get("owner_plugin") or "(unrouted)"] = by_owner.get(h.get("owner_plugin") or "(unrouted)", 0) + 1
    return {"status": "ok", "count": len(out), "by_owner": by_owner, "handoffs": out}


def clear(payload: dict, root: Path) -> dict:
    d = Path(root) / HANDOFF_DIR
    if not d.is_dir():
        return {"status": "ok", "removed": 0}
    removed = 0
    if payload.get("all"):
        for p in d.glob("*.json"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
        return {"status": "ok", "removed": removed}
    hid = str(payload.get("id") or "")
    if not hid:
        return {"status": "failed", "reason": "clear needs an id or {\"all\": true}"}
    for p in d.glob(f"*-{hid}.json"):
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    return {"status": "ok", "removed": removed}


def main() -> None:
    ap = argparse.ArgumentParser(description="Hestia detect-and-route handoff stager.")
    ap.add_argument("mode", choices=["routes", "stage", "list", "clear"])
    ap.add_argument("--project-root", default=None)
    args = ap.parse_args()

    # Force UTF-8 stdout so the human-facing action strings (em dashes etc.)
    # survive a non-UTF-8 console locale, regardless of the caller's environment.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    root = find_project_root(args.project_root) if args.project_root is None else Path(args.project_root).resolve()

    if args.mode == "routes":
        emit(routes())
    elif args.mode == "stage":
        emit(stage(read_stdin_json() or {}, root))
    elif args.mode == "list":
        emit(list_pending(root))
    elif args.mode == "clear":
        emit(clear(read_stdin_json() or {}, root))


if __name__ == "__main__":
    main()
