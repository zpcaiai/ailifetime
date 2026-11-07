#!/usr/bin/env python3
"""Static, standard-library-only package consistency validation. NOT E3/E4."""
from pathlib import Path
import json, re, sys
root=Path(__file__).resolve().parents[1]
def load(p):return json.loads((root/p).read_text(encoding='utf-8'))
def main():
    templates=load('catalog/templates.json'); styles=load('catalog/styles.json'); cats=load('catalog/categories.json')
    valid_cats={c['id'] for c in cats}; ids=set(); errors=[]
    if len(templates)!=20:errors.append('Expected exactly 20 templates')
    if len(cats)!=12:errors.append('Expected 12 categories')
    if len(styles)!=5:errors.append('Expected five styles')
    if len(list((root/'skills').glob('*/SKILL.md')))!=12:errors.append('Expected 12 skills')
    for t in templates:
        if t['id'] in ids: errors.append(f'duplicate {t["id"]}')
        ids.add(t['id'])
        if t['category'] not in valid_cats:errors.append(f'invalid category {t["id"]}')
        if not re.fullmatch(r'1\.\d+\.\d+',t['version']):errors.append(f'invalid version {t["id"]}')
        if t['ai_mode']!='none' and t['label_policy']!='ai_required':errors.append(f'missing label {t["id"]}')
        if not t['fields'] or not t['sizes']:errors.append(f'empty fields/sizes {t["id"]}')
        fnames=[f['name'] for f in t['fields']]
        if len(fnames)!=len(set(fnames)):errors.append(f'duplicate fields {t["id"]}')
    states=load('contracts/state-machines.json')
    for machine,graph in states.items():
        for source,targets in graph.items():
            for target in targets:
                if target not in graph:errors.append(f'{machine}:{source} → nonexistent {target}')
    layout=load('examples/layout-profile.json')
    for el in layout['elements']:
        if el['x']+el['w']>1.0000001 or el['y']+el['h']>1.0000001:errors.append(f'out of canvas {el["id"]}')
    sample=load('examples/personal-intro.json')
    if sample['template_id'] not in ids:errors.append('sample invalid template')
    if sample['style_id'] not in {s['id'] for s in styles}:errors.append('sample invalid style')
    for s in (root/'contracts/schemas').glob('*.json'):
        schema=json.loads(s.read_text(encoding='utf-8'))
        if schema.get('type')!='object':errors.append(f'invalid schema root {s}')
    if errors:
        print('FAIL:',*errors,sep='\n - ');return 1
    print(f'PASS: {len(templates)} templates, {len(cats)} categories, {len(styles)} styles, 12 skills, graph references, layout bounds, schema JSON parsed')
    print('Scope: E0 package checks only. Does not validate third-party schema dialect, E3/E4 integrations, security, or business acceptance.')
    return 0
if __name__=='__main__':sys.exit(main())
