const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {promisify}=require('node:util');
const run=promisify(require('node:child_process').execFile);
const {buildConfig}=require('../src/singbox');
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
