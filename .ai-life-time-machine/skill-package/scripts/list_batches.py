#!/usr/bin/env python3
"""List and filter package Batches."""
from __future__ import annotations
import argparse,json
from pathlib import Path
R=Path(__file__).resolve().parents[1];B=json.loads((R/'manifests/batches.json').read_text());O=json.loads((R/'manifests/topological-order.json').read_text());BY={x['id']:x for x in B}
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--profile');ap.add_argument('--skill');ap.add_argument('--phase');ap.add_argument('--json',action='store_true');a=ap.parse_args();allowed=set(O)
 if a.profile:allowed&=set(json.loads((R/'profiles'/f'{a.profile}.json').read_text())['required_batches'])
 rows=[BY[x] for x in O if x in allowed and (not a.skill or BY[x]['skill']==a.skill) and (not a.phase or BY[x]['phase']==a.phase)]
 if a.json:print(json.dumps(rows,ensure_ascii=False,indent=2))
 else:
  for b in rows:print(f"{b['id']}\t{b['phase']}\t{b['skill']}\t{b['title']}")
 return 0
if __name__=='__main__':raise SystemExit(main())
