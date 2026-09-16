const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { selectWorkingServer, recordResult, rankCandidates, HISTORY_TTL } = require('../src/connection-selection');
const { classifyConnectionError } = require('../src/connection-errors');
const servers = ['a', 'b', 'c', 'd'].map(id => ({ id }));

test('slow preferred server does not block a fast backup; all losers are cleaned up', async () => {
  let active = 0, maximum = 0, cancelled = 0;
  const result = await selectWorkingServer(servers, async (server, signal) => {
    active++; maximum = Math.max(active, maximum);
    try {
      await delay(server.id === 'b' ? 15 : 1000, undefined, { signal });
      return { status: 'ok', ms: 15 };
    } catch { cancelled++; return { status: 'cancelled' }; }
    finally { await delay(10); active--; }
  }, { hedgeMs: 5 });
  assert.equal(result.server.id, 'b');
  assert.equal(active, 0);
  assert.equal(cancelled, 2);
  assert.equal(maximum, 3);
});

test('fast preferred server avoids starting backup processes', async () => {
  const started = [];
  const result = await selectWorkingServer(servers, async server => {
    started.push(server.id); return { status: 'ok', ms: 1 };
  });
  assert.equal(result.server.id, 'a');
  assert.deepEqual(started, ['a']);
});

test('failed candidate frees a slot and later candidates can win', async () => {
  const attempts = [];
  const result = await selectWorkingServer(servers, async server => {
    attempts.push(server.id);
    return { status: server.id === 'd' ? 'ok' : 'error', reason: 'network', ms: 5 };
  });
  assert.equal(result.server.id, 'd');
  assert.equal(new Set(attempts).size, 4);
});

test('manual cancellation cannot return a winner and waits for cleanup', async () => {
  const controller = new AbortController();
  let active = 0;
  const pending = selectWorkingServer(servers, async (_, signal) => {
    active++;
    try { await delay(1000, undefined, { signal }); return { status: 'ok' }; }
    catch { return { status: 'cancelled' }; }
    finally { await delay(5); active--; }
  }, { signal: controller.signal, hedgeMs: 0 });
  await delay(10); controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(active, 0);
});

test('global deadline cancels outstanding attempts', async () => {
  let ended = 0;
  await assert.rejects(selectWorkingServer(servers, async (_, signal) => {
    try { await delay(1000, undefined, { signal }); }
    catch {} finally { ended++; }
    return { status: 'cancelled' };
  }, { hedgeMs: 0, budgetMs: 20 }), { code: 'NO_WORKING_SERVER' });
  assert.equal(ended, 3);
});

test('authentication failures are distinguished from local engine and DNS failures', async () => {
  for (const [reason, code] of [['auth', 'AUTH_FAILED'], ['dns', 'DNS_FAILED'], ['local', 'ENGINE_FAILED']]) {
    await assert.rejects(selectWorkingServer(servers, async () => ({status:'error',reason})), {code});
  }
  assert.equal(classifyConnectionError({code:'EACCES'}), 'local');
  assert.equal(classifyConnectionError({code:'ENOTFOUND'}), 'dns');
  assert.equal(classifyConnectionError({code:'AUTH_FAILED'}), 'auth');
});

test('cooldown expires, stale history is ignored, cancelled attempts do not penalize servers', () => {
  const history = {};
  recordResult(history, 'a', {status:'ok',ms:30}, 100);
  recordResult(history, 'a', {status:'cancelled'}, 110);
  assert.equal(history.a.failures, 0);
  recordResult(history, 'a', {status:'error',reason:'network'}, 120);
  recordResult(history, 'a', {status:'error',reason:'network'}, 130);
  assert.equal(rankCandidates(servers,{history,now:140}).some(s=>s.id==='a'), false);
  assert.equal(rankCandidates(servers,{history,now:20000}).some(s=>s.id==='a'), true);
  assert.equal(rankCandidates(servers,{history,selectedId:'a',now:HISTORY_TTL+1000})[0].id, 'a');
});

test('last healthy server is preferred; recent errors remove its advantage', () => {
  const history = {};
  recordResult(history,'c',{status:'ok',ms:40},100);
  assert.equal(rankCandidates(servers,{history,selectedId:'a',lastSuccessfulId:'c',now:110})[0].id,'c');
  recordResult(history,'c',{status:'error',reason:'network'},120);
  assert.equal(rankCandidates(servers,{history,selectedId:'a',lastSuccessfulId:'c',now:130})[0].id,'a');
  assert.equal(rankCandidates(servers,{history:{},selectedId:'b',now:130})[0].id,'b');
});

test('no eligible servers produces an actionable error; pre-cancelled selection never probes', async () => {
  await assert.rejects(selectWorkingServer([],()=>assert.fail()), {code:'NO_CANDIDATES'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(selectWorkingServer(servers,()=>assert.fail(),{signal:controller.signal}),{code:'ABORT_ERR'});
});
