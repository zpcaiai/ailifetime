import {assessPhotoResponse,makePhotoScoreRequest,photoControlKey,digest} from '../dist/photo-score-contract.js';
import {canonicalJson} from '@ltm/core';
import {response} from './photo-score-fixtures.mjs';
import {syntheticPng} from './timeline-fixtures.mjs';
export const governancePolicy=p=>({...p,protocolVersion:2,regression:{windowSize:4,minimumSamples:2,maximumFailureRate:.5},thresholds:{...p.thresholds,aestheticUsability:.8}});
export async function persistQuality(f,p,id,low='aestheticUsability',candidate,targetAge=37){
 const seed=Buffer.from(digest(id),'hex'),asset=candidate??await f.store.put('candidate-'+id,syntheticPng(seed[0],64+seed[1],64+seed[2]),'image/png'),request=makePhotoScoreRequest({tenantId:f.actor.tenantId,commandId:'root',sourceAssetId:'source',targetAge,context:p.context,people:f.participantIds.map((participantId,i)=>({participantId,position:f.participantIds.length===1?'single':i===0?'left':'right'})),referenceAsset:f.sourceAsset,referenceBytes:f.sourceBytes,outputAsset:asset,outputBytes:await f.store.read(asset)},p);
 const raw={...response(request,p),schemaVersion:'ltm.photo-score.response.v2',imageScores:{...response(request,p).imageScores,aestheticUsability:.95}};
 if(low==='identity')raw.participants[0].identity=.1;else if(low)raw.imageScores[low]=.1;
 const result=assessPhotoResponse(raw,request,p);await f.grantQuality(id);
 await f.registry.execute(f.runtime,'B15',{actor:f.service,idempotencyKey:'persist-'+id,input:{workId:id,participantIds:f.participantIds,modelVersion:p.modelVersion,scores:result.scores,thresholds:result.thresholds,participantAssessments:result.participantAssessments,decision:result.decision,artifactBinding:{sourceAssetId:'source',assetId:asset.id,outputSha256:asset.sha256,targetAge},photoScoreEvidence:{schemaVersion:'ltm.photo-score.evidence.v2',requestSha256:request.requestSha256,responseSha256:digest(JSON.stringify(raw)),sourceSha256:f.sourceAsset.sha256,modelSha256:p.modelSha256,calibrationId:p.id,calibrationSha256:digest(canonicalJson(p)),calibration:JSON.parse(canonicalJson(p)),ages:result.ages,commandId:'root',controlKey:photoControlKey(p)}}});
 return {asset,request,raw,result};
}
export const human=(f,id)=>({...f.service,actorId:id,roles:['platform_admin'],stepUp:true});
