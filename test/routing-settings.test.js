const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeRouting, normalizeDns } = require('../src/routing-settings');
const { buildConfig } = require('../src/singbox');
const { poolKey } = require('../src/tunnel-pool');
test('routing normalizes IDN and addresses, deduplicates and rejects ambiguous or unsafe input',()=>{
  const result=normalizeRouting({proxy:'EXAMPLE.COM\n*.example.com\nпример.рф\n203.0.113.1\n2001:db8::1'});
  assert.deepEqual(result.proxy,['example.com','xn--e1afmkfd.xn--p1ai','203.0.113.1/32','2001:db8::1/128']);
  for(const entry of ['https://example.com','example.com#fragment','example.com:443','203.0.113.0/33','2001:db8::/129','1.2.3.999'])
    assert.throws(()=>normalizeRouting({direct:entry}));
  assert.throws(()=>normalizeRouting({proxy:'example.com',direct:'example.com'}));
  assert.throws(()=>normalizeRouting({block:Array(501).fill('example.com')}));
  assert.throws(()=>normalizeDns('__proto__'));
});
test('custom rules precede application and regional rules; DNS follows domain decisions',()=>{
  for(const mode of ['full','selected','bypass']) {
    const config=buildConfig({server:{host:'192.0.2.1',port:443,uuid:'550e8400-e29b-41d4-a716-446655440000',security:'none'},
      applications:[{processName:'test.exe'}],mode,dnsPreset:'cloudflare',
      customRouting:{proxy:['example.com'],direct:['example.net'],block:['ads.example.com','203.0.113.0/24']}});
    const custom=config.route.rules.filter(rule=>rule.domain_suffix);
    assert.deepEqual(custom.map(rule=>rule.action),['reject','route','route']);
    const dns=config.dns.rules.filter(rule=>rule.domain_suffix?.includes('example.com'))[0];
    assert.equal(dns.server,'dns-proxy');
    assert.ok(config.route.rules.indexOf(custom[0])<config.route.rules.findIndex(rule=>rule.process_name?.includes('test.exe'))||mode==='full');
    assert.equal(config.dns.servers[1].detour,'proxy');assert.equal(config.dns.servers[1].type,'https');
  }
  assert.notEqual(poolKey({dnsPreset:'legacy'},[]),poolKey({dnsPreset:'cloudflare'},[]));
  assert.notEqual(poolKey({customRouting:{}},[]),poolKey({customRouting:{block:['example.com']}},[]));
});
test('all DNS presets and custom rules pass validation in bundled sing-box',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'temple-routing-'));
  try {
    for(const dnsPreset of ['legacy','cloudflare','google','quad9']) {
      const config=buildConfig({server:{host:'192.0.2.1',port:443,uuid:'550e8400-e29b-41d4-a716-446655440000',security:'none'},
        applications:[],mode:'full',dnsPreset,healthPort:54321,bridgePort:54322,
        customRouting:{proxy:['example.com'],direct:['example.net'],block:['ads.example.com','203.0.113.0/24']}});
      const file=path.join(directory,'config.json');fs.writeFileSync(file,JSON.stringify(config));
      const checked=spawnSync(path.join(__dirname,'../vendor/sing-box/sing-box.exe'),['check','-c',file],{encoding:'utf8',windowsHide:true});
      assert.equal(checked.status,0,checked.stderr);
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('Xray bridge uses HTTPS for default DNS and preserves explicit providers',()=>{
  const base={server:{host:'192.0.2.1',port:443,uuid:'test',transport:'tcp'},applications:[],mode:'full',healthPort:54321};
  assert.equal(buildConfig({...base,dnsPreset:'legacy'}).dns.servers[1].type,'udp');
  for(const dnsPreset of [undefined,'legacy','cloudflare','google','quad9']){
    const config=buildConfig({...base,bridgePort:54322,dnsPreset});
    const resolver=config.dns.servers[1];
    assert.equal(resolver.type,'https');
    assert.equal(resolver.detour,'proxy');
    assert.equal(resolver.server,dnsPreset==='google'?'8.8.8.8':dnsPreset==='quad9'?'9.9.9.9':'1.1.1.1');
    assert.equal(config.dns.rules[0].disable_cache,true);
    assert.equal(config.route.rules[0].action,'hijack-dns');
  }
});
