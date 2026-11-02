import assert from 'node:assert/strict';
import test from 'node:test';
import { timelineFixture } from './timeline-fixtures.mjs';
import { wardrobeFixture } from './wardrobe-fixtures.mjs';
import { buildWardrobePlan, parseWardrobeEdit, requireWardrobeSource, wardrobeBinding } from '../../../packages/capabilities/dist/wardrobe-plan.js';

async function fixture(couple=false) {
  const f=await timelineFixture(':memory:',{couple,targetAges:[37]});
  const image={id:'age-source',sha256:'d'.repeat(64),mimeType:'image/png',width:64,height:64,byteLength:100};
  const node=await f.readyNode(image,37);f.runtime.applyExternalBusinessEvent(f.service,f.callback('root','succeeded',{schemaVersion:'ltm.timeline-results.v1',sourceAssetId:'source',planVersion:'age-portrait-plan.v1',aiLabel:true,nodes:[node]}));
  const edit={schemaVersion:'ltm.wardrobe-edit.v1',sourceRootCommandId:'root',sourceCommandId:'root',targetAge:37,sourceImage:image,selections:f.participantIds.map(participantId=>({participantId,styleId:'casual'}))};
  return {...f,edit,data:{sourceAssetId:'source',participantIds:f.participantIds,targetAges:[37],wardrobeEdit:edit}};
}
test('wardrobe plans bind source bytes, retain age and each ordered person and change replay seed by outfit',async()=>{
  for(const couple of [false,true]){const f=await fixture(couple);try{
    const input={...f.data,seed:'seed',promptPolicyVersion:'wardrobe-v1'},plan=buildWardrobePlan(input);
    assert.equal(plan.profile,'wardrobe-edit-v1');assert.equal(plan.expectedImageCount,1);assert.deepEqual(plan.editSource,f.edit.sourceImage);assert.deepEqual(plan.wardrobeBinding,wardrobeBinding(f.edit));
    assert.match(plan.wardrobePolicy.instruction,/clothing|clothing|body shape/);assert.match(plan.nodes[0].ageInstruction,/Keep the existing age 37/);
    const changed=buildWardrobePlan({...input,wardrobeEdit:{...f.edit,selections:f.edit.selections.map(s=>({...s,styleId:'formal'}))}});assert.notEqual(changed.nodes[0].seed,plan.nodes[0].seed);
    for(const delta of [{targetAges:[40]},{participantIds:[...f.participantIds].reverse().concat('stranger') }])assert.throws(()=>buildWardrobePlan({...input,...delta}),/exact/);
    for(const delta of [{selections:[{participantId:'user',styleId:'arbitrary-prompt'}]},{extra:true}])assert.throws(()=>parseWardrobeEdit({...f.edit,...delta}));
  }finally{f.runtime.close();}}
});
test('real SQL accepted photo and independent wardrobe action are mandatory, wrong source/age/owner fail',async()=>{
  const f=await fixture(true);try{
    await assert.rejects(requireWardrobeSource(f.runtime,f.actor,f.data),/consent/i);
    for(const participantId of f.participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:'wardrobe-test-v1',evidenceHash:'a'.repeat(64),idempotencyKey:'wardrobe-'+participantId});
    await requireWardrobeSource(f.runtime,f.actor,f.data);
    await assert.rejects(requireWardrobeSource(f.runtime,{...f.actor,actorId:'other'},f.data));
    for(const delta of [{targetAge:40},{sourceImage:{...f.edit.sourceImage,sha256:'e'.repeat(64)}},{selections:[...f.edit.selections].reverse()}])await assert.rejects(requireWardrobeSource(f.runtime,f.actor,{...f.data,wardrobeEdit:{...f.edit,...delta}}));
    const grant=f.runtime.listConsents({...f.actor,actorId:'partner'}).find(c=>c.scope.actions.includes('wardrobe'));f.runtime.withdrawConsent({...f.actor,actorId:'partner'},{consentId:grant.id,expectedVersion:grant.version,reason:'wardrobe withdrawn',idempotencyKey:'withdraw-wardrobe'});
    await assert.rejects(requireWardrobeSource(f.runtime,f.actor,f.data),/consent/i);
  }finally{f.runtime.close();}
});

test('B14 wardrobe command executes on real SQL only after each person grants wardrobe, replays once and retains original',async()=>{
  for(const couple of [false,true]){const f=await fixture(couple);try{
    const input={...f.data,jobId:'wardrobe-job',seed:'wardrobe-seed',promptPolicyVersion:'wardrobe-only.v1',timelineProfile:'wardrobe-edit-v1',illustrativeLabel:true};
    await assert.rejects(f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe-job',input}),/consent/i);
    for(const participantId of f.participantIds)f.runtime.grantConsent({...f.actor,actorId:participantId},{participantId,grantorCapacity:'self',purpose:'age_transformation',scope:{resource:'media.asset:source',actions:['wardrobe']},policyVersion:'wardrobe-test-v1',evidenceHash:'a'.repeat(64),idempotencyKey:'wardrobe-'+participantId});
    const first=await f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe-job',input});
    const replay=await f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe-job',input});assert.equal(replay.externalCommandId,first.externalCommandId);assert.equal(replay.replayed,true);
    const record=f.runtime.getRecord(f.actor,'generation.timeline-commands',first.externalCommandId);assert.deepEqual(record.data.wardrobeEdit,f.edit);assert.equal(record.data.generationPlan.profile,'wardrobe-edit-v1');assert.equal(f.runtime.getRecord(f.actor,'generation.timeline-commands','root').data.resultManifest.nodes[0].asset.id,'age-source');
    await assert.rejects(f.registry.execute(f.runtime,'B14',{actor:f.actor,idempotencyKey:'wardrobe-job',input:{...input,seed:'changed'}}),/idempotency|conflict/i);
  }finally{f.runtime.close();}}
});

test('signed wardrobe publication rejects ordinary age QA and changed clothing binding, accepts exact separate evidence',async()=>{
  for(const couple of [false,true]){const f=await wardrobeFixture({couple});try{
    await f.grantWardrobe();await f.createWardrobe();
    const asset={id:'wardrobe-result',sha256:'f'.repeat(64),mimeType:'image/png',width:64,height:64,byteLength:120};
    const ordinary=await f.readyNode(asset,37);
    assert.throws(()=>f.runtime.applyExternalBusinessEvent(f.service,f.callback('wardrobe-job','succeeded',f.manifest([ordinary]))),/wardrobe publication/);
    await f.createWardrobe('wrong-binding');
    const wrong=await f.readyWardrobe(asset,'wrong-binding',{...wardrobeBinding(f.edit),selectionsSha256:'0'.repeat(64)});
    assert.throws(()=>f.runtime.applyExternalBusinessEvent(f.service,f.callback('wrong-binding','succeeded',f.manifest([wrong]))),/wardrobe publication/);
    const ready=await f.readyWardrobe(asset);
    f.runtime.applyExternalBusinessEvent(f.service,f.callback('wardrobe-job','succeeded',f.manifest([ready])));
    assert.equal(f.runtime.getRecord(f.actor,'generation.timeline-commands','wardrobe-job').data.deliveryState,'ready');
    assert.equal(f.runtime.getRecord(f.actor,'generation.timeline-commands','root').data.resultManifest.nodes[0].asset.id,'age-source');
  }finally{f.runtime.close();}}
});
