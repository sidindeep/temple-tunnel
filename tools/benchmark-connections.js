// Anonymized, local-proxy-only measurements. Does not change VPN routes or saved preferences.
const {app,safeStorage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {probeServer}=require('../src/server-probe');
const {rankCandidates,selectWorkingServer,recordResult,hedgeDelay}=require('../src/connection-selection');
const {isSupportedTransport}=require('../src/subscription');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-benchmark-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));
app.setPath('userData',scratch);
const report={method:'selection with local proxy and verified TLS; excludes system TUN creation',runs:[]};
const improved=process.argv.includes('--improved');
const paired=process.argv.includes('--paired');
const boundInterface=process.env.TEMPLE_BENCH_INTERFACE;
report.backendSocketsBoundToPhysicalInterface=Boolean(boundInterface);
const output=path.join(__dirname,`../artifacts/connection-benchmark-${paired?'paired':improved?'improved':'baseline'}${boundInterface?'-physical':''}.json`);
app.whenReady().then(async()=>{
  try {
    const settings=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
    const subscriptions=JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted,'base64')));
    for(const [index,subscription] of subscriptions.entries()) {
      if(paired&&index>=3)break;
      const history={};let lastSuccessfulId='';
      const candidates=subscription.servers.filter(server=>isSupportedTransport(server.transport));
      for(let round=0;round<(paired?6:3);round++) {
        const events=[];let processes=0;
        const started=Date.now();
        const adaptive=paired?round%2===1:improved;
        const row={subscription:index+1,round:round+1,candidates:candidates.length,adaptive};
        try {
          const selected=await selectWorkingServer(rankCandidates(candidates,{selectedId:subscription.selectedServerId,lastSuccessfulId,history}),
            (server,signal)=>probeServer(server,path.join(__dirname,'../vendor/sing-box/sing-box.exe'),path.join(__dirname,'../vendor/xray/xray.exe'),{
              signal,spawnProcess:(...args)=>{
                processes++;
                if(boundInterface){const file=args[1][args[1].indexOf('-c')+1];const config=JSON.parse(fs.readFileSync(file));
                  for(const outbound of config.outbounds||[]){
                    if(outbound.protocol==='vless')outbound.streamSettings={...outbound.streamSettings,sockopt:{...outbound.streamSettings?.sockopt,interface:boundInterface}};
                    if(outbound.server&&outbound.server!=='127.0.0.1')outbound.bind_interface=boundInterface;
                  }fs.writeFileSync(file,JSON.stringify(config));}
                return require('node:child_process').spawn(...args);
              },
              onStage:(stage,ms)=>events.push({candidate:candidates.indexOf(server)+1,stage,ms})
            }),{hedgeMs:adaptive?hedgeDelay(history[lastSuccessfulId]):round?350:0,onResult:(server,result)=>recordResult(history,server.id,result)});
          lastSuccessfulId=selected.server.id;
          Object.assign(row,{ok:true,transport:selected.server.transport,winner:candidates.indexOf(selected.server)+1,tlsMs:selected.result.ms});
        }catch(error){Object.assign(row,{ok:false,code:error.code||'ERROR'});}
        Object.assign(row,{totalMs:Date.now()-started,processes,events});
        report.runs.push(row);fs.writeFileSync(output,JSON.stringify(report,null,2));
      }
    }
  }finally{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
