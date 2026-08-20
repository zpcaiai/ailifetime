#!/usr/bin/env python3
"""Safely remove files recorded by this package's install manifest."""
from __future__ import annotations
import argparse, hashlib, json, shutil, sys
from pathlib import Path

def sha(p:Path):
 h=hashlib.sha256();h.update(p.read_bytes());return h.hexdigest()
def main()->int:
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--target',required=True,type=Path);ap.add_argument('--force-modified',action='store_true');a=ap.parse_args();root=a.target.expanduser().resolve();base=root/'.ai-life-time-machine';mp=base/'install-manifest.json'
 if not mp.is_file():print('ERROR install manifest not found',file=sys.stderr);return 2
 m=json.loads(mp.read_text());modified=[];removed=0
 for item in sorted(m.get('files',[]),key=lambda x:len(x['path']),reverse=True):
  p=(root/item['path']).resolve()
  try:p.relative_to(root)
  except ValueError:continue
  if not p.is_file():continue
  if sha(p)!=item['sha256'] and not a.force_modified:modified.append(p);continue
  p.unlink();removed+=1
 for name in m.get('skill_names',[]):
  for d in [root/'.agents/skills'/name,root/'.claude/skills'/name]:
   if d.exists() and not any(d.rglob('*')):d.rmdir()
 if modified:
  print('Preserved modified files:')
  for p in modified:print(' -',p)
 if not modified or a.force_modified:
  shutil.rmtree(base/'skill-package',ignore_errors=True)
  for p in [base/'project-profile.json',mp]:
   if p.exists():p.unlink()
 print(f'Removed {removed} recorded files.');return 0
if __name__=='__main__':raise SystemExit(main())
