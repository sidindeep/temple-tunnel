const test = require('node:test');
const assert = require('node:assert/strict');
const {buildConfig} = require('../src/singbox');
const options = {server:{host:'192.0.2.1',port:443,uuid:'test',security:'none'},applications:[],mode:'full',ruleSetPaths:{geoipRu:'geoip.srs',geositeRu:'geosite.srs'}};
test('full protection keeps Russian traffic in VPN by default',()=>{
  const config=buildConfig(options);
  assert.equal(config.route.rules.some(rule=>rule.rule_set),false);
  assert.equal(config.dns.rules.some(rule=>rule.rule_set),false);
  assert.equal(config.route.final,'proxy');
});
test('full protection can bypass Russian domains and IPs with direct DNS',()=>{
  const config=buildConfig({...options,russianSitesViaVpn:false});
  const rule=config.route.rules.find(rule=>rule.rule_set);
  assert.deepEqual(rule.rule_set,['geoip-ru','geosite-category-ru']);
  assert.equal(rule.outbound,'direct');
  assert.equal(config.dns.rules.find(rule=>rule.rule_set).server,'dns-direct');
  assert.equal(config.route.final,'proxy');
  assert.equal(config.dns.final,'dns-proxy');
});
test('full mode preference does not change split modes',()=>{
  for (const mode of ['selected','bypass']) {
    const base={...options,mode,applications:[{processName:'test.exe'}]};
    assert.deepEqual(buildConfig({...base,russianSitesViaVpn:true}),buildConfig({...base,russianSitesViaVpn:false}));
  }
});
