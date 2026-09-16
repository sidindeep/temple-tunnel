const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {verifyEnvelope,createUpdates,hash} = require('../src/signed-updates');
const keys=crypto.generateKeyPairSync('ed25519');
function sign(manifest) { const payload=Buffer.from(JSON.stringify(manifest));return Buffer.from(JSON.stringify({payload:payload.toString('base64'),signature:crypto.sign(null,payload,keys.privateKey).toString('base64')})); }
const base={schema:1,product:'temple-tunnel',kind:'app',version:'0.15.0',minApp:'0.14.0',files:[{name:'setup.exe',size:3,sha256:'a'.repeat(64)}]};
test('release signatures, compatibility, rollback and path allowlist are enforced',()=>{
  assert.equal(verifyEnvelope(sign(base),keys.publicKey,'0.14.0').version,'0.15.0');
  const broken=JSON.parse(sign(base));broken.payload=Buffer.from(JSON.stringify({...base,version:'9.0.0'})).toString('base64');
  assert.throws(()=>verifyEnvelope(Buffer.from(JSON.stringify(broken)),keys.publicKey,'0.14.0'),/Подпись/);
  assert.throws(()=>verifyEnvelope(sign(base),keys.publicKey,'0.13.0'),/несовместим/);
  assert.throws(()=>verifyEnvelope(sign(base),keys.publicKey,'0.16.0'),/старее/);
  assert.equal(verifyEnvelope(sign(base),keys.publicKey,'0.16.0',true).version,'0.15.0');
  assert.throws(()=>verifyEnvelope(sign({...base,files:[{...base.files[0],name:'../setup.exe'}]}),keys.publicKey,'0.14.0'),/список/);
  assert.throws(()=>verifyEnvelope(sign({...base,kind:'cores'}),keys.publicKey,'0.14.0'),/проверены/);
});
test('staging rejects tampering and activation preserves a verified rollback',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-update-test-'));
  try {
    const source=path.join(root,'source');await fs.mkdir(source);
    await fs.writeFile(path.join(source,'setup.exe'),'one');
    const make=async(version)=>{const manifest={...base,version,files:[{name:'setup.exe',...await hash(path.join(source,'setup.exe'))}]};await fs.writeFile(path.join(source,'update.json'),sign(manifest));};
    const updates=createUpdates(path.join(root,'store'),keys.publicKey,'0.14.0');
    await make('0.15.0');const first=await updates.stage(path.join(source,'update.json'));await updates.activate(first);
    await fs.writeFile(path.join(source,'setup.exe'),'two');await make('0.16.0');
    const second=await updates.stage(path.join(source,'update.json'));await updates.activate(second);
    assert.equal((await updates.previous('app')).id,first.id);
    await fs.writeFile(path.join(second.directory,'setup.exe'),'bad');
    await assert.rejects(updates.current('app'),/сумма/);
    assert.equal((await updates.previous('app')).id,first.id);
    await fs.writeFile(path.join(source,'setup.exe'),'bad');
    await assert.rejects(updates.stage(path.join(source,'update.json')),/сумма/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
