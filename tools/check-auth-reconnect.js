const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const {probeServer}=require('../src/server-probe');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-auth-check-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));app.setPath('userData',scratch);
app.whenReady().then(async()=>{
 const rows=[];
 try{
  const settings=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
  const subscriptions=JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted,'base64')));
  const active=subscriptions.find(s=>s.id===settings.activeSubscriptionId);
  const selected=active.servers.find(s=>s.id===settings.selectedServerId);
  const candidates=[selected,...active.servers].filter((s,i,all)=>s&&s.protocol==='hysteria2'&&all.findIndex(a=>a?.id===s.id)===i).slice(0,2);
  for(const [candidate,server] of candidates.entries())for(const pause of [0,0,2000]){
   if(pause)await delay(pause);const authCodes=[];
   const result=await probeServer(server,path.join(__dirname,'../vendor/sing-box/sing-box.exe'),path.join(__dirname,'../vendor/xray/xray.exe'),{spawnProcess:(...args)=>{
    const child=spawn(...args);child.stderr.on('data',d=>{const text=String(d);for(const match of text.matchAll(/auth[^\n]*?\b(401|403|404|429|503)\b/gi))authCodes.push(Number(match[1]));});return child;
   }});
   rows.push({candidate:candidate+1,pauseMs:pause,status:result.status,reason:result.reason,ms:result.ms,authCodes});
   fs.writeFileSync(path.join(__dirname,'../artifacts/auth-reconnect-check.json'),JSON.stringify(rows,null,2));
  }
 }finally{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
