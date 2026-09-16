const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../src/singbox');
const { guardArguments,createGuard,guardError } = require('../src/network-guard');
const { normalizeKillSwitch,normalizeIpv6,normalizeDnsPolicy } = require('../src/security-settings');
const base = {server:{host:'192.0.2.1',port:443,uuid:'test',security:'none'},applications:[],mode:'full'};
test('native WFP errors distinguish missing layer from insufficient privileges', () => {
  const layer = guardError({stderr:'WFP error enumeration-open: 2150760452'},'status');
  assert.match(layer.message,/слой WFP/); assert.doesNotMatch(layer.message,/администратора/);
  assert.match(guardError({stderr:'WFP error enumeration-open: 5'},'status').message,/администратора/);
  assert.match(guardError({code:'ENOENT'},'status').message,/не найден/);
});
test('IPv6 is captured and rejected before direct LAN routes when disabled', () => {
  const config = buildConfig({...base,ipv6Policy:'block'});
  assert.ok(config.inbounds[0].address.some(address => address.includes(':')));
  const reject = config.route.rules.findIndex(r => r.ip_version === 6 && r.action === 'reject');
  assert.ok(reject >= 0 && reject < config.route.rules.findIndex(r => r.ip_is_private));
  assert.equal(config.dns.strategy,'ipv4_only');
});
test('IPv6 tunnel mode preserves routing and VPN-only DNS precedes direct rules', () => {
  const config = buildConfig({...base,ipv6Policy:'tunnel',dnsPolicy:'vpn',mode:'bypass',applications:[{name:'Game.exe'}],customRouting:{direct:['example.com']}});
  assert.equal(config.route.rules.some(r => r.ip_version === 6 && r.action === 'reject'),false);
  const catchAll = config.dns.rules.findIndex(r => r.server === 'dns-proxy' && !r.domain_suffix && !r.inbound);
  assert.ok(catchAll >= 0);
  assert.equal(config.dns.rules.slice(0,catchAll).some(r => r.domain_suffix?.includes('example.com')),false);
});
test('firewall requires absolute executable paths and keeps bypass exceptions explicit', () => {
  assert.throws(() => guardArguments({mode:'selected',selectedApplications:[{name:'Browser',path:''}]},[]),/EXE/);
  const state = {mode:'bypass',bypassApplications:[{path:'C:\\Apps\\Game.exe'}]};
  const args = guardArguments(state,['C:\\VPN\\sing-box.exe'],'temple-tun-123');
  assert.deepEqual(args,['apply','bypass','temple-tun-123','--allow','C:\\VPN\\sing-box.exe','--allow','C:\\Apps\\Game.exe']);
  assert.equal(guardArguments({mode:'selected',customRouting:{proxy:['example.com']}},[])[1],'full');
});
test('failed firewall transaction preserves active state and serialized recovery', async () => {
  let fail = false; const calls=[];
  const guard = createGuard('guard', async (_exe,args) => {calls.push(args[0]); if(fail)throw Error(); return {stdout:'active'};});
  await guard.inspect(); assert.equal(guard.active,true);
  fail=true; await assert.rejects(guard.clear()); assert.equal(guard.active,true);
  fail=false; await guard.clear(); assert.equal(guard.active,false);
  assert.deepEqual(calls,['status','clear','clear']);
});
test('unrecognized protection policies are rejected', () => {
  for (const fn of [normalizeKillSwitch,normalizeIpv6,normalizeDnsPolicy]) assert.throws(() => fn('bogus'));
});
