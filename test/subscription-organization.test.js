const test=require('node:test'),assert=require('node:assert/strict');
const {organizeSubscriptions}=require('../src/subscription-organization');
test('hide and restore preserve subscription credentials and order',()=>{
 const saved=[{id:'a',source:'secret',servers:[1]},{id:'b',source:'other',servers:[2]}];
 const hidden=organizeSubscriptions(saved,'a',{id:'b',hidden:true});
 assert.equal(hidden[1].hidden,true);assert.equal(saved[1].hidden,undefined);
 assert.equal(hidden[1].source,'other');assert.deepEqual(hidden[1].servers,[2]);
 assert.equal(organizeSubscriptions(hidden,'a',{id:'b',hidden:false})[1].hidden,false);
 assert.throws(()=>organizeSubscriptions(saved,'a',{id:'a',hidden:true}));
});
test('reorder includes hidden subscriptions and rejects stale or duplicate IDs',()=>{
 const saved=[{id:'a'},{id:'b',hidden:true},{id:'c'}];
 assert.deepEqual(organizeSubscriptions(saved,'a',{ids:['c','b','a']}),[saved[2],saved[1],saved[0]]);
 for(const ids of [['a','a','b'],['a','b'],['a','b','unknown']])assert.throws(()=>organizeSubscriptions(saved,'a',{ids}));
});
