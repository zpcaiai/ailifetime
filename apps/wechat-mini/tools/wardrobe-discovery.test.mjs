import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {WARDROBE_STYLES,WARDROBE_SERIES} from '../../../packages/capabilities/dist/wardrobe-plan.js';
const loaded={exports:{}};runInThisContext('(function(module){'+readFileSync(new URL('../miniprogram/services/wardrobe-catalog.js',import.meta.url),'utf8')+'\n})')(loaded);
const {catalog,discover,isSeriesId,presentStyle}=loaded.exports;
export function context(age=37,count=1){return {catalogVersion:'lifetime-wardrobe.v3',targetAge:age,participants:Array.from({length:count},(_,i)=>({participantId:'person-'+i})),series:WARDROBE_SERIES,
 styles:WARDROBE_STYLES.map(s=>({...s,description:s.description||s.label,seriesId:s.seriesId||'legacy',seriesLabel:s.seriesLabel||'原有基础款',minAge:s.minAge??0,maxAge:s.maxAge??100,minPeople:s.minPeople??1,legacy:!s.seriesId,
 available:age>=(s.minAge??0)&&age<=(s.maxAge??100)&&count>=(s.minPeople??1),unavailableReason:count<(s.minPeople??1)?'需双人照片':`适用 ${s.minAge??0}–${s.maxAge??100} 岁`}))};}
test('catalog and discovery honor every age and participant boundary across all24 series',()=>{
 for(let age=0;age<=100;age++)for(const count of [1,2]){
  const c=context(age,count),groups=catalog(c),view=discover(c.styles,groups);assert.equal(view.series.length,24);assert.equal(view.styleCount,216);assert.equal(view.categories.length,7);
  for(const group of view.series){const expected=c.styles.filter(s=>s.seriesId===group.id&&s.available);assert.equal(group.count,expected.length);assert.equal(group.swatches.length,3);assert.ok(group.coverStyle.includes(group.palette[0]));}
  const visible=discover(c.styles,groups,{onlyAvailable:true}).visibleSeries;assert.ok(visible.every(g=>g.count>0));assert.equal(visible.length,view.availableSeriesCount);
 }
 const c=context(6),groups=catalog(c);assert.equal(discover(c.styles,groups,{query:'奶油软呢'}).visibleSeries[0].id,'french');
 assert.deepEqual(discover(c.styles,groups,{query:'苎麻'}).visibleSeries.map(s=>s.id),['east','ink']);
 assert.equal(discover(c.styles,groups,{category:'family'}).visibleSeries.length,3);
 assert.deepEqual(discover(c.styles,groups,{category:'family',onlyAvailable:true}).visibleSeries.map(s=>s.id),['storybook','baby']);
 assert.equal(discover(c.styles,groups,{query:'无此款式'}).visibleSeries.length,0);
 assert.ok(isSeriesId('french'));for(const id of ['../../api','a;style',null,'toString','x'.repeat(49)])assert.equal(isSeriesId(id),false);
});
test('malformed metadata, upper-age lies, unknown series and unsafe palette styles fail closed',()=>{
 for(const mutate of [c=>c.catalogVersion='future',c=>c.series=c.series.slice(1),c=>c.styles.pop(),c=>c.styles[34].available=false,
  c=>c.styles.find(s=>s.seriesId==='baby').available=true,c=>c.styles[34].seriesId='invented',c=>c.styles[34].description='',
  c=>c.series[0].palette[0]='red;position:fixed',c=>c.series[0].categoryLabel='',c=>c.styles[34].maxAge=101,c=>c.styles[34].legacy=true]){
  const c=JSON.parse(JSON.stringify(context()));mutate(c);assert.throws(()=>catalog(c),/CONTEXT_INVALID/);
 }
});
test('historical v1 context remains browsable with the original eight groups',()=>{
 const c=context();c.catalogVersion='lifetime-wardrobe.v1';c.styles=c.styles.slice(0,34);delete c.series;
 const groups=catalog(c);assert.equal(groups.length,8);assert.equal(discover(c.styles,groups).styleCount,31);
});
test('mini view exposes collection controls, real descriptions and illustrative card labels',()=>{
 const view=readFileSync(new URL('../miniprogram/pages/wardrobe/index.wxml',import.meta.url),'utf8');
 for(const binding of ['searchSeries','filterCategory','filterAvailable','clearDiscovery','visibleSeries','selectedSeries.tagline','focusedTemplate.features','item.previewSrc','focusedTemplate.previewSrc','seriesItem.availability','seriesItem.coverStyle'])assert.ok(view.includes(binding),binding);
 assert.ok(view.includes('AI 衣着预览'));assert.ok(view.includes('maxlength="40"'));assert.ok(view.includes('aria-label="搜索衣橱系列'));
 const css=readFileSync(new URL('../miniprogram/pages/wardrobe/index.wxss',import.meta.url),'utf8');assert.ok(css.includes('calc(50% - 5px)'));assert.ok(css.includes('white-space: normal'));assert.ok(css.includes('min-width: 0'));
});

test('series covers, grid thumbnails and detail preserve square photos without cropping', () => {
 const view = readFileSync(new URL('../miniprogram/pages/wardrobe/index.wxml', import.meta.url), 'utf8');
 const css = readFileSync(new URL('../miniprogram/pages/wardrobe/index.wxss', import.meta.url), 'utf8');
 for (const binding of ['seriesItem.coverLooks[0].previewSrc', 'look.previewSrc', 'item.previewSrc', 'focusedTemplate.previewSrc']) {
  const image = [...view.matchAll(/<image\s[^>]*\/>/gu)].find(([element]) => element.includes(`src="{{${binding}}}"`));
  assert.ok(image, binding);
  assert.match(image[0], /\bmode="aspectFit"/u, binding);
 }
 assert.match(css, /\.wardrobe-image::before\s*\{[^}]*padding-top:\s*100%/u);
 assert.match(css, /\.template-tile\s*\{[^}]*33\.333%/u);
});

test('v2 history and nine-look presentation retain bounded readable covers and distinct garment designs',()=>{
 const c=context();const older={...c,catalogVersion:'lifetime-wardrobe.v2',styles:c.styles.slice(0,98)};assert.equal(discover(older.styles,catalog(older)).styleCount,95);
 const groups=catalog(c),v=discover(c.styles,groups);const shapes=new Set(),textures=new Set();
 for(const group of v.series){const styles=c.styles.filter(s=>s.seriesId===group.id);assert.equal(group.totalCount,9);assert.equal(group.coverLooks.length,3);assert.ok(group.lookNames.length<65);
  styles.forEach((s,i)=>{const p=presentStyle(s,i,group.palette);assert.equal(p.ordinal,String(i+1).padStart(2,'0'));assert.ok(p.features.length>=1);assert.ok(/^--garment:#[a-fA-F0-9]{6};/.test(p.illustrationStyle));shapes.add(p.silhouette);textures.add(p.texture);});
 }assert.ok(shapes.size>=8);assert.ok(textures.size>=6);
});

test('all 216 catalog looks have a distinct bundled photo used by the grid and detail', () => {
 const groups = discover(context().styles, WARDROBE_SERIES).series;
 const program = new URL('../miniprogram/', import.meta.url);
 const directory = new URL('assets/wardrobe/', program);
 const assets = new Set(readdirSync(directory));
 const hashes = new Set();
 for (const group of groups) {
  const styles = WARDROBE_STYLES.filter(style => style.seriesId === group.id);
  assert.equal(styles.length, 9);
  for (const [index, style] of styles.entries()) {
   const { previewSrc } = presentStyle(style, index, group.palette);
   assert.equal(previewSrc, `/assets/wardrobe/${style.id}.webp`);
   assert.ok(assets.delete(`${style.id}.webp`), style.id);
   const bytes = readFileSync(new URL(previewSrc.slice(1), program));
   assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
   assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
   hashes.add(createHash('sha256').update(bytes).digest('hex'));
  }
 }
 assert.equal(assets.size, 0);
 assert.equal(hashes.size, 216);
 const packageBytes = readdirSync(program, { recursive: true })
  .map(path => statSync(new URL(path, program)))
  .reduce((total, stat) => total + (stat.isFile() ? stat.size : 0), 0);
 assert.ok(packageBytes <= 2_000_000, `Mini Program package is ${packageBytes} bytes`);
});
