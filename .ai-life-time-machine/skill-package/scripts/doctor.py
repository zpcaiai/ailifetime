#!/usr/bin/env python3
"""Inspect project-factory prerequisites without modifying the repository."""
from __future__ import annotations
import argparse,shutil,subprocess,sys
from pathlib import Path
TOOLS=['git','docker','node','pnpm','java','gradle','python3','flutter','xcodebuild']
def version(cmd):
 for flag in ['--version','-version']:
  try:r=subprocess.run([cmd,flag],text=True,capture_output=True,timeout=8,check=False);s=(r.stdout or r.stderr).splitlines();
  except Exception:continue
  if s:return s[0][:160]
 return 'version unavailable'
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);a=ap.parse_args();required={'git','python3'};bad=False
 for t in TOOLS:
  p=shutil.which(t);status='FOUND' if p else ('MISSING-REQUIRED' if t in required else 'OPTIONAL-MISSING');print(f'{status:<17}{t:<12}{version(p) if p else ""}')
  if not p and t in required:bad=True
 r=subprocess.run([sys.executable,str(a.root/'scripts/validate_package.py'),'--root',str(a.root)],check=False);return 1 if bad or r.returncode else 0
if __name__=='__main__':raise SystemExit(main())
