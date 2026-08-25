#!/usr/bin/env python3
"""List and filter AI Life Time Machine implementation batches."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

def package_root() -> Path:
    script = Path(__file__).resolve()
    for ancestor in script.parents:
        for candidate in (ancestor, ancestor / ".ai-life-time-machine/skill-package"):
            if (candidate / "manifest.json").is_file() and (candidate / "manifests/batches.json").is_file():
                return candidate
    raise RuntimeError("AI Life Time Machine skill package could not be located from this repository")


ROOT = package_root()
BATCHES = json.loads((ROOT / "manifests/batches.json").read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase")
    parser.add_argument("--skill")
    parser.add_argument("--criticality")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rows = [item for item in BATCHES if (not args.phase or item["phase"] == args.phase) and (not args.skill or item["skill"] == args.skill) and (not args.criticality or item["criticality"] == args.criticality)]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print(f"{'ID':<4} {'PHASE':<18} {'CRIT':<8} {'SKILL':<44} TITLE")
        for item in rows:
            print(f"{item['id']:<4} {item['phase']:<18} {item['criticality']:<8} {item['skill']:<44} {item['title']}")
        print(f"{len(rows)} batch(es)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
