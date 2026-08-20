#!/usr/bin/env python3
"""Profile-aware orchestration for B00-B127 across Claude Code/Codex worktrees."""
from __future__ import annotations
import argparse, contextlib, hashlib, json, os, subprocess, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
PACKAGE_ROOT=Path(__file__).resolve().parents[1]
PACKAGE=json.loads((PACKAGE_ROOT/'manifest.json').read_text(encoding='utf-8'))
BATCHES=json.loads((PACKAGE_ROOT/'manifests/batches.json').read_text(encoding='utf-8'));BY_ID={b['id']:b for b in BATCHES}
TOPO=json.loads((PACKAGE_ROOT/'manifests/topological-order.json').read_text(encoding='utf-8'));DONE={'merged','certified'}
def now():return datetime.now(timezone.utc).isoformat()
def git(repo:Path,*args:str):
 r=subprocess.run(['git','-C',str(repo),*args],text=True,capture_output=True,check=False);return r.stdout.strip() if r.returncode==0 else 'unknown'
def atomic(path:Path,obj:dict):
 path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix(path.suffix+f'.{os.getpid()}.tmp');tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n');os.replace(tmp,path)
@contextlib.contextmanager
def lock(path:Path,timeout=10.0)->Iterator[None]:
 lp=path.with_suffix(path.suffix+'.lock');lp.parent.mkdir(parents=True,exist_ok=True);end=time.monotonic()+timeout;fd=None
 while fd is None:
  try:fd=os.open(lp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  except FileExistsError:
   if time.monotonic()>end:raise RuntimeError(f'lock timeout: {lp}')
   time.sleep(.1)
 try:os.write(fd,f'pid={os.getpid()} {now()}\n'.encode());yield
 finally:
  if fd is not None:os.close(fd)
  with contextlib.suppress(FileNotFoundError):lp.unlink()
def profile_path(repo:Path,pid:str|None)->Path:
 if pid:return PACKAGE_ROOT/'profiles'/f'{pid}.json'
 active=repo/'.ai-life-time-machine/project-profile.json'
 return active if active.is_file() else PACKAGE_ROOT/'profiles/full-commercial.json'
def load_profile(repo:Path,pid:str|None=None)->dict:
 p=profile_path(repo,pid)
 if not p.is_file():raise RuntimeError(f'profile not found: {p}')
 return json.loads(p.read_text())
def refresh(s:dict):
 for bid in TOPO:
  r=s['batches'][bid]
  if not r['included']:
   r['state']='excluded';continue
  if r['state'] not in {'planned','ready'}:continue
  r['state']='ready' if all(s['batches'][d]['state'] in DONE for d in BY_ID[bid]['depends_on']) else 'planned'
 s['updated_at']=now();s['revision']=s.get('revision',0)+1
def show(s:dict,ready=False,as_json=False):
 rows=[]
 for bid in TOPO:
  r=s['batches'][bid]
  if ready and r['state']!='ready':continue
  b=BY_ID[bid];rows.append({'id':bid,'state':r['state'],'phase':b['phase'],'skill':b['skill'],'title':b['title'],'depends_on':b['depends_on'],'owner':r.get('lease_owner'),'branch':r.get('branch')})
 if as_json:print(json.dumps(rows,ensure_ascii=False,indent=2));return
 print(f"Profile: {s['profile_id']} | included {sum(1 for x in s['batches'].values() if x['included'])}/{len(s['batches'])}")
 print(f"{'ID':<5}{'STATE':<11}{'PHASE':<24}TITLE")
 for x in rows:print(f"{x['id']:<5}{x['state']:<11}{x['phase']:<24}{x['title']}")
def load_state(p:Path):
 if not p.is_file():raise RuntimeError(f'state not initialized: {p}')
 return json.loads(p.read_text())
def verify(repo:Path,bid:str,report:Path):
 r=subprocess.run([sys.executable,str(PACKAGE_ROOT/'scripts/verify_release.py'),'--repo',str(repo),'--batch',bid,'--report',str(report)],check=False)
 if r.returncode:raise RuntimeError(f'report verification failed: {bid}')
def safe_report(repo:Path,v:str)->Path:
 p=Path(v).expanduser();p=p.resolve() if p.is_absolute() else (repo/p).resolve()
 try:p.relative_to(repo)
 except ValueError:raise RuntimeError('report escapes repo')
 return p
def parser():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--repo',required=True,type=Path);ap.add_argument('--state',type=Path);ap.add_argument('--json',action='store_true');sp=ap.add_subparsers(dest='cmd',required=True)
 i=sp.add_parser('init');i.add_argument('--profile',default=None);i.add_argument('--force',action='store_true')
 sp.add_parser('status');sp.add_parser('ready');sp.add_parser('profile-list');ps=sp.add_parser('profile-show');ps.add_argument('--profile')
 p=sp.add_parser('prompt');p.add_argument('batch_id',choices=TOPO);p.add_argument('--host',choices=['codex','claude'],default='codex');p.add_argument('--output',type=Path)
 p=sp.add_parser('worktree-plan');p.add_argument('batch_id',choices=TOPO);p.add_argument('--base')
 p=sp.add_parser('start');p.add_argument('batch_id',choices=TOPO);p.add_argument('--owner',required=True);p.add_argument('--worktree',required=True);p.add_argument('--branch',required=True);p.add_argument('--lease-minutes',type=int,default=180)
 p=sp.add_parser('finish');p.add_argument('batch_id',choices=TOPO);p.add_argument('--report',required=True)
 p=sp.add_parser('mark-merged');p.add_argument('batch_id',choices=TOPO);p.add_argument('--commit')
 p=sp.add_parser('certify');p.add_argument('batch_id',choices=TOPO);p.add_argument('--certificate',required=True)
 p=sp.add_parser('block');p.add_argument('batch_id',choices=TOPO);p.add_argument('--note',required=True)
 p=sp.add_parser('reset');p.add_argument('batch_id',choices=TOPO);p.add_argument('--note',required=True)
 p=sp.add_parser('certify-profile');p.add_argument('--certificate',required=True);p.add_argument('--reports-dir',default='evidence/completion')
 return ap
def main()->int:
 a=parser().parse_args();repo=a.repo.expanduser().resolve()
 if not repo.is_dir():print('ERROR invalid repo',file=sys.stderr);return 2
 if a.cmd=='profile-list':
  rows=[]
  for p in sorted((PACKAGE_ROOT/'profiles').glob('*.json')):
   if p.name=='index.json':continue
   x=json.loads(p.read_text());rows.append({'id':x['id'],'title':x['title'],'required_batches':len(x['required_batches']),'release_gate':x['required_release_gate']})
  print(json.dumps(rows,ensure_ascii=False,indent=2) if a.json else '\n'.join(f"{x['id']:<22}{x['required_batches']:<5}{x['title']}" for x in rows));return 0
 if a.cmd=='profile-show':
  p=load_profile(repo,a.profile);print(json.dumps(p,ensure_ascii=False,indent=2));return 0
 state_path=a.state.expanduser().resolve() if a.state else repo/'.ai-life-time-machine/state/orchestration.json'
 try:
  with lock(state_path):
   if a.cmd=='init':
    if state_path.exists() and not a.force:raise RuntimeError('state exists; use --force')
    p=load_profile(repo,a.profile);required=set(p['required_batches'])
    state={'schema_version':'2.0','package':PACKAGE['name'],'package_version':PACKAGE['version'],'profile_id':p['id'],'profile_sha256':hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest(),'repo_root':str(repo),'base_commit':git(repo,'rev-parse','HEAD'),'revision':0,'updated_at':now(),'batches':{bid:{'included':bid in required,'state':'planned' if bid in required else 'excluded','worktree':None,'branch':None,'lease_owner':None,'lease_expires_at':None,'completion_report':None,'notes':None} for bid in TOPO}}
    active=repo/'.ai-life-time-machine/project-profile.json';active.parent.mkdir(parents=True,exist_ok=True);active.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n')
    refresh(state);atomic(state_path,state);print('Initialized',state_path);show(state,ready=True,as_json=a.json);return 0
   state=load_state(state_path);refresh(state)
   if a.cmd in {'status','ready'}:atomic(state_path,state);show(state,ready=a.cmd=='ready',as_json=a.json);return 0
   if a.cmd=='certify-profile':
    reports=(repo/Path(a.reports_dir)).resolve();hashes={};errors=[]
    for bid in TOPO:
     if not state['batches'][bid]['included']:continue
     rp=reports/f'{bid}.json'
     try:verify(repo,bid,rp);hashes[bid]=hashlib.sha256(rp.read_bytes()).hexdigest()
     except Exception as e:errors.append(f'{bid}: {e}')
    if errors:raise RuntimeError('profile certification failed:\n'+'\n'.join(errors))
    cp=safe_report(repo,a.certificate);cp.parent.mkdir(parents=True,exist_ok=True);cert={'schema_version':'2.0','package':PACKAGE['name'],'package_version':PACKAGE['version'],'profile_id':state['profile_id'],'status':'passed','repository_commit':git(repo,'rev-parse','HEAD'),'issued_at':now(),'reports':hashes};cp.write_text(json.dumps(cert,ensure_ascii=False,indent=2)+'\n');print('Certificate:',cp);return 0
   bid=a.batch_id;r=state['batches'][bid]
   if not r['included']:raise RuntimeError(f'{bid} is excluded by profile {state["profile_id"]}')
   if a.cmd=='prompt':
    cmd=[sys.executable,str(PACKAGE_ROOT/'scripts/generate_batch_prompt.py'),'--repo',str(repo),'--batch',bid,'--host',a.host]
    if a.output:cmd.extend(['--output',str(a.output)])
    return subprocess.run(cmd,check=False).returncode
   if a.cmd=='worktree-plan':
    if r['state']!='ready':raise RuntimeError(f'{bid} is {r["state"]}, not ready')
    branch=f'feat/ai-life-time-machine-{bid.lower()}';worktree=repo.parent/f'{repo.name}-{bid.lower()}';base=a.base or state['base_commit']
    print(f'git -C {repo} worktree add -b {branch} {worktree} {base}');print(f'python3 {PACKAGE_ROOT/"scripts/projectctl.py"} --repo {repo} start {bid} --owner <agent> --worktree {worktree} --branch {branch}');return 0
   if a.cmd=='start':
    if r['state']!='ready':raise RuntimeError(f'{bid} is {r["state"]}, not ready')
    if a.lease_minutes<=0:raise RuntimeError('lease must be positive')
    r.update({'state':'running','worktree':str(Path(a.worktree).expanduser().resolve()),'branch':a.branch,'lease_owner':a.owner,'lease_expires_at':(datetime.now(timezone.utc)+timedelta(minutes=a.lease_minutes)).isoformat(),'notes':None})
   elif a.cmd=='finish':
    if r['state']!='running':raise RuntimeError(f'{bid} is not running')
    rp=safe_report(repo,a.report);verify(repo,bid,rp);r.update({'state':'review','completion_report':str(rp),'lease_expires_at':None})
   elif a.cmd=='mark-merged':
    if r['state']!='review':raise RuntimeError(f'{bid} is not review')
    r.update({'state':'merged','notes':f"merged_commit={a.commit or git(repo,'rev-parse','HEAD')}",'lease_owner':None,'lease_expires_at':None})
   elif a.cmd=='certify':
    if r['state'] not in {'review','merged'}:raise RuntimeError(f'{bid} is not review/merged')
    cp=safe_report(repo,a.certificate)
    if not cp.is_file():raise RuntimeError('certificate missing')
    r.update({'state':'certified','notes':f'certificate={cp}','lease_owner':None,'lease_expires_at':None})
   elif a.cmd=='block':
    if r['state'] in DONE:raise RuntimeError('cannot block completed batch')
    r.update({'state':'blocked','notes':a.note,'lease_expires_at':None})
   elif a.cmd=='reset':
    if r['state'] in DONE:raise RuntimeError('cannot reset completed batch')
    r.update({'state':'planned','worktree':None,'branch':None,'lease_owner':None,'lease_expires_at':None,'completion_report':None,'notes':a.note})
   refresh(state);atomic(state_path,state);print(f'{bid}: {state["batches"][bid]["state"]}');return 0
 except (RuntimeError,OSError,json.JSONDecodeError) as e:print('ERROR:',e,file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
