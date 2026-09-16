const test = require('node:test');
const assert = require('node:assert/strict');
const {parseSubscription, downloadSubscription} = require('../src/subscription');
const {buildOutbound} = require('../src/singbox');
const {measureEndpointLatency} = require('../src/latency');
const uri = 'hysteria2://test%3Asecret@example.com:2096?sni=cdn.example.com#Example';
test('Base64 Hysteria 2 subscription preserves authentication and TLS', () => {
  const [server] = parseSubscription(Buffer.from(uri).toString('base64'));
  const config = buildOutbound(server);
  assert.equal(config.type, 'hysteria2');
  assert.equal(config.password, 'test:secret');
  assert.equal(config.server_port, 2096);
  assert.equal(config.tls.server_name, 'cdn.example.com');
  assert.equal(config.tls.insecure, false);
  assert.equal(config.tls.utls, undefined);
});
test('direct hy2 alias supports salamander without fetching', async () => {
  const [s] = await downloadSubscription('hy2://secret@example.com?obfs=salamander&obfs-password=mask', () => {throw Error('network');});
  assert.deepEqual(buildOutbound(s).obfs, {type:'salamander', password:'mask'});
});
test('mixed subscription retains both protocols', () => {
  assert.equal(parseSubscription(uri+'\nvless://test@example.com:443?security=none').length, 2);
});
test('UDP Hysteria server is not declared unavailable by a TCP probe', async () => {
  const [server] = parseSubscription(uri);
  assert.equal((await measureEndpointLatency(server)).status, 'unmeasured');
});
