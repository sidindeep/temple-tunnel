const test=require('node:test');
const assert=require('node:assert/strict');
const {parseSubscriptionMetadata,downloadSubscription}=require('../src/subscription');
test('provider metadata preserves unknown values and rejects invalid numbers',()=>{
  const metadata=parseSubscriptionMetadata(new Headers({'subscription-userinfo':'upload=12; download=34; total=100; expire=1800000000'}));
  assert.deepEqual(metadata,{upload:12,download:34,total:100,expire:1800000000});
  assert.deepEqual(parseSubscriptionMetadata(new Headers()),{});
  assert.deepEqual(parseSubscriptionMetadata(new Headers({'subscription-userinfo':'upload=-1; download=NaN; total=999999999999999999999; expire=999999999999'})),{});
});
test('downloading preserves array API and attaches metadata without exposing it as a server',async()=>{
  const result=await downloadSubscription('https://example.com/sub',async()=>new Response(
    'vless://550e8400-e29b-41d4-a716-446655440000@192.0.2.1:443?security=none#test',
    {headers:{'subscription-userinfo':'upload=10; download=20; total=100'}}));
  assert.equal(result.length,1);assert.equal(result.metadata.total,100);
  assert.equal(JSON.parse(JSON.stringify(result)).length,1);
});
