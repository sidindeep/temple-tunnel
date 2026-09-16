const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { preparePool, selectOutbound, poolKey } = require('../src/tunnel-pool');
const { buildConfig } = require('../src/singbox');
const profile = id => ({id,transport:'tcp',security:'none',host:'127.0.0.1',port:443,
  uuid:'550e8400-e29b-41d4-a716-446655440000'});
async function port() {
  const server = net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;
}
function get(pool, token=pool.secret) {
  return new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port:pool.port,path:'/proxies/proxy',headers:{Authorization:`Bearer ${token}`}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(body)}));
    }).on('error',reject);
  });
}
test('group is bounded, secret is fresh, and XHTTP falls back to its bridge',()=>{
  const candidates=Array.from({length:9},(_,i)=>profile(String(i)));
  const config={};const pool=preparePool(config,candidates[0],candidates,12345);
  assert.equal(pool.members.size,5);assert.equal(config.experimental.clash_api.external_controller,'127.0.0.1:12345');
  assert.notEqual(pool.secret,preparePool({},candidates[0],candidates,12345).secret);
  assert.equal(preparePool({}, {...candidates[0],transport:'xhttp'},candidates,12345),null);
  assert.notEqual(poolKey({mode:'full'},candidates),poolKey({mode:'selected'},candidates));
});
test('real sing-box switches native outbounds through authenticated loopback API without restarting',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temple-pool-test-'));
  let child;
  try {
    const apiPort=await port(),healthPort=await port();
    const a=profile('a'), b=profile('b');a.port=await port();b.port=await port();
    const config=buildConfig({server:a,applications:[],mode:'full',healthPort});
    const pool=preparePool(config,a,[b],apiPort);
    config.inbounds=config.inbounds.filter(item=>item.type!=='tun');
    // Local VLESS peers exercise the actual data path without touching the system TUN or Internet.
    for(const server of [a,b]) {
      config.inbounds.push({type:'vless',tag:server.id,listen:'127.0.0.1',listen_port:server.port,users:[{uuid:server.uuid}]});
      config.route.rules.unshift({inbound:server.id,action:'route',outbound:'direct'});
    }
    const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify(config));
    child=spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:'pipe'});
    let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);
    child.on('error',()=>{});
    let ready=false;
    for(let i=0;i<100;i++) {
      try {if((await get(pool)).code===200){ready=true;break;}}catch{}
      if(child.exitCode!==null)break;await delay(20);
    }
    assert.ok(ready,diagnostic);
    assert.equal((await get(pool,'wrong-secret')).code,401);
    const echo=net.createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');
    try {
      for(const server of [b,a]) {
        await selectOutbound(pool,server.id);
        assert.equal((await get(pool)).body.now,pool.members.get(server.id));
        await new Promise((resolve,reject)=>{
          const socket=net.createConnection({host:'127.0.0.1',port:healthPort});
          const timer=setTimeout(()=>socket.destroy(Error('Proxy data timeout')),2000);
          let received='',sent=false;
          socket.on('connect',()=>socket.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n`));
          socket.on('data',chunk=>{
            received+=chunk;
            if(!sent&&received.includes('\r\n\r\n')){assert.match(received,/200/);sent=true;received='';socket.write('verified-payload');}
            else if(sent&&received.includes('verified-payload')){socket.destroy();resolve();}
          });
          socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));
        });
        assert.equal(child.exitCode,null);
      }
    }finally{await new Promise(resolve=>echo.close(resolve));}
    const controller=new AbortController();controller.abort();
    await assert.rejects(selectOutbound(pool,'b',controller.signal),{name:'AbortError'});
  } finally {
    if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await fs.rm(dir,{recursive:true,force:true});
  }
});
