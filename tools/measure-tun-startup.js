const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
(async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'temple-tun-start-'));const results=[];
 try{
 for(let attempt=1;attempt<=4;attempt++){
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  const file=path.join(folder,'config.json');
  const unique=process.argv.includes('--unique');
  await fs.writeFile(file,JSON.stringify({log:{level:'debug'},inbounds:[{type:'tun',tag:'tun',interface_name:unique?`temple-test-${process.pid}-${attempt}`:'temple-startup-test',address:['172.30.252.1/30'],auto_route:false,stack:'mixed'},
   {type:'mixed',tag:'probe',listen:'127.0.0.1',listen_port:port}],outbounds:[{type:'direct',tag:'direct'}],route:{final:'direct',auto_detect_interface:true}}));
  const started=Date.now(),row={attempt,ready:false};const logs=[];
  const child=spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.on('error',e=>{row.error=e.code;});child.stdout.on('data',d=>logs.push({ms:Date.now()-started,message:String(d)}));child.stderr.on('data',d=>logs.push({ms:Date.now()-started,message:String(d)}));
  try{
   while(Date.now()-started<30000&&child.exitCode===null){
    row.ready=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');const done=v=>{s.destroy();r(v);};s.on('connect',()=>done(true));s.on('error',()=>done(false));s.setTimeout(200,()=>done(false));});
    if(row.ready)break;await delay(100);
   }
   row.elapsedMs=Date.now()-started;row.logs=logs;
  }finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}
  results.push(row);await fs.writeFile(path.join(__dirname,`../artifacts/tun-startup-measurements${unique?'-unique':''}.json`),JSON.stringify(results,null,2));
 }
 }finally{await fs.rm(folder,{recursive:true,force:true});}
})().catch(()=>process.exitCode=1);
