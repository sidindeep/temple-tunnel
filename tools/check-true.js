const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {probeServer}=require('../src/server-probe');
const {buildXrayConfig}=require('../src/xray');
const {downloadSubscription}=require('../src/subscription');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-true-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));app.setPath('userData',scratch);
app.whenReady().then(async()=>{
 const rows=[];
 try{
  const state=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
  const subs=JSON.parse(safeStorage.decryptString(Buffer.from(state.subscriptionsEncrypted,'base64')));
  fs.writeFileSync(path.join(__dirname,'../.cache/subscription-names.json'),JSON.stringify(subs.map(s=>({name:s.name,count:s.servers.length}))));
  const sub=subs.find(s=>/true/i.test(s.name));if(!sub)throw Error('SUBSCRIPTION_NOT_FOUND');
  if(process.argv.includes('--export')){
   const exportFile=process.env.TEMPLE_TEST_EXPORT_FILE;
   if(!exportFile)throw Error('TEMPLE_TEST_EXPORT_FILE is required with --export');
   const exported=JSON.parse(fs.readFileSync(exportFile,'utf8'));
   const out=exported.outbounds.find(o=>o.protocol==='vless'),endpoint=out.settings.vnext[0],user=endpoint.users[0],r=out.streamSettings.realitySettings;
   const s={id:'happ-export',name:'Happ exported server',protocol:'vless',host:endpoint.address,port:endpoint.port,uuid:user.id,flow:user.flow,encryption:user.encryption,transport:out.streamSettings.network,security:out.streamSettings.security,serverName:r.serverName,publicKey:r.publicKey,shortId:r.shortId,fingerprint:r.fingerprint,spiderX:r.spiderX};
   const old=sub.servers.find(p=>p.host===s.host&&p.port===s.port);
   rows.push({exportedEndpointInSubscription:!!old,matchingFields:old?Object.fromEntries(['uuid','flow','encryption','serverName','publicKey','shortId','fingerprint','spiderX'].map(k=>[k,old[k]===s[k]])):undefined,tcpSettings:out.streamSettings.tcpSettings});
   sub.servers=[s];
  }
  const happLog=fs.readFileSync(path.join(process.env.LOCALAPPDATA,'Happ/logs/subscription_log.txt'),'utf8');
  const matches=[...happLog.matchAll(/Subscription being added: (https?:\/\/\S+)/g)];
  const happSource=matches.map(m=>m[1]).find(u=>new URL(u).hostname===new URL(sub.source).hostname);
  if(happSource)rows.push({sameHappSource:happSource===sub.source,happQueryKeys:[...new URL(happSource).searchParams.keys()],ourQueryKeys:[...new URL(sub.source).searchParams.keys()]});
  if(process.argv.includes('--source-only'))return;
  if(process.argv.includes('--fresh')){
   const fresh=await downloadSubscription(sub.source,async(url,options)=>{
    if(process.argv.includes('--happ-agent'))options.headers['User-Agent']='Happ/4.1.3';
    if(process.argv.includes('--device')){
     const deviceFile=path.join(data,'device-id.json');
     if(!fs.existsSync(deviceFile))fs.writeFileSync(deviceFile,JSON.stringify({id:require('node:crypto').randomUUID()}),{flag:'wx'});
     options.headers['x-hwid']=JSON.parse(fs.readFileSync(deviceFile)).id;
     options.headers['x-device-os']='Windows';options.headers['x-ver-os']=os.release();options.headers['x-device-model']='Temple Tunnel Desktop';
    }
    const response=await fetch(url,options);
    const body=require('../src/subscription').decodeSubscriptionBody(await response.clone().text());
    const links=body.split(/\r?\n/).filter(s=>s.startsWith('vless://')).slice(0,2);
    rows.push({parameterNames:links.map(s=>[...new URL(s).searchParams.keys()]),headerNames:[...response.headers.keys()]});
    rows.push({httpStatus:response.status,deviceHeaders:Object.fromEntries(['x-hwid-active','x-hwid-not-supported','x-hwid-max-devices-reached','x-hwid-limit','providerid'].map(k=>[k,response.headers.get(k)]))});
    return response;
   });
   const fields=['uuid','publicKey','shortId','serverName','fingerprint','host','port'];
   rows.push({freshCount:fresh.length,sameProfiles:JSON.stringify(fresh)===JSON.stringify(sub.servers),changes:Object.fromEntries(fields.map(field=>[field,fresh.filter(p=>{const old=sub.servers.find(s=>s.name===p.name);return old&&old[field]!==p[field];}).length]))});
   sub.servers=fresh;
   if(process.argv.includes('--compare-only'))return;
  }
  for(const original of sub.servers.slice(0,2))for(const engine of process.argv.includes('--automatic')?['automatic']:['sing-box-original','xray','sing-box-chrome']){
   const server={...original,...(engine==='sing-box-chrome'?{fingerprint:'chrome'}:{})};
   const diagnostics=[];
   let relay;
   if(process.argv.includes('--physical')){
    const net=require('node:net');const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    const file=path.join(scratch,`relay-${port}.json`);
    fs.writeFileSync(file,JSON.stringify({log:{level:'error'},inbounds:[{type:'direct',listen:'127.0.0.1',listen_port:port,network:'tcp',override_address:server.host,override_port:server.port}],outbounds:[{type:'direct',tag:'direct',bind_interface:process.env.TEMPLE_TEST_INTERFACE}],route:{final:'direct'}}));
    relay=spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    relay.stderr.on('data',d=>diagnostics.push('relay: '+require('../src/file-log').sanitizeLog(String(d))));
    server.host='127.0.0.1';server.port=port;
   }
   const result=await probeServer(server,path.join(__dirname,'../vendor/sing-box/sing-box.exe'),path.join(__dirname,'../vendor/xray/xray.exe'),{spawnProcess:(exe,args,opts)=>{
    if(engine==='xray'){
     const file=args[args.indexOf('-c')+1],old=JSON.parse(fs.readFileSync(file));
     const config=buildXrayConfig({server:{...server,transport:'xhttp'},socksPort:old.inbounds[0].listen_port});
     config.inbounds[0].protocol='http';config.inbounds[0].settings={};
     config.outbounds[0].streamSettings.network='tcp';delete config.outbounds[0].streamSettings.xhttpSettings;
     config.log.loglevel='debug';
     fs.writeFileSync(file,JSON.stringify(config));exe=path.join(__dirname,'../vendor/xray/xray.exe');
    }
    const c=spawn(exe,args,opts);const read=d=>{
     if(engine==='xray'&&process.argv.includes('--export')){
      let text=String(d);for(const value of [server.uuid,server.publicKey,server.shortId])if(value)text=text.split(value).join('[redacted]');
      diagnostics.push(require('../src/file-log').sanitizeLog(text).slice(0,1500));
     }
     for(const marker of ['REALITY verification failed','TLS handshake','connection refused','connection reset','EOF','invalid UUID','flow','certificate','timeout','unsupported','bad response','permission','rejected'])if(String(d).toLowerCase().includes(marker.toLowerCase()))diagnostics.push(marker);
    };c.stderr.on('data',read);c.stdout.on('data',read);return c;
   }});
   if(relay){const done=new Promise(resolve=>relay.once('exit',resolve));relay.kill();await done;}
   rows.push({engine,connectionEngine:result.resolvedServer?.connectionEngine,name:server.name,host:server.host,port:server.port,transport:server.transport,security:server.security,flow:server.flow,fingerprint:server.fingerprint,encryption:server.encryption,publicKeyLength:server.publicKey?.length,status:result.status,reason:result.reason,ms:result.ms,diagnostics});
  }
 }catch(e){rows.push({error:e.code||e.message});}
 finally{fs.writeFileSync(path.join(__dirname,`../artifacts/true-comparison${process.argv.includes('--physical')?'-physical':''}${process.argv.includes('--export')?'-export':''}${process.argv.includes('--device')?'-device':''}${process.argv.includes('--happ-agent')?'-happ-agent':process.argv.includes('--fresh')?'-fresh':''}.json`),JSON.stringify(rows,null,2));try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
