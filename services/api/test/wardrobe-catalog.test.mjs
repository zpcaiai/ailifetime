import assert from 'node:assert/strict';
import test from 'node:test';
import { WARDROBE_STYLES, parseWardrobeEdit, buildWardrobePlan, wardrobeBinding } from '../../../packages/capabilities/dist/wardrobe-plan.js';
const image={id:'age-image',sha256:'a'.repeat(64),mimeType:'image/png',width:64,height:64,byteLength:100};
const edit=(style,age,count)=>({schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:age,sourceImage:image,selections:Array.from({length:count},(_,i)=>({participantId:i?'partner':'user',styleId:style.id}))});
test('all eight series contain every approved look and legacy IDs remain unchanged',()=>{
 const expected={east:['素雅盘扣','宋风日常','旗袍长衫','改良汉服'],retro:['八十年代衣着','九十年代港风','千禧牛仔','经典白衬衫'],together:['同色针织','白衬衫','经典风衣','银发对服'],daily:['白衬衫','奶油针织','亚麻衬衣','简约西装'],wedding:['简约婚纱西装','复古婚礼','中式礼服','银婚金婚'],milestone:['毕业纪念','初入职场','生日礼服','退休纪念'],winter:['毛呢','围巾','针织','羽绒'],newyear:['喜庆中式','红色针织','情侣对服']};
 const modern=WARDROBE_STYLES.filter(s=>s.seriesId);assert.equal(modern.length,31);assert.equal(new Set(WARDROBE_STYLES.map(s=>s.id)).size,34);
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
 const value=edit(style,Math.max(37,style.minAge??0),style.minPeople??1),input={sourceAssetId:'source',participantIds:value.selections.map(s=>s.participantId),targetAges:[value.targetAge],seed:'catalog-seed',promptPolicyVersion:'wardrobe-only.v1',wardrobeEdit:value};
 const plan=buildWardrobePlan(input);assert.deepEqual(plan,buildWardrobePlan(input));assert.equal(plan.wardrobePolicy.selections[0].instruction,style.instruction);assert.deepEqual(plan.wardrobeBinding,wardrobeBinding(value));assert.match(plan.wardrobePolicy.instruction,/background, lighting/);fingerprints.add(plan.wardrobeBinding.selectionsSha256);
 }
 assert.equal(fingerprints.size,34);
 const unknown={...WARDROBE_STYLES[3],id:'east-pankou-v2'};assert.throws(()=>parseWardrobeEdit(edit(unknown,37,1)),/unknown/);
});
