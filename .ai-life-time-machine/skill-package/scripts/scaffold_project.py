#!/usr/bin/env python3
"""Create a safe new project skeleton or attach the project factory to an existing repository."""
from __future__ import annotations
import argparse, json, shutil, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def copy_template(src:Path,dst:Path,vars:dict[str,str],overwrite:bool):
 if dst.exists() and not overwrite:return False
 dst.parent.mkdir(parents=True,exist_ok=True);text=src.read_text(encoding='utf-8')
 for k,v in vars.items():text=text.replace('{{'+k+'}}',v)
 dst.write_text(text,encoding='utf-8');return True
def main()->int:
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--target',required=True,type=Path);ap.add_argument('--mode',choices=['new','adapt'],default='new');ap.add_argument('--profile',default='full-commercial');ap.add_argument('--stack',default='reference-polyglot');ap.add_argument('--project-name',default='AI Life Time Machine');ap.add_argument('--host',choices=['codex','claude','both'],default='both');ap.add_argument('--force-known-files',action='store_true');ap.add_argument('--git-init',action='store_true');a=ap.parse_args()
 target=a.target.expanduser().resolve();pp=ROOT/'profiles'/f'{a.profile}.json';sp=ROOT/'stack-profiles'/f'{a.stack}.json'
 if not pp.is_file() or not sp.is_file():print('ERROR unknown profile/stack',file=sys.stderr);return 2
 if a.mode=='new':
  target.mkdir(parents=True,exist_ok=True)
  if any(target.iterdir()) and not a.force_known_files:print('ERROR new-mode target is not empty; use adapt or --force-known-files',file=sys.stderr);return 3
 elif not target.is_dir():print('ERROR adapt target does not exist',file=sys.stderr);return 2
 vars={'PROJECT_NAME':a.project_name,'PROFILE':a.profile,'STACK':a.stack,'MODE':a.mode};created=[]
 if a.mode=='new':
  base=ROOT/'starter/repository'
  for src in sorted(base.rglob('*')):
   if not src.is_file():continue
   rel=src.relative_to(base);name=rel.name[:-5] if rel.name.endswith('.tmpl') else rel.name;dst=target/rel.parent/name
   if copy_template(src,dst,vars,a.force_known_files):created.append(str(dst.relative_to(target)))
  for d in ['apps/marketing-site','apps/consumer-web','apps/partner-portal','apps/admin-console','apps/developer-portal','apps/mobile','apps/wechat-mini','apps/kiosk','services/control-plane','services/media-worker','services/notification-worker','services/billing-worker','services/fulfillment-worker','services/integration-gateway','services/analytics-pipeline','packages/contracts','packages/design-system','packages/sdk-ts','packages/sdk-java','packages/sdk-python','tools','infra/local','infra/iac','docs/architecture','evidence/completion']:(target/d).mkdir(parents=True,exist_ok=True)
 cmd=[sys.executable,str(ROOT/'scripts/install_skills.py'),'--target',str(target),'--host',a.host,'--profile',a.profile,'--all-skills']
 if a.force_known_files:cmd.append('--force')
 r=subprocess.run(cmd,check=False)
 if r.returncode:return r.returncode
 active=target/'.ai-life-time-machine';shutil.copy2(pp,active/'project-profile.json');shutil.copy2(sp,active/'stack-profile.json')
 factory={'schema_version':'2.0','package':'ai-life-time-machine-commercial-project-factory','package_version':'2.0.0','project_name':a.project_name,'mode':a.mode,'profile':a.profile,'stack':a.stack,'scaffolded_files':created}
 (active/'project-factory.json').write_text(json.dumps(factory,ensure_ascii=False,indent=2)+'\n')
 r=subprocess.run([sys.executable,str(active/'skill-package/scripts/projectctl.py'),'--repo',str(target),'init','--profile',a.profile,'--force'],check=False)
 if r.returncode:return r.returncode
 if a.git_init and not (target/'.git').exists():subprocess.run(['git','-C',str(target),'init'],check=False)
 print(f'Scaffold complete: {target} ({a.mode}, {a.profile}, {a.stack})');return 0
if __name__=='__main__':raise SystemExit(main())
