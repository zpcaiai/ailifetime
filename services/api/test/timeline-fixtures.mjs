import { generateKeyPairSync, createHash } from 'node:crypto';
import { LifeTimeMachineRuntime, participantEvidenceScope, signExternalEvidence, canonicalBusinessClaimsSha256, canonicalBusinessEventSha256, signConsentPolicyCatalog } from '@ltm/core';
import { capabilityEvidenceScope } from '../../../packages/providers/dist/index.js';
import { createCapabilityRegistry, externalBusinessEventReducerRegistry } from '@ltm/capabilities';
import { createCapabilityValidInputFixtures } from '../../../packages/capabilities/dist/valid-fixtures.js';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Synthetic identities/reports only. The real runtime, SQLite, consent and signatures execute.
export async function timelineFixture(databasePath = ':memory:', options = {}) {
  const pair = generateKeyPairSync('ed25519'), privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const policyVersion = options.verifiedConsent ? 'age-transformation-consent-v1' : 'privacy-v1';
  const issuedAt=new Date(Date.now()-60000).toISOString(), policyExpires=new Date(Date.now()+86400000).toISOString();
  const disclosureSource=readFileSync(new URL('../../../apps/wechat-mini/miniprogram/policies/age-transformation.js',import.meta.url),'utf8');
  const disclosure=JSON.parse(disclosureSource.match(/const text = ("[^\n]*");/)[1]);
  const disclosureSha256=createHash('sha256').update(disclosure).digest('hex');
  const wardrobeDisclosure=JSON.parse(readFileSync(new URL('../../../apps/wechat-mini/miniprogram/policies/wardrobe.js',import.meta.url),'utf8').match(/const text = ("[^\n]*");/)[1]);
  const wardrobePolicy={policyVersion:'wardrobe-edit-consent-v1',purpose:'age_transformation',locale:'zh-CN',jurisdictions:['CN'],resourceKinds:['media.asset'],allowedActions:['wardrobe'],grantorCapacities:['self'],minorApplicability:'adult',disclosureSha256:createHash('sha256').update(wardrobeDisclosure).digest('hex'),effectiveFrom:issuedAt,effectiveUntil:policyExpires,maxConsentLifetimeSeconds:3600};
  // Test-owned sandbox authority executes the real signed-catalog verifier. No production policy certification.
  const verifiedPolicy = options.verifiedConsent ? {
    consentPolicyCatalog:signConsentPolicyCatalog({schemaVersion:'ltm.consent-policy-catalog.v1',catalogId:'synthetic-mode-policy',issuer:'test-policy-authority',environment:'sandbox',issuedAt,expiresAt:policyExpires,algorithm:'Ed25519',keyId:'test-policy-key',policies:[...['age_transformation','quality_assurance'].map(purpose=>({policyVersion:purpose==='quality_assurance'?'test-quality-v1':policyVersion,purpose,locale:'zh-CN',jurisdictions:['CN'],resourceKinds:['media.asset','media.quality-decisions','media.safety-certificates'],allowedActions:['ingest','process','transform'],grantorCapacities:['self'],minorApplicability:'adult',disclosureSha256,effectiveFrom:issuedAt,effectiveUntil:policyExpires,maxConsentLifetimeSeconds:3600})),wardrobePolicy]},privateKey),
    trustedConsentPolicyKeys:[{keyId:'test-policy-key',issuer:'test-policy-authority',algorithm:'Ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),allowedEnvironments:['sandbox'],notBefore:issuedAt,notAfter:policyExpires}],consentPolicyJurisdiction:'CN',consentPolicyLocale:'zh-CN',
  } : {allowLegacyConsentPolicy:true};
  const runtimeOptions = { databasePath, ...verifiedPolicy, evidencePolicy: 'development', evidenceEnvironment: 'sandbox',
    trustedEvidenceKeys: ['identity-registry', 'generation-engine'].map(provider => ({ issuer: 'test-authority', provider, keyId: 'test-key', algorithm: 'Ed25519', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), allowedScopes: ['*'], allowedEnvironments: ['sandbox'] })) };
  const runtime = new LifeTimeMachineRuntime(runtimeOptions);
  const actor = { actorId: 'user', tenantId: 'tenant', roles: ['consumer'], purpose: 'age_transformation', requestId: 'timeline-test' };
  const service = { ...actor, actorId: 'service', roles: ['platform_admin', 'service_account'], permissions: ['*'], stepUp: true, operationId: 'timeline-fixture-service-operation' };
  const expiresAt = new Date(Date.now()+3600000).toISOString();
  const participantIds = options.couple ? ['user', 'partner'] : ['user'];
  const consents = [];
  for (const participantId of participantIds) {
  const mutation = { operation: 'participant.register', tenantId: 'tenant', participantId, ownerActorId: participantId, minorStatus: 'adult', expiresAt, expectedVersion: null };
  const identityEvidence = signExternalEvidence({ version: 'ltm.external-evidence.v1', evidenceId: `identity-evidence-${participantId}`, tenantId: 'tenant', issuer: 'test-authority', provider: 'identity-registry', environment: 'sandbox', scope: participantEvidenceScope(mutation), artifactSha256: 'a'.repeat(64), issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt, nonce: `identity-nonce-00000001-${participantId}`, replayPolicy: 'single_use', algorithm: 'Ed25519', keyId: 'test-key' }, privateKey);
  runtime.registerExternalEvidence(service, { evidence: identityEvidence, idempotencyKey: `identity-evidence-${participantId}` });
  runtime.registerParticipant(service, { ...mutation, evidenceId: identityEvidence.evidenceId, idempotencyKey: `identity-register-${participantId}` });
  const consent = runtime.grantConsent({...actor, actorId: participantId}, { participantId, grantorCapacity: 'self', purpose: actor.purpose, scope: { resource: 'media.asset:source', actions: ['ingest','transform'] }, policyVersion, ...(options.verifiedConsent ? {} : {evidenceHash:'b'.repeat(64)}), idempotencyKey: `age-consent-${participantId}` });
  consents.push(consent);
  }
  const consent = consents[0];
  const registry = createCapabilityRegistry(), fixtures = createCapabilityValidInputFixtures();
  const source = options.sourceAsset;
  const sourceIntake = source === undefined ? {} : { sourceSha256: source.sha256, canonicalSha256: source.sha256,
    lineageSha256: createHash('sha256').update(`ltm-media-lineage-v1\n${source.sha256}\n${source.sha256}\n`).digest('hex'),
    mimeType: source.mimeType, byteLength: source.byteLength, qualityDimensions: {width:source.width,height:source.height} };
  await registry.execute(runtime, 'B07', { actor, idempotencyKey: 'intake', input: { ...fixtures.B07, ...sourceIntake, assetId: 'source', participantIds, faceCount: participantIds.length } });
  await registry.execute(runtime, 'B14', { actor, idempotencyKey: 'root', input: { jobId: 'root', sourceAssetId: 'source', participantIds, targetAges: options.targetAges ?? Array.from({length:21},(_,i)=>i*5), currentAge: 35, timelineProfile: `${options.targetAges?.length === 1 ? 'single-age' : 'lifespan-21'}${options.couple ? '-couple' : ''}-v1`, ...(options.couple ? {participantAges:[35,32]} : {}), seed: 'synthetic-seed', promptPolicyVersion: 'age-policy-v1', illustrativeLabel: true } });
  let sequence = 0;
  function callback(commandId, state, resultManifest) {
    const current = runtime.getExternalCommand(service, commandId), op = `op-${commandId}`;
    if (current.state === 'requested') runtime.transitionExternalCommand(service, { commandId, batchId: 'B14', operation: 'createTimeline', aggregateCollection: 'generation.timeline-commands', aggregateId: commandId, toState: 'dispatched', idempotencyKey: `dispatch-${commandId}` });
    if (state === 'succeeded' && runtime.getExternalCommand(service,commandId).state === 'dispatched') runtime.transitionExternalCommand(service, { commandId, batchId:'B14', operation:'createTimeline', aggregateCollection:'generation.timeline-commands', aggregateId:commandId, toState:'acknowledged', providerOperationId:op, idempotencyKey:`ack-${commandId}` });
    const claims = { providerOperationId: op, ...(resultManifest ? {resultManifest} : {}) }, artifactSha256 = createHash('sha256').update(JSON.stringify(claims)).digest('hex');
    const binding = { tenantId:'tenant', batchId:'B14', operation:'createTimeline', kind:'timeline-generation-result', provider:'generation-engine', artifactSha256, environment:'sandbox', subjectId:commandId };
    const unsigned = { version:'ltm.external-business-event.v1', eventId:`event-${++sequence}`, tenantId:'tenant', batchId:'B14', operation:'createTimeline', provider:'generation-engine', subjectType:'timeline-job', subjectId:commandId, eventType:`external-command.${state}`, providerOccurredAt:new Date().toISOString(), sequence, correlationId:commandId, artifactSha256, evidenceId:`result-evidence-${sequence}`, evidenceScope:capabilityEvidenceScope(binding), canonicalClaims:claims, canonicalClaimsSha256:canonicalBusinessClaimsSha256(claims) };
    const event = {...unsigned,businessEventSha256:canonicalBusinessEventSha256(unsigned)};
    const evidence = signExternalEvidence({version:'ltm.external-evidence.v1', evidenceId:event.evidenceId, tenantId:'tenant', issuer:'test-authority', provider:'generation-engine', environment:'sandbox', scope:event.evidenceScope, artifactSha256, canonicalClaimsSha256:event.canonicalClaimsSha256, businessEventSha256:event.businessEventSha256, issuedAt:new Date(Date.now()-1000).toISOString(), expiresAt, nonce:`result-nonce-000000-${sequence}`, replayPolicy:'single_use', algorithm:'Ed25519', keyId:'test-key'},privateKey);
    return { evidence, event, reducer:externalBusinessEventReducerRegistry.resolve(event), idempotencyKey:`apply-${event.eventId}` };
  }
  async function readyNode(asset, targetAge) {
    const q = `q-${targetAge}-${asset.sha256.slice(0,8)}`, s = `s-${targetAge}-${asset.sha256.slice(0,8)}`;
    for (const [id, collection, purposes] of [[q,'media.quality-decisions',['quality_assurance','age_transformation']], [s,'media.safety-certificates',['age_transformation']]]) {
      for (const participantId of participantIds) for (const purpose of purposes) runtime.grantConsent({...actor,actorId:participantId,purpose},{participantId,grantorCapacity:'self',purpose,scope:{resource:`${collection}:${id}`,actions:['process']},policyVersion:options.verifiedConsent&&purpose==='quality_assurance'?'test-quality-v1':policyVersion,...(options.verifiedConsent ? {} : {evidenceHash:'c'.repeat(64)}),idempotencyKey:`consent-${id}-${purpose}-${participantId}`});
    }
    const artifactBinding = {sourceAssetId:'source',assetId:asset.id,outputSha256:asset.sha256,targetAge};
    const dimensions = ['identity','ageRange','facialDrift','pose','artifacts','clarity','background','handsTeethEyes','photorealism'];
    await registry.execute(runtime,'B15',{actor:service,idempotencyKey:q,input:{...fixtures.B15,workId:q,participantIds,artifactBinding,...(options.couple ? {participantAssessments: participantIds.map(participantId => ({participantId,scores:{identity:.9,ageRange:.9,facialDrift:.9},thresholds:{identity:.8,ageRange:.8,facialDrift:.8}}))} : {}),scores:Object.fromEntries(dimensions.map(d=>[d,.9])),thresholds:Object.fromEntries(dimensions.map(d=>[d,.8]))}});
    await registry.execute(runtime,'B17',{actor:service,idempotencyKey:s,input:{...fixtures.B17,workId:s,participantIds,artifactBinding}});
    return {nodeId:`age-${targetAge}`,targetAge,status:'ready',asset,qualityResultId:q,safetyResultId:s};
  }
  return {runtime,runtimeOptions, actor, service, consent, consents, participantIds, registry, callback, fixtures,readyNode};
}

export function syntheticPng(index, width=64, height=64) {
  function chunk(type,data) {
    const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
    for (const byte of body) {crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,body,checksum]);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(width*3+1)+1+x*3;pixels[p]=index*11%256;pixels[p+1]=x%256;pixels[p+2]=y%256;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
