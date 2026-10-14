const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {promisify}=require('node:util');
const run=promisify(require('node:child_process').execFile);
const {buildConfig}=require('../src/singbox');
const {spawn}=require('node:child_process');

test('bundled core actually starts with captured direct DNS in every mode without TUN or network requests', {skip:process.platform!=='win32'}, async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-dns-startup-'));
  try {
    for(const mode of ['full','selected','bypass']) {
      const config=buildConfig({server:{host:'192.0.2.1',port:443,uuid:'11111111-1111-4111-8111-111111111111',security:'none'},
        applications:[{processName:'example.exe'}],mode,directDns:'192.0.2.53'});
      config.inbounds=[]; // No adapter, listeners, real profiles or outgoing requests.
      const file=path.join(root,'config.json');await fs.writeFile(file,JSON.stringify(config));
      await new Promise((resolve,reject)=>{
        let output='',started=false;
        const child=spawn(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
        const timer=setTimeout(()=>{child.kill();reject(Error('Core did not start within 5s'));},5000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        const read=chunk=>{output+=chunk.toString();if(!started && output.includes('sing-box started')){started=true;child.kill();}};
        child.stdout.on('data',read);child.stderr.on('data',read);
        child.once('close',()=>{clearTimeout(timer);started?resolve():reject(Error(output));});
      });
    }
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('bundled sing-box accepts IPv6 and DNS policies in every routing mode without starting TUN',{skip:process.platform!=='win32'},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-core-policy-'));
  try {
    for(const mode of ['full','selected','bypass']) for(const ipv6Policy of ['block','tunnel']) for(const dnsPolicy of ['routing','vpn']) {
      const config=buildConfig({server:{host:'192.0.2.1',port:443,uuid:'11111111-1111-4111-8111-111111111111',security:'tls',serverName:'example.com'},
        applications:[{processName:'example.exe'}],mode,ipv6Policy,dnsPolicy,directDns:'1.1.1.1',healthPort:23001});
      const file=path.join(root,'config.json');await fs.writeFile(file,JSON.stringify(config));
      const result=await run(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['check','-c',file],{windowsHide:true,timeout:10000});
      assert.equal(result.stderr.includes('FATAL'),false);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
