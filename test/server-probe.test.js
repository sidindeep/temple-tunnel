const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveServer, probeHysteria } = require('../src/server-probe');
test('bootstrap resolution preserves TLS name and original profile', async () => {
  const server = {host: 'example.com', password: 'secret'};
  const resolved = await resolveServer(server, async () => ({address: '192.0.2.1'}));
  assert.equal(resolved.host, '192.0.2.1');
  assert.equal(resolved.serverName, 'example.com');
  assert.equal(server.host, 'example.com');
});
test('bootstrap keeps explicit SNI and skips numeric IPs', async () => {
  assert.equal((await resolveServer({host:'example.com',serverName:'tls.example.com'}, async () => ({address:'192.0.2.1'}))).serverName, 'tls.example.com');
  const server = {host:'192.0.2.1'};
  assert.equal(await resolveServer(server, () => {throw Error('unexpected');}), server);
});
test('bootstrap DNS has bounded timeout', async () => {
  await assert.rejects(resolveServer({host:'example.com'}, () => new Promise(() => {}), 10), /DNS/);
});
test('probe handles missing engine and cleans up without hanging', async () => {
  const result = await probeHysteria({host:'192.0.2.1', protocol:'hysteria2', password:'test'}, 'nonexistent-temple-test-engine');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'local');
});

test('DNS cancellation interrupts a pending lookup', async () => {
  const controller = new AbortController();
  const pending = resolveServer({host:'example.com'},()=>new Promise(()=>{}),5000,controller.signal);
  controller.abort();
  await assert.rejects(pending,{code:'ABORT_ERR'});
});

test('cancelled candidate does not spawn a process', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await probeHysteria({host:'192.0.2.1'},'unused','unused',{
    signal:controller.signal,spawnProcess:()=>assert.fail('must not spawn')
  });
  assert.equal(result.status,'cancelled');
});

test('cancellation kills a real proxy process, removes its config and never creates TUN', async () => {
  const fs = require('node:fs');
  const {spawn} = require('node:child_process');
  const controller = new AbortController();
  let child, directory;
  let ready;
  const started = new Promise(resolve=>{ready=resolve;});
  const pending = probeHysteria({host:'192.0.2.1',protocol:'vless',transport:'tcp',security:'none',uuid:'test',port:443},'unused',null,{
    signal:controller.signal,
    onStage:name=>{if(name==='proxy-ready')ready();},
    spawnProcess(_exe,args) {
      const file=args[args.length-1];
      directory=require('node:path').dirname(file);
      const config=JSON.parse(fs.readFileSync(file));
      assert.deepEqual(config.inbounds.map(i=>i.type),['mixed']);
      child=spawn(process.execPath,['-e',`require('node:net').createServer(()=>{}).listen(${config.inbounds[0].listen_port},'127.0.0.1')`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      return child;
    }
  });
  await Promise.race([started,pending.then(()=>{throw Error('proxy did not start');})]);
  controller.abort();
  assert.equal((await pending).status,'cancelled');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(fs.existsSync(directory),false);
});
