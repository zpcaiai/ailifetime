#!/usr/bin/env python3
"""Generate an execution-ready Claude Code or Codex prompt for one selected Batch."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];BATCHES=json.loads((ROOT/'manifests/batches.json').read_text());BY={b['id']:b for b in BATCHES};SKILLS={s['name']:s for s in json.loads((ROOT/'manifests/skills.json').read_text())}
def main()->int:
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--repo',required=True,type=Path);ap.add_argument('--batch',required=True,choices=sorted(BY));ap.add_argument('--host',choices=['codex','claude'],default='codex');ap.add_argument('--output',type=Path);a=ap.parse_args();repo=a.repo.expanduser().resolve();profile_path=repo/'.ai-life-time-machine/project-profile.json'
 if not profile_path.is_file():print('ERROR active project profile not found; run projectctl init',file=sys.stderr);return 2
 p=json.loads(profile_path.read_text());b=BY[a.batch]
 if a.batch not in p['required_batches']:print(f'ERROR {a.batch} excluded by profile {p["id"]}',file=sys.stderr);return 3
 inv=f"${b['skill']}" if a.host=='codex' else f"/{b['skill']}"
 dep='\n'.join(f'- `{d}` completion report: `evidence/completion/{d}.json`' for d in b['depends_on']) or '- none'
 prompt=f"""{inv}\n\n执行 {b['id']}：{b['title']}。\n\n项目配置档：`{profile_path.relative_to(repo)}`（{p['id']}）\nSkill：`.ai-life-time-machine/skill-package/skills/{b['skill']}/SKILL.md`\nBatch reference：`.ai-life-time-machine/skill-package/{b['reference']}`\n依赖：\n{dep}\n\n必须遵循：\n1. 先读取 B00 基线、当前真实仓库、配置档、Skill、Batch reference 和依赖完成报告；不得另建平行系统。\n2. 先输出文件级计划、契约/迁移、权限、失败/重试/幂等、兼容、测试、遥测和回滚，再修改代码。\n3. 完成 {', '.join(b['requirement_ids'])}；每条建立 requirement → file → symbol → test → evidence → commit 追踪。\n4. 使用仓库真实入口和沙箱依赖执行 build/lint/type/unit/integration/contract/E2E/negative/security/privacy/accessibility/performance/migration 中适用的检查；不得跳过或伪造。\n5. 证据写入 `evidence/{b['id']}/`，完成报告写入 `evidence/completion/{b['id']}.json`，不得包含真实客户照片、秘密或支付数据。\n6. 最后运行：\n   `python3 .ai-life-time-machine/skill-package/scripts/verify_release.py --repo . --batch {b['id']}`\n7. 验证不通过时状态必须为 blocked/failed，不得仅口头宣称完成。\n"""
 if a.output:
  out=a.output.expanduser();out=out.resolve() if out.is_absolute() else (repo/out).resolve();out.parent.mkdir(parents=True,exist_ok=True);out.write_text(prompt,encoding='utf-8');print(out)
 else:print(prompt)
 return 0
if __name__=='__main__':raise SystemExit(main())
