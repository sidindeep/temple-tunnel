const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
const {buildXrayGroup}=require('../src/xray'),{buildConfig}=require('../src/singbox'),{preparePool,selectOutbound}=require('../src/tunnel-pool');
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function port(){const s=net.createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p;}
function exchange(port){return new Promise((resolve,reject)=>{
  const s=net.connect(port,'127.0.0.1');let body='',sent=false;
  const timer=setTimeout(()=>s.destroy(Error('Data timeout')),3000);
  s.on('connect',()=>s.write('CONNECT 203.0.113.1:443 HTTP/1.1\r\nHost: test\r\n\r\n'));
  s.on('data',chunk=>{body+=chunk;if(!sent&&body.includes('\r\n\r\n')){if(!body.startsWith('HTTP/1.1 200')){s.destroy(Error('Proxy rejected'));return;}sent=true;body='';s.write('payload');}
    else if(sent&&body.endsWith('payload')){s.destroy();resolve(body);}});
  s.on('error',reject);s.on('close',()=>clearTimeout(timer));
});}
test('real Xray group routes each reserve independently and hot switching preserves both cores', {timeout:15000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'temple-xhttp-group-'));
  const children=[],peers=[];let diagnostic='';
  try {
    const members=[];
    for(const id of ['A','B']) {
      const endpoint=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',chunk=>socket.write(id+chunk));});peers.push(endpoint);
      const endpointPort=await listen(endpoint);
      members.push({server:{id,transport:'xhttp',security:'none',host:'127.0.0.1',port:await port(),uuid:'550e8400-e29b-41d4-a716-446655440000',path:'/test'},port:await port(),endpointPort});
    }
    const xray=buildXrayGroup(members);
    for(const m of members) {
      const tag=`peer-${m.server.id}`;
      xray.inbounds.push({tag,listen:'127.0.0.1',port:m.server.port,protocol:'vless',settings:{clients:[{id:m.server.uuid}],decryption:'none'},
        streamSettings:{network:'xhttp',security:'none',xhttpSettings:{path:'/test'}}});
      xray.outbounds.push({tag,protocol:'freedom',settings:{redirect:`127.0.0.1:${m.endpointPort}`}});
      xray.routing.rules.unshift({type:'field',inboundTag:[tag],outboundTag:tag});
    }
    const healthPort=await port(),apiPort=await port(),probePorts=new Map([['A',await port()],['B',await port()]]);
    const config=buildConfig({server:members[0].server,bridgePort:members[0].port,mode:'full',applications:[],healthPort});
    const pool=preparePool(config,members[0].server,members.map(m=>m.server),apiPort,new Map(members.map(m=>[m.server.id,m.port])),probePorts);
    config.inbounds=config.inbounds.filter(i=>i.type!=='tun');
    for(const [name,content] of [['xray',xray],['sing-box',config]]) {
      const file=path.join(directory,`${name}.json`);await fs.writeFile(file,JSON.stringify(content));
      const exe=path.join(__dirname,name==='xray'?'../vendor/xray/xray.exe':'../vendor/sing-box/sing-box.exe');
      const child=spawn(exe,['run','-c',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
      child.stderr.on('data',chunk=>diagnostic+=chunk);child.on('error',()=>{});
    }
    let ready=false;
    for(let i=0;i<50;i++){try{await selectOutbound(pool,'A');ready=true;break;}catch{}if(children.some(c=>c.exitCode!==null))break;await delay(30);}
    assert.ok(ready,diagnostic);
    assert.equal(await exchange(probePorts.get('B')),'Bpayload');
    assert.equal(await exchange(healthPort),'Apayload'); // probing B must leave selected A in place
    for(const id of ['B','A','B']){await selectOutbound(pool,id);assert.equal(await exchange(healthPort),`${id}payload`);}
    assert.ok(children.every(c=>c.exitCode===null));
  } finally {
    await Promise.all(children.map(async c=>{if(c.exitCode===null){const exit=once(c,'exit');c.kill();await exit;}}));
    await Promise.all(peers.map(s=>new Promise(r=>s.close(r))));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
