import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LifeTimeMachineRuntime} from '@ltm/core';
import {configuredSeedream} from '../dist/seedream-config.js';

test('server-only opt-in rejects incomplete/unsafe config; construction never performs paid inference',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seedream-config-')),file=join(dir,'key'),alias=join(dir,'alias');
 await writeFile(file,'synthetic-ark-key-for-local-configuration',{mode:0o600});await symlink(file,alias);
 const runtime=new LifeTimeMachineRuntime({databasePath:':memory:',allowLegacyConsentPolicy:true});
 const env={LTM_SEEDREAM_ENABLED:'true',LTM_SEEDREAM_API_KEY_FILE:file,DATABASE_URL:'postgresql://runtime@localhost/test?sslmode=verify-full',LTM_UPLOAD_BROKER_URL:'https://broker.example.com',LTM_UPLOAD_BROKER_TOKEN_FILE:file,LTM_PHOTO_S3_ENDPOINT:'https://storage.example.com',LTM_PHOTO_S3_REGION:'test',LTM_PHOTO_S3_BUCKET:'private-test',LTM_PHOTO_S3_ACCESS_KEY_ID:'synthetic-access',LTM_PHOTO_S3_SECRET_ACCESS_KEY:'synthetic-secret'};
 try{
  assert.equal(configuredSeedream({},'production',runtime),undefined);assert.equal(configuredSeedream({LTM_SEEDREAM_ENABLED:'false'},'production',runtime),undefined);
  for(const mutation of [{LTM_SEEDREAM_ENABLED:'yes'},{LTM_SEEDREAM_ENABLED:undefined},{LTM_SEEDREAM_API_KEY_FILE:alias},{DATABASE_URL:'postgresql://runtime@localhost/test?sslmode=disable'},{LTM_CLIENT_INTEGRATION_ALLOW_HTTP_LOOPBACK:'true'},{LTM_UPLOAD_BROKER_URL:'http://127.0.0.1'},{ARK_API_KEY:'another-key'}])assert.throws(()=>configuredSeedream({...env,...mutation},'production',runtime),{code:'CONFIGURATION_INVALID'});
  for(const name of ['DATABASE_URL','LTM_UPLOAD_BROKER_URL','LTM_UPLOAD_BROKER_TOKEN_FILE','LTM_PHOTO_S3_ENDPOINT','LTM_PHOTO_S3_SECRET_ACCESS_KEY'])assert.throws(()=>configuredSeedream({...env,[name]:undefined},'production',runtime),{code:'CONFIGURATION_INVALID'});
  await chmod(file,0o644);assert.throws(()=>configuredSeedream(env,'production',runtime),{code:'CONFIGURATION_INVALID'});await chmod(file,0o600);
  const configured=configuredSeedream(env,'production',runtime);assert.ok(configured.generation);assert.ok(configured.media);await configured.close();
  const fromEnv=configuredSeedream({...env,LTM_SEEDREAM_API_KEY_FILE:undefined,ARK_API_KEY:'synthetic-server-key'},'production',runtime);await fromEnv.close();
 }finally{runtime.close();await rm(dir,{recursive:true,force:true});}
});
