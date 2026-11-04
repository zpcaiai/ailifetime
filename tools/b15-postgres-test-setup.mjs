#!/usr/bin/env node
// Disposable test databases only. Never an application startup or production migrator.
import {Pool} from 'pg';
import {randomBytes} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

export async function provisionCoreTestDatabase(environment=process.env){
 if(environment.APP_ENV!=='test'||!environment.LTM_PHOTO_TEST_POSTGRES_URL||!environment.GITHUB_ENV)throw new Error('Explicit test environment, disposable SQL URL and private environment output required');
 const admin=new URL(environment.LTM_PHOTO_TEST_POSTGRES_URL);
 if(!['127.0.0.1','localhost','[::1]'].includes(admin.hostname)||admin.searchParams.get('sslmode')!=='disable')throw new Error('Test provisioning is restricted to explicit insecure loopback');
 const pool=new Pool({connectionString:admin.href,max:1}),password=randomBytes(32).toString('hex');
 const migrator='b15_test_migrator',runtime='b15_test_runtime';
 const database=decodeURIComponent(admin.pathname.slice(1));if(!/^[A-Za-z0-9_]+$/.test(database))throw new Error('Unexpected disposable database name');
 const url=role=>{const u=new URL(admin);u.username=role;u.password=password;return u.href;};
 try{
  if((await pool.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[migrator,runtime]])).rowCount)throw new Error('Test roles already exist; refusing to replace credentials or duplicate setup');
  await pool.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await pool.query(`GRANT CREATE ON DATABASE "${database}" TO ${migrator}`);
  await pool.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`);
  const child=spawn(process.execPath,['tools/postgres-migrate.mjs','--profile=test','--allow-insecure-loopback=true'],{env:{...environment,LTM_MIGRATOR_DATABASE_URL:url(migrator)},stdio:['ignore','pipe','pipe']});
  let output='';for await(const part of child.stdout)output+=part;let error='';for await(const part of child.stderr)error+=part;
  const code=await new Promise(resolve=>child.exitCode!==null?resolve(child.exitCode):child.once('exit',resolve));
  if(code!==0)throw new Error('Canonical test migration failed: '+error);
  const report=JSON.parse(output);if(report.status!=='PASS'||report.migrations.total!==7)throw new Error('Canonical migration did not verify all seven migrations');
  const grants=[
   `GRANT CONNECT ON DATABASE "${database}" TO ${runtime}`,
   `GRANT USAGE ON SCHEMA ltm TO ${runtime}`,
   `GRANT USAGE ON SCHEMA orchestration TO ${runtime}`,
   `GRANT SELECT ON ltm.schema_metadata TO ${runtime}`,
   `GRANT SELECT,INSERT,UPDATE,DELETE ON ltm.records,ltm.consents,ltm.idempotency,ltm.inbox,ltm.outbox,ltm.audit_log,ltm.ledger_transactions,ltm.ledger_lines,ltm.external_evidence,ltm.evidence_consumptions,ltm.external_commands,ltm.external_command_transitions,ltm.evidence_decisions,ltm.external_business_events,ltm.participants,ltm.guardian_authorizations,ltm.authorized_agent_authorizations,ltm.data_tracking_queue,ltm.data_warehouse_state,ltm.commerce_finance_state,ltm.growth_operations_state,ltm.partner_settlement_state,ltm.referral_rewards,ltm.lifecycle_deliveries,ltm.partner_usage_events,ltm.partner_rate_contracts,ltm.partner_settlement_statements,ltm.partner_anomaly_decisions TO ${runtime}`,
   `GRANT SELECT,INSERT,UPDATE,DELETE ON orchestration.workflow_instances,orchestration.outbox,orchestration.inbox,orchestration.dead_letters,orchestration.provider_executions,orchestration.late_provider_results,orchestration.workflow_history,orchestration.scheduler_jobs TO ${runtime}`,
   `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ltm TO ${runtime}`,
   `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA orchestration TO ${runtime}`,
  ];for(const sql of grants)await pool.query(sql);
  await appendFile(environment.GITHUB_ENV,`LTM_TEST_POSTGRES_URL=${url(runtime)}\nLTM_TEST_POSTGRES_ADMIN_URL=${admin.href}\n`,{mode:0o600});
  return {status:'PASS',migrations:report.migrations.total,grants:grants.length,childPid:child.pid,runtimeRole:runtime,credentials:'PRIVATE_ENV_FILE_ONLY'};
 }finally{await pool.end();}
}
if(import.meta.url===new URL(process.argv[1],'file:').href)provisionCoreTestDatabase().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({status:'FAIL',error:error.message})+'\n');process.exitCode=1;});
