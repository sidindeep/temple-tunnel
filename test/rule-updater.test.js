const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {updateRules,loadCachedRules} = require('../src/rule-updater');
const valid = async file => { assert.match(await fs.readFile(file,'utf8'),/^valid/); };
const response = async () => new Response('valid rules');
test('rule updater publishes a validated pair and supports repeat startup',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-rule-test-'));
  try {
    const first=await updateRules(root,valid,response);
    assert.deepEqual(await loadCachedRules(root,valid),first);
    assert.deepEqual(await updateRules(root,valid,response),first);
    assert.equal((await fs.readdir(root)).filter(name=>name.startsWith('download-')).length,0);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('invalid download never replaces last good rules',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-rule-test-'));
  try {
    const first=await updateRules(root,valid,response);
    await assert.rejects(updateRules(root,valid,async()=>new Response('invalid')));
    assert.deepEqual(await loadCachedRules(root,valid),first);
    await assert.rejects(updateRules(root,valid,async()=>new Response('error',{status:503})));
    assert.deepEqual(await loadCachedRules(root,valid),first);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('cache traversal and oversized responses are rejected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-rule-test-'));
  try {
    await fs.writeFile(path.join(root,'current.json'),JSON.stringify({id:'../../other'}));
    assert.equal(await loadCachedRules(root,valid),null);
    await assert.rejects(updateRules(root,valid,async()=>new Response('valid',{headers:{'content-length':'99999999'}})),/large/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
