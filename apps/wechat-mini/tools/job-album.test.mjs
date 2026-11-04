import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function delivery(count = 3) {
  return { commandId: 'root', commandState: 'succeeded', reconciliationState: 'clear', expectedCount: count,
    readyCount: count, nodes: Array.from({ length: count }, (_, age) => ({ targetAge: age, status: 'ready',
      downloadPath: `/v1/timelines/root/nodes/${age}/image`, asset: { sha256: String(age).padStart(64, '0') } })) };
}
function fixture({ save, request, settings } = {}) {
  let page, actor = { tenantId: 'tenant', actorId: 'user' }, current = delivery();
  const saved = [], calls = [], timers = new Map(); let id = 0;
  const media = { save: async (node, signal) => { await save?.(node, signal); saved.push(node.targetAge); },
    openAlbumSettings: async () => settings ? settings() : true };
  runInNewContext(readFileSync(new URL('../miniprogram/pages/job/index.js', import.meta.url), 'utf8'), {
    Page: value => page = value,
    require: name => name.endsWith('/api') ? { requestForPurpose: async (...args) => {
      calls.push(args); return request ? request(...args) : { data: current };
    } } : name.endsWith('/session') ? { requireSession: () => { if (!actor) throw Error('AUTHENTICATION_REQUIRED'); return actor; } } : media,
    wx: { switchTab() {} }, Error,
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: value => timers.delete(value),
  });
  page.setData = update => Object.assign(page.data, update);
  page.setData({ commandId: 'root' });
  return { page, saved, calls, timers, media, setView: value => current = value, setActor: value => actor = value };
}

test('one tap saves a single photo or21 age outputs serially and skips successful originals on retry', async () => {
  for (const count of [1, 21]) {
    let running = 0;
    const f = fixture({ save: async () => { assert.equal(++running, 1); await Promise.resolve(); running--; } });
    f.setView(delivery(count)); await f.page.refresh(); assert.equal(f.saved.length, 0);
    await f.page.saveAll(); assert.equal(f.saved.length, count); assert.equal(f.page.data.savedCount, count);
    assert.match(f.page.data.saveMessage, new RegExp(`已保存 ${count} / ${count}`));
    await f.page.saveAll(); assert.equal(f.saved.length, count);
    assert.ok(f.calls.every(([, purpose, options]) => purpose === 'age_transformation' && options.method === 'GET'));
  }
});
test('partial failure resumes only remaining; later-ready and changed images are included', async () => {
  let fail = true;
  const f = fixture({ save: async node => { if (node.targetAge === 1 && fail) throw Error('NETWORK'); } });
  const view = delivery(); view.nodes[2].status = 'pending'; f.setView(view);
  await f.page.saveAll(); assert.deepEqual(f.saved, [0]); assert.equal(f.page.data.savedCount, 1);
  assert.match(f.page.data.saveMessage, /1.*2.*重试/);
  fail = false; await f.page.saveAll(); assert.deepEqual(f.saved, [0, 1]);
  view.nodes[2].status = 'ready'; await f.page.saveAll(); assert.deepEqual(f.saved, [0, 1, 2]);
  view.nodes[0].asset.sha256 = 'f'.repeat(64); await f.page.saveAll(); assert.deepEqual(f.saved, [0, 1, 2, 0]);
});
test('permission denial preserves progress; opening settings never starts saving', async () => {
  let deny = true;
  const f = fixture({ save: async node => { if (node.targetAge === 1 && deny) throw Error('ALBUM_PERMISSION_REQUIRED'); } });
  await f.page.saveAll(); assert.equal(f.page.data.albumPermissionDenied, true); assert.deepEqual(f.saved, [0]);
  await f.page.albumSettings(); assert.equal(f.page.data.albumPermissionDenied, false); assert.deepEqual(f.saved, [0]);
  deny = false; await f.page.saveAll(); assert.deepEqual(f.saved, [0, 1, 2]);
  const denied = fixture({ settings: () => false }); await denied.page.albumSettings(); assert.equal(denied.page.data.albumPermissionDenied, true);
});
test('duplicate taps and refresh cannot overlap a save; cancellation stops subsequent photos', async () => {
  let release;
  const f = fixture({ save: () => new Promise(resolve => release = resolve) });
  const pending = f.page.saveAll(); await new Promise(resolve => setImmediate(resolve));
  await f.page.saveAll(); await f.page.refresh(); assert.equal(f.calls.length, 1);
  f.page.cancelSave(); release(); await pending; assert.deepEqual(f.saved, [0]);
  assert.equal(f.page.data.saving, false); assert.match(f.page.data.saveMessage, /停止/);
});
test('hiding or unloading cancels a pending native save and ignores late responses', async () => {
  for (const action of ['onHide', 'onUnload']) {
    let release;
    const f = fixture({ save: async (_node, signal) => { await new Promise(resolve => release = resolve); if (signal.cancelled) throw Error('MEDIA_REQUEST_CANCELLED'); } });
    const pending = f.page.saveAll(); await new Promise(resolve => setImmediate(resolve));
    f.page[action](); release(); await pending; assert.equal(f.saved.length, 0); assert.equal(f.page.data.saving, false);
    assert.equal(f.timers.size, 0);
  }
  let release;
  const f = fixture({ request: () => new Promise(resolve => release = resolve) });
  const pending = f.page.saveAll(); f.page.onHide(); release({ data: delivery() }); await pending; assert.equal(f.saved.length, 0);
});
test('cancelling while the projection loads gives a stopped message and never writes', async () => {
  let release;
  const f = fixture({ request: () => new Promise(resolve => release = resolve) });
  const pending = f.page.saveAll(); f.page.cancelSave(); release({ data: delivery() }); await pending;
  assert.equal(f.saved.length, 0); assert.equal(f.page.data.saving, false); assert.match(f.page.data.saveMessage, /已停止/);
});
test('terminal provider receipt keeps polling while photos are pending; frozen jobs expose no save readiness', async () => {
  const f = fixture(); const view = delivery(); view.nodes[2].status = 'pending'; f.setView(view);
  await f.page.refresh(); assert.equal(f.timers.size, 1); assert.equal(f.saved.length, 0);
  view.reconciliationState = 'reconciliation_required'; await f.page.refresh(); assert.equal(f.page.data.readyCount, 0);
  assert.equal(f.timers.size, 0);
});
test('privacy and authorization refusal never advances remaining writes', async () => {
  for (const code of ['PRIVACY_AUTHORIZATION_DENIED', 'TIMELINE_DOWNLOAD_HTTP_403']) {
    const f = fixture({ save: async () => { throw Error(code); } }); await f.page.saveAll();
    assert.equal(f.saved.length, 0); assert.equal(f.page.data.savedCount, 0); assert.match(f.page.data.saveMessage, /授权/);
  }
});
test('invalid, unready or frozen projections cannot save and account switches stop further export', async () => {
  for (const change of [v => v.commandId = 'other', v => v.reconciliationState = 'reconciliation_required',
    v => v.nodes[0].downloadPath = '/v1/timelines/other/nodes/0/image', v => v.expectedCount++,
    v => v.nodes[1].targetAge = 0, v => v.nodes.forEach(n => n.status = 'pending')]) {
    const f = fixture(); const view = delivery(); change(view); f.setView(view); await f.page.saveAll(); assert.equal(f.saved.length, 0);
  }
  const f = fixture(); await f.page.saveAll(); f.setActor({ tenantId: 'tenant', actorId: 'other' });
  await f.page.saveAll(); assert.equal(f.saved.length, 3); assert.match(f.page.data.saveMessage, /授权|登录/);
  const g = fixture({ save: async () => g.setActor({ tenantId: 'tenant', actorId: 'other' }) });
  await g.page.saveAll(); assert.equal(g.saved.length, 1);
});
test('generation result exposes an album action, progress, cancel and settings controls', () => {
  const template = readFileSync(new URL('../miniprogram/pages/job/index.wxml', import.meta.url), 'utf8');
  for (const handler of ['saveAll', 'cancelSave', 'albumSettings']) assert.match(template, new RegExp(`bindtap="${handler}"`));
  assert.match(template, /一键保存到手机相册/); assert.match(template, /savedCount/); assert.match(template, /saveTotal/);
});

test('refresh exposes in-flight and success feedback and prevents duplicate requests or concurrent saving',async()=>{
  let release,requests=0;
  const f=fixture({request:()=>++requests===1?new Promise(resolve=>release=resolve):{data:delivery(21)}});
  const pending=f.page.refresh();
  try{
    assert.equal(f.page.data.refreshing,true);assert.match(f.page.data.refreshMessage,/正在刷新/);
    await f.page.refresh();await f.page.saveAll();assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);
  }finally{release({data:delivery(21)});await pending;}
  assert.equal(f.page.data.refreshing,false);assert.match(f.page.data.refreshMessage,/已更新.*21\/21/);
});
test('successful refresh clears stale errors and failed refresh visibly reports failure',async()=>{
  const f=fixture();f.page.data.error='HTTP_404';await f.page.refresh();
  assert.equal(f.page.data.error,'');assert.match(f.page.data.refreshMessage,/已更新.*3\/3/);
  const g=fixture({request:()=>{throw Error('NETWORK_TIMEOUT');}});await g.page.refresh();
  assert.equal(g.page.data.refreshing,false);assert.match(g.page.data.refreshMessage,/刷新失败/);
  assert.equal(g.page.data.error,'NETWORK_TIMEOUT');assert.equal(g.timers.size,1);
});
test('hiding a pending refresh ends loading and late success cannot overwrite the hidden page',async()=>{
  let release;const f=fixture({request:()=>new Promise(resolve=>release=resolve)});
  const pending=f.page.refresh();f.page.onHide();release({data:delivery(21)});await pending;
  assert.equal(f.page.data.refreshing,false);assert.equal(f.page.data.readyCount,0);
  assert.ok(!f.page.data.refreshMessage.includes('已更新'));
  const template=readFileSync(new URL('../miniprogram/pages/job/index.wxml',import.meta.url),'utf8');
  assert.match(template,/loading="\{\{refreshing\}\}"/);assert.match(template,/\{\{refreshMessage\}\}/);
});
