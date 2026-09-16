const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const {buildConfig}=require('../src/singbox'),{resolveServer}=require('../src/server-probe');
const {measureTunnelLatency,checkTunnelConnectivity}=require('../src/latency');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-auth-isolation-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));app.setPath('userData',scratch);
const rows=[],children=new Set();
const official=process.argv.includes('--official');
const cooldown=process.argv.includes('--cooldown');
const graceful=process.argv.includes('--graceful');
const output=path.join(__dirname,`../artifacts/auth-isolation-${graceful?'graceful':official?'official':'physical'}${cooldown?'-cooldown':''}.json`);
const save=()=>{for(let n=0;;n++){try{fs.writeFileSync(output,JSON.stringify(rows,null,2));return;}catch(error){if(error.code!=='EBUSY'||n>=10)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}}};
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function run(server, label, parallel, count){
 const p=await port(),file=path.join(scratch,`config-${server.port}-${label}.json`);
 const resolved=await resolveServer(server);
 const config=buildConfig({server:resolved,applications:[],mode:'full',healthPort:p});
 config.inbounds=config.inbounds.filter(i=>i.tag==='health-in');
 if(process.env.TEMPLE_TEST_INTERFACE)for(const outbound of config.outbounds)outbound.bind_interface=process.env.TEMPLE_TEST_INTERFACE;
 let relay,relayExited;
 if(official){
  const relayPort=await port(),relayFile=path.join(scratch,`relay-${server.port}-${label}.json`);
  fs.writeFileSync(relayFile,JSON.stringify({log:{level:'error'},inbounds:[{type:'direct',tag:'udp',listen:'127.0.0.1',listen_port:relayPort,network:'udp',override_address:resolved.host,override_port:resolved.port}],outbounds:[{type:'direct',tag:'direct',bind_interface:process.env.TEMPLE_TEST_INTERFACE}],route:{final:'direct'}}));
  relay=spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',relayFile],{windowsHide:true,stdio:'ignore'});children.add(relay);
  relayExited=new Promise(resolve=>{relay.once('exit',resolve);relay.once('error',resolve);});
  await delay(200);
  fs.writeFileSync(file,JSON.stringify({server:`127.0.0.1:${relayPort}`,auth:server.password,tls:{sni:server.serverName,insecure:!!server.allowInsecure},http:{listen:`127.0.0.1:${p}`},lazy:true}));
 }else{
 fs.writeFileSync(file,JSON.stringify(config));
 }
 const executable=path.join(__dirname,official?'../.cache/hysteria-official/hysteria.exe':'../vendor/sing-box/sing-box.exe');
 const child=spawn(graceful?path.join(__dirname,'../vendor/core-host/core-host.exe'):executable,graceful?[executable,file]:[official?'client':'run','-c',file],{windowsHide:true,stdio:[graceful?'pipe':'ignore','pipe','pipe']});
 children.add(child);const codes=[];let diagnostic='';
 const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',()=>resolve());});
 const read=d=>{const text=String(d);for(const m of text.matchAll(/auth[^\n]*?\b(401|403|404|429|503)\b/gi))codes.push(Number(m[1]));
  if(/FATAL/.test(text))diagnostic='fatal';};
 child.stdout.on('data',read);child.stderr.on('data',read);
 try {
  await delay(800);
  for(let n=0;n<count;n++){
   const before=codes.length;
   const result=await (parallel?checkTunnelConnectivity(p,2500):measureTunnelLatency(p,2500));
   await delay(50);
   rows.push({label,at:new Date().toISOString(),port:server.port,check:n+1,status:result.status,ms:result.ms,authCodes:codes.slice(before),diagnostic});save();
   if(n+1<count)await delay(400);
  }
 }finally{if(graceful)child.stdin.end('stop\n');else child.kill();await exited;children.delete(child);if(relay){relay.kill();await relayExited;children.delete(relay);}}
}
app.whenReady().then(async()=>{
 try{
  const settings=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
  const subs=JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted,'base64')));
  const active=subs.find(s=>s.servers.some(p=>p.protocol==='hysteria2'&&p.host==='nl1.ozodvpn.com'));
  const selected=active.servers.find(s=>s.protocol==='hysteria2'&&s.host==='nl1.ozodvpn.com');
  if(cooldown){
   await run(selected,'initial',false,3);
   await run(selected,'immediate-restart',false,3);
   if(process.argv.includes('--quick-restart'))return;
   await delay(40000);
   await run(selected,'after-40-seconds',false,3);
   return;
  }
  for(const s of active.servers.filter(s=>s.host===selected.host&&s.protocol==='hysteria2').slice(0,4)){
   await run(s,'retained-single',false,5);
   await run(s,'retained-parallel',true,5);
  }
 }catch(error){rows.push({error:error.code||error.name,file:error.path?path.basename(error.path):undefined});save();}
 finally{for(const child of children)child.kill();try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
