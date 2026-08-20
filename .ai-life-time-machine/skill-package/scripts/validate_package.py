#!/usr/bin/env python3
"""Validate the complete AI Life Time Machine commercial project factory using the Python standard library."""
from __future__ import annotations
import argparse, ast, json, re, sys
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

EXPECTED_NAME='ai-life-time-machine-commercial-project-factory'
EXPECTED_VERSION='2.0.0'
EXPECTED_SKILLS=22
EXPECTED_BATCHES=128
EXPECTED_REQUIREMENTS=640
SKILL_RE=re.compile(r'^[a-z0-9-]{1,64}$')
BATCH_RE=re.compile(r'^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$')
REQ_RE=re.compile(r'^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])-R0[1-5]$')
REQUIRED_REF_SECTIONS=(
 'Objective','Business outcome','Invocation contract','Mandatory atomic requirements',
 'Implementation workflow','Deterministic constraints','Test plan',
 'Required artifacts and evidence','Acceptance criteria','Definition of Done')

class VError(Exception): pass

def load_json(p:Path)->Any:
 try:return json.loads(p.read_text(encoding='utf-8'))
 except Exception as e:raise VError(f'Invalid JSON {p}: {e}') from e

def load_jsonl(p:Path)->list[dict[str,Any]]:
 rows=[]
 for n,line in enumerate(p.read_text(encoding='utf-8').splitlines(),1):
  if not line.strip():continue
  try:v=json.loads(line)
  except Exception as e:raise VError(f'Invalid JSONL {p}:{n}: {e}') from e
  if not isinstance(v,dict):raise VError(f'JSONL row is not object: {p}:{n}')
  rows.append(v)
 return rows

def fm(p:Path)->dict[str,str]:
 t=p.read_text(encoding='utf-8')
 if not t.startswith('---\n'):raise VError(f'Missing frontmatter: {p}')
 end=t.find('\n---\n',4)
 if end<0:raise VError(f'Unclosed frontmatter: {p}')
 out={}
 for line in t[4:end].splitlines():
  if not line or line[0].isspace() or line.startswith('-') or ':' not in line:continue
  k,v=line.split(':',1);out[k.strip()]=v.strip().strip('"').strip("'")
 return out

def topo(batches:list[dict[str,Any]])->list[str]:
 ids={b['id'] for b in batches};ind={x:0 for x in ids};ch=defaultdict(list)
 for b in batches:
  for d in b.get('depends_on',[]):
   if d not in ids:raise VError(f"{b['id']} depends on missing {d}")
   ind[b['id']]+=1;ch[d].append(b['id'])
 q=deque(sorted([x for x,v in ind.items() if v==0],key=lambda x:int(x[1:])));out=[]
 while q:
  x=q.popleft();out.append(x)
  for c in sorted(ch[x],key=lambda x:int(x[1:])):
   ind[c]-=1
   if ind[c]==0:q.append(c)
 if len(out)!=len(ids):raise VError('Dependency cycle: '+','.join(sorted(x for x,v in ind.items() if v)))
 return out

def validate(root:Path)->tuple[list[str],list[str]]:
 errors=[];warnings=[]
 def ck(cond:bool,msg:str):
  if not cond:errors.append(msg)
 required=['README.md','INVENTORY.md','MASTER_BUILD_PROMPT.md','docs/COMPLETE_PROJECT_SCOPE.md','docs/MODULE_CATALOG.md',
 'manifest.json','manifests/skills.json','manifests/batches.json','manifests/requirements.jsonl','manifests/topological-order.json',
 'profiles/full-commercial.json','stack-profiles/reference-polyglot.json','schemas/project-profile.schema.json','contracts/openapi.yaml',
 'scripts/install_skills.py','scripts/scaffold_project.py','scripts/projectctl.py','scripts/generate_batch_prompt.py','scripts/verify_release.py']
 for x in required:ck((root/x).is_file(),f'Missing required file: {x}')
 if errors:return errors,warnings
 try:
  manifest=load_json(root/'manifest.json');skills=load_json(root/'manifests/skills.json');batches=load_json(root/'manifests/batches.json');reqs=load_jsonl(root/'manifests/requirements.jsonl');stored_topo=load_json(root/'manifests/topological-order.json')
 except VError as e:return [str(e)],warnings
 ck(manifest.get('name')==EXPECTED_NAME,'Unexpected package name')
 ck(manifest.get('version')==EXPECTED_VERSION,'Unexpected package version')
 ck(manifest.get('counts')=={'skills':EXPECTED_SKILLS,'batches':EXPECTED_BATCHES,'requirements':EXPECTED_REQUIREMENTS},'Manifest counts mismatch')
 ck(isinstance(skills,list) and len(skills)==EXPECTED_SKILLS,f'Expected {EXPECTED_SKILLS} skills')
 ck(isinstance(batches,list) and len(batches)==EXPECTED_BATCHES,f'Expected {EXPECTED_BATCHES} batches')
 ck(len(reqs)==EXPECTED_REQUIREMENTS,f'Expected {EXPECTED_REQUIREMENTS} requirements')
 ids=[b.get('id') for b in batches];expected=[f'B{i:02d}' for i in range(128)]
 ck(ids==expected,'Batches must be exactly B00 through B127 in numeric manifest order')
 ck(len(set(ids))==len(ids),'Duplicate batch IDs')
 skill_names=[s.get('name') for s in skills];ck(len(set(skill_names))==len(skill_names),'Duplicate skill names')
 skill_map={s['name']:s for s in skills if isinstance(s,dict) and s.get('name')}
 for s in skills:
  name=s.get('name','');ck(bool(SKILL_RE.fullmatch(name)),f'Invalid skill name: {name}')
  src=root/s.get('source','');ck(src.is_file(),f'Missing SKILL.md: {src}')
  ck((src.parent/'agents/openai.yaml').is_file(),f'Missing agents/openai.yaml: {name}')
  if src.is_file():
   try:front=fm(src)
   except VError as e:errors.append(str(e));continue
   ck(front.get('name')==name,f'Frontmatter name mismatch: {name}')
   ck(front.get('description')==s.get('description'),f'Frontmatter description mismatch: {name}')
   lines=src.read_text(encoding='utf-8').splitlines();ck(len(lines)<=500,f'SKILL.md exceeds 500 lines: {name}')
   ck('Evidence over assertion' in src.read_text(encoding='utf-8'),f'Missing evidence invariant: {name}')
  for bid in s.get('batches',[]):ck(bid in ids,f'{name} references unknown {bid}')
 batch_map={b['id']:b for b in batches if isinstance(b,dict) and b.get('id')}
 all_req_ids=[]
 for b in batches:
  bid=b.get('id','');ck(bool(BATCH_RE.fullmatch(bid)),f'Invalid batch ID: {bid}')
  ck(b.get('skill') in skill_map,f'{bid} unknown skill {b.get("skill")}')
  ck(bid in skill_map.get(b.get('skill'),{}).get('batches',[]),f'{bid} missing from skill manifest')
  ck(len(b.get('requirements',[]))==5,f'{bid} must have five requirements')
  expected_req=[f'{bid}-R{i:02d}' for i in range(1,6)];ck(b.get('requirement_ids')==expected_req,f'{bid} requirement IDs mismatch')
  all_req_ids.extend(expected_req)
  ref=root/b.get('reference','');ck(ref.is_file(),f'Missing reference for {bid}: {ref}')
  if ref.is_file():
   text=ref.read_text(encoding='utf-8')
   for sec in REQUIRED_REF_SECTIONS:ck(sec in text,f'{bid} missing reference section: {sec}')
   for rid in expected_req:ck(rid in text,f'{bid} reference missing {rid}')
   try:front=fm(ref);ck(front.get('id')==bid,f'{bid} reference frontmatter mismatch');ck(front.get('version')==EXPECTED_VERSION,f'{bid} reference version mismatch')
   except VError as e:errors.append(str(e))
 try:computed=topo(batches);ck(stored_topo==computed,'Stored topological order mismatch')
 except VError as e:errors.append(str(e));computed=[]
 ck(len(all_req_ids)==len(set(all_req_ids))==EXPECTED_REQUIREMENTS,'Requirement ID uniqueness/count mismatch')
 manifest_req=[r.get('id') for r in reqs];ck(manifest_req==all_req_ids,'requirements.jsonl order/content mismatch')
 for r in reqs:
  ck(bool(REQ_RE.fullmatch(r.get('id',''))),f'Invalid requirement ID {r.get("id")}')
  bid=r.get('batch_id');ck(bid in batch_map,f'Requirement references unknown batch: {r.get("id")}')
  if bid in batch_map:
   idx=int(r['id'][-2:])-1;ck(batch_map[bid]['requirements'][idx]==r.get('statement'),f'Requirement statement mismatch {r.get("id")}')
 # Profiles: JSON is canonical; YAML mirror must be byte-equivalent JSON content.
 profiles=[]
 for p in sorted((root/'profiles').glob('*.json')):
  if p.name=='index.json':continue
  try:profile=load_json(p)
  except VError as e:errors.append(str(e));continue
  profiles.append(profile);pid=profile.get('id')
  req=profile.get('required_batches',[]);ck(len(req)==len(set(req)),f'Profile duplicate batches: {pid}')
  ck(all(x in batch_map for x in req),f'Profile unknown batch: {pid}')
  reqset=set(req)
  for bid in req:
   ck(set(batch_map[bid]['depends_on']).issubset(reqset),f'Profile {pid} missing dependency of {bid}')
  stack=root/'stack-profiles'/f"{profile.get('stack_profile')}.json";ck(stack.is_file(),f'Profile {pid} missing stack profile')
  mirror=p.with_suffix('.yaml');ck(mirror.is_file(),f'Profile YAML mirror missing: {pid}')
  if mirror.is_file():
   try:ck(load_json(mirror)==profile,f'Profile YAML mirror differs: {pid}')
   except VError as e:errors.append(str(e))
 full=next((p for p in profiles if p.get('id')=='full-commercial'),None);ck(full is not None,'Missing full-commercial profile')
 if full:ck(full.get('required_batches')==computed,'full-commercial must include all Batches in topological order')
 # JSON schemas are at least valid JSON and declare object/array roots.
 for p in sorted((root/'schemas').glob('*.json')):
  try:schema=load_json(p);ck(isinstance(schema,dict) and ('$schema' in schema or 'type' in schema),f'Invalid schema shape: {p.name}')
  except VError as e:errors.append(str(e))
 # Python syntax and no hardcoded v1 limits in active scripts.
 for p in sorted((root/'scripts').glob('*.py')):
  try:ast.parse(p.read_text(encoding='utf-8'),filename=str(p))
  except SyntaxError as e:errors.append(f'Python syntax error {p}: {e}')
  text=p.read_text(encoding='utf-8')
  if p.name not in {'validate_package.py'} and ('EXPECTED_BATCHES = 51' in text or 'B00-B50' in text):warnings.append(f'Legacy wording in {p.name}')
 return errors,warnings

def main()->int:
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=ap.parse_args();root=args.root.expanduser().resolve()
 errors,warnings=validate(root)
 for x in warnings:print('WARN',x)
 if errors:
  for x in errors:print('FAIL',x,file=sys.stderr)
  print(f'Package validation failed with {len(errors)} error(s).',file=sys.stderr);return 1
 m=load_json(root/'manifest.json');print(f"PASS {m['name']} {m['version']}: {m['counts']['skills']} skills, {m['counts']['batches']} batches, {m['counts']['requirements']} requirements")
 print('PASS dependency DAG, profiles, references, schemas, and Python syntax');return 0
if __name__=='__main__':raise SystemExit(main())
