const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises');
async function open(port){return new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');const done=v=>{s.destroy();resolve(v)};s.once('connect',()=>done(true));s.once('error',()=>done(false));});}
for(const force of [false,true])test(`Windows core host ${force?'cleans its child after forced exit':'shuts down the real core gracefully'}`,{skip:process.platform!=='win32',timeout:10000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temple-host-test-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify({inbounds:[{type:'mixed',listen:'127.0.0.1',listen_port:port}],outbounds:[{type:'direct'}]}));
 const child=spawn(path.join(__dirname,'../vendor/core-host/core-host.exe'),[path.join(__dirname,'../vendor/sing-box/sing-box.exe'),file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});const exited=once(child,'exit');
 try{
  const end=Date.now()+4000;while(!await open(port)&&Date.now()<end)await delay(50);
  assert.equal(await open(port),true);
  if(force)child.kill();else child.stdin.end('stop\n');
  const [code]=await exited;if(!force)assert.equal(code,0);
  const closed=Date.now()+2000;while(await open(port)&&Date.now()<closed)await delay(50);
  assert.equal(await open(port),false);
 }finally{if(child.exitCode===null)child.kill();await fs.rm(dir,{recursive:true,force:true});}
});
