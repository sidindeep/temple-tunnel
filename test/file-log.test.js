const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileLog, sanitizeLog, coreDiagnostic } = require('../src/file-log');
const codec = { protect: s => Buffer.from(s), unprotect: b => b.toString() }; // DPAPI is verified separately under Electron.
async function fixture(t, options = {}) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'temple-log-test-'));
 t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
 return { dir, log: await createFileLog(dir, { ...codec, ...options }) };
}
test('encrypted records survive reopening and exports redact secrets', async t => {
 const {dir, log} = await fixture(t);
 log.write('hello authorization: Bearer secret-value https://host/sub/private user@example.com');
 await log.flush();
 const disk = await fs.readFile(path.join(dir, 'temple-tunnel.enc'), 'utf8');
 assert.ok(!disk.includes('hello')); assert.ok(!disk.includes('secret-value'));
 const reopened = await createFileLog(dir, codec);
 const exported = await reopened.exportText();
 assert.match(exported, /hello/); assert.doesNotMatch(exported, /secret-value|host\/sub|user@example/);
});
test('rotation stays bounded and exports newest entries', async t => {
 const {dir, log} = await fixture(t, { maxBytes: 512, backups: 2 });
 for (let i=0;i<30;i++) log.write(`event-${i} ${'x'.repeat(50)}`);
 await log.flush();
 const files = (await fs.readdir(dir)).filter(f=>f.includes('.enc'));
 assert.ok(files.length<=3);
 for (const file of files) assert.ok((await fs.stat(path.join(dir,file))).size<=512);
 assert.match(await log.exportText(), /event-29/);
});
test('old files expire and tampered entries are not decrypted', async t => {
 const {dir,log} = await fixture(t);
 log.write('first'); await log.flush();
 const file = path.join(dir,'temple-tunnel.enc');
 await fs.appendFile(file, 'tampered\n');
 assert.match(await log.exportText(), /Повреждённая/);
 const old = new Date(Date.now()-8*86400000); await fs.utimes(file,old,old);
 const reopened = await createFileLog(dir, codec);
 assert.doesNotMatch(await reopened.exportText(), /first/);
});
test('no plaintext fallback when Windows key protection fails', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'temple-log-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await assert.rejects(createFileLog(dir,{...codec,protect:()=>{throw Error('locked');}}));
 assert.deepEqual(await fs.readdir(dir), []);
});
test('write failures are reported without crashing the app', async t => {
 let errors=0;
 const {dir,log}=await fixture(t,{onError:()=>errors++});
 await fs.rm(dir,{recursive:true,force:true});
 log.write('event'); await log.flush();
 assert.equal(errors,1);
});
test('raw core data is reduced to fixed diagnostic categories', () => {
 assert.equal(coreDiagnostic('ERROR TLS handshake failed token=secret'), 'Ошибка TLS/рукопожатия.');
 assert.equal(coreDiagnostic('configuration password=secret'), '');
 assert.doesNotMatch(sanitizeLog('password="secret" vless://private email@example.org'), /secret|private|email@/);
});
