import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { WARDROBE_STYLES, WARDROBE_SERIES, WARDROBE_CATALOG_VERSION, wardrobeStylesForCatalog, parseWardrobeEdit, buildWardrobePlan, wardrobeBinding } from '../../../packages/capabilities/dist/wardrobe-plan.js';
const image={id:'age-image',sha256:'a'.repeat(64),mimeType:'image/png',width:64,height:64,byteLength:100};
const edit=(style,age,count)=>({schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,sourceImage:image,selections:Array.from({length:count},(_,i)=>({participantId:i?'partner':'user',styleId:style.id}))});
test('all eight series contain every approved look and legacy IDs remain unchanged',()=>{
 assert.equal(createHash('sha256').update(JSON.stringify(WARDROBE_STYLES.slice(0,34))).digest('hex'),'198555e1e7e8180cceac78638eb291bfa83a90d14210c5e8edd308c6186904cf');
 const expected={east:['素雅盘扣','宋风日常','旗袍长衫','改良汉服'],retro:['八十年代衣着','九十年代港风','千禧牛仔','经典白衬衫'],together:['同色针织','白衬衫','经典风衣','银发对服'],daily:['白衬衫','奶油针织','亚麻衬衣','简约西装'],wedding:['简约婚纱西装','复古婚礼','中式礼服','银婚金婚'],milestone:['毕业纪念','初入职场','生日礼服','退休纪念'],winter:['毛呢','围巾','针织','羽绒'],newyear:['喜庆中式','红色针织','情侣对服']};
 const modern=WARDROBE_STYLES.slice(0,34).filter(s=>s.seriesId);assert.equal(modern.length,31);assert.equal(new Set(WARDROBE_STYLES.map(s=>s.id)).size,219);
 for(const [id,labels] of Object.entries(expected))assert.deepEqual(modern.filter(s=>s.seriesId===id).map(s=>s.label),labels);
 assert.deepEqual(WARDROBE_STYLES.slice(0,3).map(s=>[s.id,s.instruction]),[['casual','plain comfortable everyday clothing, natural fabric and fit'],['formal',"neat formal portrait clothing, tailored appropriately to the subject's age"],['traditional','modest Chinese-style portrait clothing with age-appropriate fabric, coverage and fit']]);
});
test('every look enforces all integer ages and one/two people, binds exact template and deterministic recovery',()=>{
 const fingerprints=new Set();
 for(const style of WARDROBE_STYLES){for(let age=0;age<=100;age++)for(const count of [1,2]){
  const value=edit(style,age,count),allowed=age>=(style.minAge??0)&&age<=(style.maxAge??100)&&count>=(style.minPeople??1);
  if(!allowed){assert.throws(()=>parseWardrobeEdit(value),/incompatible/);continue;}
  assert.deepEqual(parseWardrobeEdit(value),value);
 }
 const value=edit(style,Math.min(style.maxAge??100,Math.max(37,style.minAge??0)),style.minPeople??1),input={sourceAssetId:'source',participantIds:value.selections.map(s=>s.participantId),targetAges:[value.targetAge],seed:'catalog-seed',promptPolicyVersion:'wardrobe-only.v1',wardrobeEdit:value};
 const plan=buildWardrobePlan(input);assert.deepEqual(plan,buildWardrobePlan(input));assert.equal(plan.wardrobePolicy.selections[0].instruction,style.instruction);assert.deepEqual(plan.wardrobeBinding,wardrobeBinding(value));assert.match(plan.wardrobePolicy.instruction,/background, lighting/);fingerprints.add(plan.wardrobeBinding.selectionsSha256);
 }
 assert.equal(fingerprints.size,219);
 const unknown={...WARDROBE_STYLES[3],id:'east-pankou-v2'};assert.throws(()=>parseWardrobeEdit(edit(unknown,37,1)),/unknown/);
});
test('curated24 series contain216 distinct executable looks with bounded accurate discovery metadata',()=>{
 assert.equal(WARDROBE_CATALOG_VERSION,'lifetime-wardrobe.v4');assert.equal(WARDROBE_SERIES.length,24);
 assert.equal(new Set(WARDROBE_SERIES.map(s=>s.id)).size,24);assert.equal(new Set(WARDROBE_SERIES.map(s=>s.category)).size,6);
 assert.equal(WARDROBE_STYLES.filter(s=>s.seriesId).length,216);
 for(const group of WARDROBE_SERIES){
  const styles=WARDROBE_STYLES.filter(s=>s.seriesId===group.id);assert.equal(styles.length,9);
  assert.ok(group.tagline.length>8);assert.equal(group.palette.length,3);assert.ok(group.palette.every(c=>/^#[A-Fa-f0-9]{6}$/.test(c)));
  assert.ok(styles.every(s=>s.seriesLabel===group.label));assert.ok(Object.isFrozen(group));assert.ok(Object.isFrozen(group.palette));
 }
 const added=WARDROBE_STYLES.slice(34);assert.equal(added.length,185);assert.equal(new Set(added.map(s=>s.instruction)).size,185);
 for(const style of added){
  assert.equal(style.description.split(' · ').length,3);assert.ok(style.instruction.length>500);
  for(const phrase of ['fabric','seam','age-appropriate','clothing','faces','hair','pose','background','logos','no adult styling'])assert.ok(style.instruction.includes(phrase),style.id+':'+phrase);
 }
 for(const [id,min,max] of [['baby',0,6],['storybook',0,12],['academy',6,100],['atelier',18,100],['heritage',50,100]]){
  assert.ok(WARDROBE_STYLES.filter(s=>s.seriesId===id).every(s=>s.minAge===min&&s.maxAge===max));
 }
});

test('original98 objects and catalog membership snapshots remain immutable',()=>{
 assert.equal(createHash('sha256').update(JSON.stringify(WARDROBE_STYLES.slice(0,98))).digest('hex'),'48e02b0a8e28a23cb6a7d5b876057fbf43beb43475c617e858d631be031ed71e');
 for(const [version,count] of [['v1',34],['v2',98],['v3',219]])assert.equal(wardrobeStylesForCatalog('lifetime-wardrobe.'+version).length,count);
 assert.equal(wardrobeStylesForCatalog().length,237);assert.throws(()=>wardrobeStylesForCatalog('future'),/catalog version/);
 assert.equal(createHash('sha256').update(JSON.stringify(wardrobeStylesForCatalog('lifetime-wardrobe.v3'))).digest('hex'),'946ad20a787e36fdea4ed20ac1b42689970577538df12977d66c903c0f611d05');
 assert.ok(wardrobeStylesForCatalog().filter(style=>style.seriesId).every(style=>style.seriesId.startsWith('royal-')));
 for(const group of WARDROBE_SERIES){const all=WARDROBE_STYLES.filter(s=>s.seriesId===group.id);assert.equal(new Set(all.map(s=>s.label)).size,9);}
});
