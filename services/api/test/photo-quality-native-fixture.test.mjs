import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withPhotoFixture} from './photo-score-fixtures.mjs';
import {governancePolicy,persistQuality} from './photo-quality-v2-fixtures.mjs';
import {PhotoQualityGovernance} from '../dist/photo-quality-governance.js';
test('same signed photo fixture executes quality governance on real PostgreSQL',async()=>{
 assert.ok(process.env.LTM_TEST_POSTGRES_URL,'least-privilege migrated PostgreSQL required, never skipped');
 await withPhotoFixture(async f=>{
  assert.equal(f.runtime.backend,'postgresql');const p=governancePolicy(f.policy),g=new PhotoQualityGovernance(f.runtime);
  const a=await persistQuality(f,p,'native-one');await g.observe(f.service,'native-one',p,a.asset);
  const b=await persistQuality(f,p,'native-two');await g.observe(f.service,'native-two',p,b.asset);
  assert.equal((await g.control(f.service,p)).data.state,'stopped');
  assert.equal((await f.runtime.verifyAuditChain(f.service)).valid,true);
 },{postgresConnectionString:process.env.LTM_TEST_POSTGRES_URL,tenantId:'quality-native-'+randomUUID()});
});
