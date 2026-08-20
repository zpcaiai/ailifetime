#!/usr/bin/env python3
"""Render a profile-specific implementation backlog as Markdown."""
from __future__ import annotations
import argparse,json
from pathlib import Path
R=Path(__file__).resolve().parents[1];B={x['id']:x for x in json.loads((R/'manifests/batches.json').read_text())};O=json.loads((R/'manifests/topological-order.json').read_text())
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--profile',default='full-commercial');ap.add_argument('--output',type=Path);a=ap.parse_args();p=json.loads((R/'profiles'/f'{a.profile}.json').read_text());required=set(p['required_batches']);lines=[f"# {p['title']} implementation backlog",'',p['description'],'',f"Required Batches: **{len(required)}**",'', '| Order | Batch | Phase | Skill | Title | Dependencies |','|---:|---|---|---|---|---|']
 n=0
 for bid in O:
  if bid not in required:continue
  n+=1;b=B[bid];lines.append(f"| {n} | {bid} | {b['phase']} | `{b['skill']}` | {b['title']} | {', '.join(b['depends_on']) or 'none'} |")
 text='\n'.join(lines)+'\n'
 if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(text,encoding='utf-8');print(a.output)
 else:print(text)
 return 0
if __name__=='__main__':raise SystemExit(main())
