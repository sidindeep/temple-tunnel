const {app,safeStorage}=require('electron');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {buildConfig}=require('../src/singbox');
const {buildXrayGroup}=require('../src/xray');
const {resolveServer}=require('../src/server-probe');
const {preparePool,selectOutbound}=require('../src/tunnel-pool');
const {checkTunnelConnectivity}=require('../src/latency');
const scratch=syncFs.mkdtempSync(path.join(os.tmpdir(),'temple-group-bench-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
syncFs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));app.setPath('userData',scratch);
const report={method:'Local mixed proxies, real saved profiles, TLS verification; no system TUN or saved preference changes',groups:[]};
const boundInterface=process.env.TEMPLE_BENCH_INTERFACE;
report.backendSocketsBoundToPhysicalInterface=Boolean(boundInterface);
const output=path.join(__dirname,`../artifacts/connection-benchmark-groups${boundInterface?'-physical':''}.json`);
const write=()=>fs.writeFile(output,JSON.stringify(report,null,2));
let sequence=0;
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function ready(child,p){for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error('CORE_STOPPED');if(await new Promise(r=>{const s=net.connect(p,'127.0.0.1');const done=v=>{s.destroy();r(v);};s.on('connect',()=>done(true));s.on('error',()=>done(false));s.setTimeout(200,()=>done(false));}))return;await delay(50);}throw Error('PORT_TIMEOUT');}
async function launch(exe,config,children,xray=false){
  if(boundInterface)for(const outbound of config.outbounds||[]){
    if(outbound.protocol==='vless')outbound.streamSettings={...outbound.streamSettings,sockopt:{...outbound.streamSettings?.sockopt,interface:boundInterface}};
    if(outbound.server&&outbound.server!=='127.0.0.1')outbound.bind_interface=boundInterface;
  }
  const file=path.join(scratch,`config-${sequence++}.json`);await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
  const valid=spawnSync(exe,xray?['run','-test','-c',file]:['check','-c',file],{windowsHide:true,timeout:10000,stdio:'ignore'});
  if(valid.status!==0)throw Error('CONFIG_REJECTED');
  const child=spawn(exe,['run','-c',file],{windowsHide:true,stdio:'ignore'});children.push(child);child.on('error',()=>{});return child;
}
async function cleanup(children){await Promise.all(children.map(async child=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}));}
function usage(children){
  const ids=children.map(c=>c.pid).filter(Number.isInteger).join(',');
  const command=`$p=Get-Process -Id ${ids}; [PSCustomObject]@{cpuSeconds=($p|ForEach-Object{$_.TotalProcessorTime.TotalSeconds}|Measure-Object -Sum).Sum;workingSetBytes=($p|Measure-Object WorkingSet64 -Sum).Sum;processes=$p.Count}|ConvertTo-Json -Compress`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:10000});
  try{return JSON.parse(result.stdout);}catch{return null;}
}
function traffic(pool){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port:pool.port,path:'/connections',headers:{Authorization:`Bearer ${pool.secret}`}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>{try{const data=JSON.parse(body);resolve({upload:data.uploadTotal,download:data.downloadTotal});}catch{resolve(null);}});});req.setTimeout(2000,()=>req.destroy());req.on('error',()=>resolve(null));});}
app.whenReady().then(async()=>{
 try {
  const settings=JSON.parse(await fs.readFile(path.join(data,'settings.json')));
  const subscriptions=JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted,'base64')));
  for(const [index,sub] of subscriptions.entries()) {
    const available=sub.servers.filter(s=>s.transport==='xhttp').slice(0,4);
    if(!available.length)continue;
    const children=[],row={application:'Temple Tunnel',subscription:index+1,kind:'XHTTP group',checks:[],switches:[]};
    report.groups.push(row);const started=Date.now();
    try {
      const members=[];for(const server of available){try{members.push({server:await resolveServer(server,undefined,1500),port:await port()});}catch{}}
      if(!members.length)throw Error('DNS_FAILED');
      const bridges=new Map(members.map(m=>[m.server.id,m.port]));
      const probePorts=new Map();for(const m of members)probePorts.set(m.server.id,await port());
      const healthPort=await port(),apiPort=await port();
      const xray=await launch(path.join(__dirname,'../vendor/xray/xray.exe'),buildXrayGroup(members),children,true);
      await ready(xray,members[0].port);
      const config=buildConfig({server:members[0].server,mode:'full',applications:[],healthPort,bridgePort:members[0].port});
      const pool=preparePool(config,members[0].server,members.map(m=>m.server),apiPort,bridges,probePorts);
      if(!pool)throw Error('SINGLE_PROFILE');
      config.inbounds=config.inbounds.filter(i=>i.type!=='tun');
      const singbox=await launch(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),config,children);
      await ready(singbox,healthPort);row.localReadyMs=Date.now()-started;
      const healthy=[];
      for(const [i,m] of members.entries()) {const result=await checkTunnelConnectivity(probePorts.get(m.server.id));row.checks.push({candidate:i+1,status:result.status,ms:result.ms});if(result.status==='ok')healthy.push(m);await write();}
      for(const m of [...healthy,...healthy].slice(0,6)) {const start=Date.now();await selectOutbound(pool,m.server.id);const result=await checkTunnelConnectivity(healthPort);row.switches.push({status:result.status,totalMs:Date.now()-start,tlsMs:result.ms});}
      row.processes=children.length;
      if(healthy.length && !report.resourceSample) {
        const before=usage(children),bytesBefore=await traffic(pool),start=Date.now();
        // Same workload as production: active health every 10 seconds, one reserve every 30 seconds.
        for(let tick=1;tick<=6;tick++){await delay(10000);await checkTunnelConnectivity(healthPort);if(tick%3===0)await checkTunnelConnectivity(probePorts.get(healthy[healthy.length-1].server.id));}
        const after=usage(children),bytesAfter=await traffic(pool);
        report.resourceSample={durationMs:Date.now()-start,before,after,bytesBefore,bytesAfter,healthChecks:6,reserveChecks:2};
      }
    }catch(error){row.error=error.message;}finally{await cleanup(children);await write();}
  }
  // Reuse Browsec's saved core configuration, changing only local listener ports and logs.
  const children=[],row={application:'Browsec',kind:'saved Xray balancer',checks:[]};report.groups.push(row);
  try {
    const browsecData=path.join(app.getPath('appData'),'browsec-desktop');
    const bridge=JSON.parse(await fs.readFile(path.join(browsecData,'browbox-config.json')));
    const config=JSON.parse(await fs.readFile(path.join(browsecData,'browray-config.json')));
    const oldPort=bridge.outbounds.find(o=>o.type==='socks').server_port;let mainPort;
    for(const inbound of config.inbounds){const old=inbound.port;inbound.listen='127.0.0.1';inbound.port=await port();if(old===oldPort)mainPort=inbound.port;}
    if(!mainPort)throw Error('NO_MAIN_LISTENER');config.log={loglevel:'none'};
    const started=Date.now();
    const child=await launch(path.join(process.env.LOCALAPPDATA,'Programs/browsec-desktop/resources/xray/browray.exe'),config,children,true);
    await ready(child,mainPort);const healthPort=await port();
    const c=buildConfig({server:{transport:'xhttp'},bridgePort:mainPort,mode:'full',applications:[],healthPort});
    c.inbounds=c.inbounds.filter(i=>i.type!=='tun');
    const adapter=await launch(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),c,children);await ready(adapter,healthPort);
    row.localReadyMs=Date.now()-started;
    for(let i=0;i<3;i++){const start=Date.now();const r=await checkTunnelConnectivity(healthPort);row.checks.push({status:r.status,totalMs:Date.now()-start,tlsMs:r.ms});}
    row.resources=usage(children);row.note='Includes Temple sing-box HTTP-to-SOCKS test adapter; excludes Browsec UI and TUN.';
  }catch(error){row.error=error.message;}finally{await cleanup(children);await write();}
 }catch(error){report.error=error.message;await write();}
 finally{try{await fs.rm(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
