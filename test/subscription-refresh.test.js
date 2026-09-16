const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main'), 'utf8');
const code = source.slice(source.indexOf('async function refreshSubscription('), source.indexOf('function createWindow()'));
function fixture(downloaded, running = false) {
  const active = {id:'sub',source:'https://example.com',servers:[{id:'one'}],selectedServerId:'one'};
  let restarts = 0;
  const ctx = {subscriptionUpdateInFlight:false, tunnelOperationId:0,
    state:{activeSubscriptionId:'sub',selectedServerId:'one',status:running?'connected':'disconnected'},
    activeSubscription:()=>active, subscriptionUrl:()=>active.source,
    downloadSubscription:async()=>downloaded, subscriptions:()=>[active], isTunnelActive:()=>running,
    publicState:()=>ctx.state, chooseServerId:(list,id)=>list.some(s=>s.id===id)?id:list[0].id,
    storeSubscriptions(){}, saveState:async()=>{}, startTunnel:async()=>{restarts++;},pushState(){},log(){},Map};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {ctx,active,restarts:()=>restarts};
}
test('automatic refresh adds servers without reconnecting', async()=>{
  const f=fixture([{id:'one'},{id:'two'}],true);
  await f.ctx.refreshSubscription({automatic:true});
  assert.equal(f.active.servers.length,2);assert.equal(f.restarts(),0);
});

test('unchanged server list still updates subscription usage without reconnecting',async()=>{
  const downloaded=[{id:'one'}];downloaded.metadata={upload:10,download:20,total:100};
  const f=fixture(downloaded,true);
  await f.ctx.refreshSubscription({automatic:true});
  assert.equal(f.active.metadata.download,20);assert.ok(f.active.updatedAt);assert.equal(f.restarts(),0);
});
test('automatic refresh defers changed running server',async()=>{
  const f=fixture([{id:'two'}],true);
  await f.ctx.refreshSubscription({automatic:true});
  assert.equal(f.active.servers[0].id,'one');assert.equal(f.restarts(),0);
});
test('late subscription response cannot overwrite another selection',async()=>{
  const f=fixture([{id:'two'}]);
  f.ctx.downloadSubscription=async()=>{f.ctx.state.activeSubscriptionId='other';return [{id:'two'}];};
  await f.ctx.refreshSubscription({automatic:true});
  assert.equal(f.active.servers[0].id,'one');
});
test('failed automatic refresh preserves servers and releases lock',async()=>{
  const f=fixture([]);f.ctx.downloadSubscription=async()=>{throw Error('offline');};
  await f.ctx.autoRefreshSubscription();
  assert.equal(f.active.servers[0].id,'one');assert.equal(f.ctx.subscriptionUpdateInFlight,false);
});
test('subscription completion preserves manually selected page',async()=>{
  const renderer=fs.readFileSync(require.resolve('../src/renderer/app'),'utf8');
  const fn=renderer.slice(renderer.indexOf('async function runSubscriptionAction('),renderer.indexOf('elements.nav.forEach((button) => button.addEventListener'));
  let page='subscription',done;
  const ctx={subscriptionRequestInFlight:false,elements:{subscriptionStatus:{}},updateSubscriptionControls(){},render(){},showPage(name){page=name;}};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  const task=ctx.runSubscriptionAction(()=>new Promise(resolve=>{done=resolve;}),'test');
  page='home';done({});await task;assert.equal(page,'home');
});
