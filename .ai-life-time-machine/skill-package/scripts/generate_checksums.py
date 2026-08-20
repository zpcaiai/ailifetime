#!/usr/bin/env python3
"""Generate package-internal SHA-256 checksums."""
from __future__ import annotations
import hashlib
from pathlib import Path
R=Path(__file__).resolve().parents[1];OUT=R/'CHECKSUMS.sha256'
def main():
 rows=[]
 for p in sorted(R.rglob('*')):
  if not p.is_file() or p==OUT or '__pycache__' in p.parts or p.suffix=='.pyc':continue
  h=hashlib.sha256(p.read_bytes()).hexdigest();rows.append(f'{h}  {p.relative_to(R)}')
 OUT.write_text('\n'.join(rows)+'\n');print(f'{len(rows)} files -> {OUT}');return 0
if __name__=='__main__':raise SystemExit(main())
