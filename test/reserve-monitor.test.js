const test=require('node:test');
const assert=require('node:assert/strict');
const {nextReserve,preferPrepared,FRESH_MS}=require('../src/reserve-monitor');
const {hedgeDelay}=require('../src/connection-selection');
test('reserve rotation requires a healthy active path and does not recheck a fresh sample',()=>{
  const now=200000;
  const pool={activeId:'a',activeConfirmedAt:now,probePorts:new Map([['a',1],['b',2],['c',3]]),checks:new Map([['b',{checkedAt:now-1000,status:'ok'}]])};
  assert.equal(nextReserve(pool,now),'c');
  pool.checks.set('c',{checkedAt:now,status:'error'});assert.equal(nextReserve(pool,now),undefined);
  pool.activeConfirmedAt=now-30000;assert.equal(nextReserve(pool,now+30000),undefined);
});
test('fresh verified reserves take precedence; expired or failed samples do not',()=>{
  const candidates=[{id:'a'},{id:'b'},{id:'c'}];
  const pool={checks:new Map([['c',{status:'ok',checkedAt:200000}],['b',{status:'error',checkedAt:200000}]])};
  assert.deepEqual(preferPrepared(candidates,pool,200001).map(item=>item.id),['c','a','b']);
  assert.deepEqual(preferPrepared(candidates,pool,200001+FRESH_MS).map(item=>item.id),['a','b','c']);
});
test('learned hedge accounts for process startup but cannot delay failover beyond a second',()=>{
  assert.equal(hedgeDelay({successAt:100,ms:200,failures:0},false,101),600);
  assert.equal(hedgeDelay({successAt:100,ms:5000},false,101),1000);
  assert.equal(hedgeDelay({successAt:100,ms:200},true,101),0);
  assert.equal(hedgeDelay({successAt:100,ms:200,failures:1},false,101),0);
});
