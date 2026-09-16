const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../src/server-probe'),'utf8');
function fixture(probe){const c=vm.createContext({Date,probeServerOnce:probe});vm.runInContext(source.slice(source.indexOf('async function probeServer(server'),source.indexOf('module.exports')),c);return c.probeServer;}
const profile={security:'reality',transport:'tcp'};
test('REALITY fallback returns the verified Xray profile after native cleanup',async()=>{
 const engines=[];let cleaned=false;
 const probe=fixture(async s=>{engines.push(s.connectionEngine||'native');if(engines.length===1){await Promise.resolve();cleaned=true;return {reason:'reality'};}assert.equal(cleaned,true);return {status:'ok',resolvedServer:s};});
 const result=await probe(profile,'core','xray');assert.equal(result.status,'ok');assert.equal(result.resolvedServer.connectionEngine,'xray');assert.deepEqual(engines,['native','xray']);
});
test('timeouts, local failures and successful native probes do not trigger an engine switch',async()=>{
 for(const result of [{status:'ok'},{reason:'network',status:'timeout'},{reason:'local'}]){let calls=0;await fixture(async()=>{calls++;return result;})(profile,'core','xray');assert.equal(calls,1);}
});

test('an early native REALITY failure falls back even when stderr did not arrive first',async()=>{
 let calls=0;
 const result=await fixture(async s=>++calls===1?{status:'error',reason:'network'}:{status:'ok',resolvedServer:s})(profile,'core','xray');
 assert.equal(calls,2);assert.equal(result.resolvedServer.connectionEngine,'xray');
});
test('cancellation and an already selected Xray never recurse',async()=>{
 for(const [s,options] of [[profile,{signal:{aborted:true}}],[{...profile,connectionEngine:'xray'},{}]]){let calls=0;await fixture(async()=>{calls++;return {reason:'reality'};})(s,'core','xray',options);assert.equal(calls,1);}
});
