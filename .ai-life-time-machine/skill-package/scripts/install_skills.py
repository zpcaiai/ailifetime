#!/usr/bin/env python3
"""Install all or profile-selected AI Life Time Machine skills into a Claude Code/Codex repository."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
PACKAGE_ROOT=Path(__file__).resolve().parents[1]
SUPPORT_DIRNAME='.ai-life-time-machine'
HOSTS={'codex':Path('.agents/skills'),'claude':Path('.claude/skills')}
SUPPORT_DIRS=('skills','contracts','schemas','manifests','profiles','stack-profiles','templates','evals','scripts','examples','docs','tests','starter')
SUPPORT_FILES=('manifest.json','manifest.yaml','README.md','PRODUCT_BLUEPRINT.md','BUSINESS_LOOP.md','ARCHITECTURE.md','ROADMAP_AND_DEPENDENCIES.md','MASTER_BUILD_PROMPT.md','AGENTS.md.example','CLAUDE.md.example','SOURCES.md','CHANGELOG.md','LICENSE-NOTICE.md','Makefile','INVENTORY.md','CHECKSUMS.sha256','VERIFICATION_REPORT.md')

def load(p:Path):return json.loads(p.read_text(encoding='utf-8'))
def digest(p:Path)->str:
 h=hashlib.sha256()
 with p.open('rb') as f:
  for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
 return h.hexdigest()
def files(root:Path)->Iterable[Path]:
 for p in sorted(root.rglob('*')):
  if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc':yield p
def copy_bundle(dst:Path):
 dst.mkdir(parents=True,exist_ok=True)
 for n in SUPPORT_FILES:
  s=PACKAGE_ROOT/n
  if s.exists():shutil.copy2(s,dst/n)
 for n in SUPPORT_DIRS:
  s=PACKAGE_ROOT/n
  if s.exists():shutil.copytree(s,dst/n,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
def main()->int:
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--target',required=True,type=Path);ap.add_argument('--host',choices=('codex','claude','both'),default='both');ap.add_argument('--profile',default='full-commercial');ap.add_argument('--all-skills',action='store_true',help='Install all 22 skills rather than only skills used by the profile');ap.add_argument('--force',action='store_true');ap.add_argument('--dry-run',action='store_true');ap.add_argument('--skip-package-validation',action='store_true');a=ap.parse_args()
 target=a.target.expanduser().resolve()
 if not target.is_dir():print(f'ERROR invalid target: {target}',file=sys.stderr);return 2
 if not a.skip_package_validation:
  r=subprocess.run([sys.executable,str(PACKAGE_ROOT/'scripts/validate_package.py'),'--root',str(PACKAGE_ROOT)],check=False)
  if r.returncode:return r.returncode
 pp=PACKAGE_ROOT/'profiles'/f'{a.profile}.json'
 if not pp.is_file():print(f'ERROR unknown profile: {a.profile}',file=sys.stderr);return 2
 profile=load(pp);skills=load(PACKAGE_ROOT/'manifests/skills.json');batches={b['id']:b for b in load(PACKAGE_ROOT/'manifests/batches.json')}
 selected_names=[s['name'] for s in skills] if a.all_skills else sorted({batches[x]['skill'] for x in profile['required_batches']})
 hosts=['codex','claude'] if a.host=='both' else [a.host];planned=[];conflicts=[]
 for host in hosts:
  for name in selected_names:
   src=PACKAGE_ROOT/'skills'/name;dst=target/HOSTS[host]/name;planned.append((src,dst));
   if dst.exists():conflicts.append(dst)
 support=target/SUPPORT_DIRNAME/'skill-package'
 if support.exists():conflicts.append(support)
 active=target/SUPPORT_DIRNAME/'project-profile.json'
 if active.exists():conflicts.append(active)
 if conflicts and not a.force:
  print('ERROR installation conflicts; no files changed.',file=sys.stderr)
  for p in conflicts:print(' -',p,file=sys.stderr)
  print('Use --force to replace only package-owned paths.',file=sys.stderr);return 3
 print(f"Package: {load(PACKAGE_ROOT/'manifest.json')['name']} {load(PACKAGE_ROOT/'manifest.json')['version']}")
 print('Profile:',a.profile,'skills:',len(selected_names),'hosts:',','.join(hosts));print('Target:',target)
 if a.dry_run:return 0
 base=target/SUPPORT_DIRNAME;base.mkdir(parents=True,exist_ok=True);stage=Path(tempfile.mkdtemp(prefix='.install-stage-',dir=base))
 try:
  staged_skills=stage/'host-skills'
  for src,dst in planned:
   rel=dst.relative_to(target);s=staged_skills/rel;s.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(src,s)
  staged_bundle=stage/'skill-package';copy_bundle(staged_bundle);staged_profile=stage/'project-profile.json';shutil.copy2(pp,staged_profile)
  if a.force:
   for p in conflicts:
    if p.is_dir():shutil.rmtree(p)
    elif p.exists():p.unlink()
  installed=[]
  for src,dst in planned:
   s=staged_skills/dst.relative_to(target);dst.parent.mkdir(parents=True,exist_ok=True);shutil.move(str(s),str(dst))
   for f in files(dst):installed.append({'path':str(f.relative_to(target)),'sha256':digest(f)})
  shutil.move(str(staged_bundle),str(support));shutil.move(str(staged_profile),str(active))
  for f in files(support):installed.append({'path':str(f.relative_to(target)),'sha256':digest(f)})
  (base/'state').mkdir(parents=True,exist_ok=True);(target/'evidence/completion').mkdir(parents=True,exist_ok=True)
  im={'schema_version':'2.0','package':load(PACKAGE_ROOT/'manifest.json')['name'],'version':load(PACKAGE_ROOT/'manifest.json')['version'],'installed_at':datetime.now(timezone.utc).isoformat(),'target':str(target),'hosts':hosts,'profile':a.profile,'skill_names':selected_names,'support_bundle':str(support.relative_to(target)),'files':sorted(installed,key=lambda x:x['path'])}
  (base/'install-manifest.json').write_text(json.dumps(im,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
  for p in (support/'scripts').glob('*.py'):p.chmod(p.stat().st_mode|0o111)
 finally:shutil.rmtree(stage,ignore_errors=True)
 print('Installation complete.')
 print(f"Next: python3 {support/'scripts/projectctl.py'} --repo {target} init --profile {a.profile}")
 return 0
if __name__=='__main__':raise SystemExit(main())
