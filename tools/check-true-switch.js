const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {buildConfig}=require('../src/singbox');
const {buildXrayGroup}=require('../src/xray');
const {preparePool,selectOutbound}=require('../src/tunnel-pool');
const {checkTunnelReadiness}=require('../src/latency');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-switch-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));
app.setPath('userData',scratch);
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
app.whenReady().then(async()=>{
 const children=[],results=[];
 try{
  const state=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
  const subs=JSON.parse(safeStorage.decryptString(Buffer.from(state.subscriptionsEncrypted,'base64')));
  const servers=subs.find(s=>/true/i.test(s.name)).servers.slice(0,2).map(s=>({...s,connectionEngine:'xray'}));
  if(process.env.TEMPLE_TEST_INTERFACE)for(const [index,server] of servers.entries()){
   const relayPort=await port(),file=path.join(scratch,`relay-${index}.json`);
   fs.writeFileSync(file,JSON.stringify({log:{level:'error'},inbounds:[{type:'direct',listen:'127.0.0.1',listen_port:relayPort,network:'tcp',override_address:server.host,override_port:server.port}],outbounds:[{type:'direct',tag:'direct',bind_interface:process.env.TEMPLE_TEST_INTERFACE}],route:{final:'direct'}}));
   children.push(spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:'ignore'}));
   server.host='127.0.0.1';server.port=relayPort;
  }
  const members=await Promise.all(servers.map(async server=>({server,port:await port()})));
  const bridges=new Map(members.map(m=>[m.server.id,m.port]));
  const healthPort=await port();
  const config=buildConfig({server:servers[0],applications:[],mode:'full',bridgePort:members[0].port,healthPort,dnsPreset:'legacy'});
  config.inbounds=config.inbounds.filter(i=>i.type!=='tun');
  const pool=preparePool(config,servers[0],servers,await port(),bridges);
  for(const [name,value,exe] of [['xray',buildXrayGroup(members),'xray/xray.exe'],['singbox',config,'sing-box/sing-box.exe']]){
   const file=path.join(scratch,name+'.json');fs.writeFileSync(file,JSON.stringify(value));
   children.push(spawn(path.join(__dirname,'../vendor',exe),['run','-c',file],{windowsHide:true,stdio:'ignore'}));
  }
  await new Promise(r=>setTimeout(r,500));
  for(const index of [0,1,0,1,0,1]){
   const started=Date.now();await selectOutbound(pool,servers[index].id);
   let result,attempts=0;
   do{
    attempts++;
    result=await checkTunnelReadiness(healthPort,Math.min(3000,8000-(Date.now()-started)));
    if(result.status==='ok')break;
    await new Promise(r=>setTimeout(r,250));
   }while(Date.now()-started<8000);
   results.push({serverIndex:index,status:result.status,kind:result.kind,attempts,totalMs:Date.now()-started});
  }
 }catch(e){results.push({error:e.code||e.name});}
 finally{
  await Promise.all(children.map(c=>new Promise(resolve=>{if(c.exitCode!==null)return resolve();c.once('exit',resolve);c.kill();})));
  fs.writeFileSync(path.join(__dirname,'../artifacts/true-switch-check.json'),JSON.stringify(results,null,2));
  fs.rmSync(scratch,{recursive:true,force:true});app.exit();
 }
});
