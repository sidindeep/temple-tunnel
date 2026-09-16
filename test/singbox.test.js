const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildConfig } = require('../src/singbox');

const server = {
  host: 'example.com', port: 443, uuid: '11111111-1111-4111-8111-111111111111',
  flow: 'xtls-rprx-vision', security: 'reality', transport: 'tcp', serverName: 'example.org',
  fingerprint: 'chrome', publicKey: 'YqHW8a4iAc1SZYpTrFVoOQg1F3yAdX1tWXuROZUCsEU', shortId: 'abcd', packetEncoding: 'xudp'
};

test('selected mode sends only listed processes to proxy', () => {
  const config = buildConfig({
    server,
    mode: 'selected',
    applications: [{ path: 'C:\\Apps\\Telegram.exe' }],
    healthPort: 23456,
    ruleSetPaths: { geoipRu: 'geoip-ru.srs', geositeRu: 'geosite-category-ru.srs' }
  });
  assert.equal(config.route.final, 'direct');
  const rule = config.route.rules.find((item) => item.process_name?.includes('Telegram.exe'));
  assert.deepEqual(rule.process_name, ['Telegram.exe']);
  assert.equal(rule.outbound, 'proxy');
  assert.equal(config.route.rules.find((item) => item.rule_set).outbound, 'direct');
  assert.equal(config.route.rules.find((item) => item.inbound === 'health-in').outbound, 'proxy');
  assert.equal(config.dns.final, 'dns-direct');
  assert.equal(config.dns.rules.find((item) => item.process_name).server, 'dns-proxy');
  assert.equal(config.dns.rules.find((item) => item.rule_set).server, 'dns-direct');
});

test('bypass mode sends listed processes direct and defaults to proxy', () => {
  const config = buildConfig({
    server,
    mode: 'bypass',
    applications: [{ path: 'C:\\Apps\\Game.exe' }],
    ruleSetPaths: { geoipRu: 'geoip-ru.srs', geositeRu: 'geosite-category-ru.srs' }
  });
  assert.equal(config.route.final, 'proxy');
  assert.equal(config.route.rules.find((item) => item.process_name).outbound, 'direct');
  assert.equal(config.dns.final, 'dns-proxy');
  assert.equal(config.dns.rules.find((item) => item.process_name).server, 'dns-direct');
});

test('full mode sends all public traffic and DNS through proxy', () => {
  const config = buildConfig({
    server,
    mode: 'full',
    applications: [],
    ruleSetPaths: { geoipRu: 'geoip-ru.srs', geositeRu: 'geosite-category-ru.srs' }
  });
  assert.equal(config.route.final, 'proxy');
  assert.equal(config.dns.final, 'dns-proxy');
  assert.equal(config.route.rules.some((item) => item.rule_set), false);
  assert.equal(config.dns.rules.some((item) => item.rule_set), false);
});

test('selected mode requires at least one application', () => {
  assert.throws(() => buildConfig({ server, mode: 'selected', applications: [] }), /добавьте/i);
});

test('application process rules are deduplicated case-insensitively', () => {
  const config = buildConfig({
    server,
    mode: 'selected',
    applications: [
      { processName: 'Telegram.exe' },
      { processName: 'telegram.EXE', path: 'C:\\Apps\\telegram.EXE' }
    ]
  });
  const rule = config.route.rules.find((item) => item.outbound === 'proxy' && item.process_name);
  assert.deepEqual(rule.process_name, ['Telegram.exe']);
});

test('bypass mode allows an empty exclusion list', () => {
  const config = buildConfig({ server, mode: 'bypass', applications: [] });
  assert.equal(config.route.final, 'proxy');
  assert.equal(config.route.rules.some((item) => Array.isArray(item.process_name) && item.process_name.length === 0), false);
  assert.equal(config.dns.rules.some((item) => Array.isArray(item.process_name) && item.process_name.length === 0), false);
});

test('all supported sing-box transport configs pass bundled validation', { skip: process.platform !== 'win32' }, () => {
  const executable = path.join(__dirname, '..', 'vendor', 'sing-box', 'sing-box.exe');
  if (!fs.existsSync(executable)) return;
  const ruleSetPaths = {
    geoipRu: path.join(__dirname, '..', 'vendor', 'sing-box', 'rules', 'geoip-ru.srs'),
    geositeRu: path.join(__dirname, '..', 'vendor', 'sing-box', 'rules', 'geosite-category-ru.srs')
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'temple-tunnel-'));
  try {
    const variants = [
      server,
      { ...server, transport: 'grpc', serviceName: 'temple-grpc', flow: '' },
      { ...server, transport: 'ws', path: '/websocket', hostHeader: 'cdn.example.org', flow: '' },
      { ...server, transport: 'httpupgrade', path: '/upgrade', hostHeader: 'cdn.example.org', flow: '' },
      { ...server, transport: 'http', path: '/http', hostHeader: 'cdn.example.org', flow: '' }
    ];
    for (const [index, variant] of variants.entries()) {
      const configPath = path.join(directory, `config-${index}.json`);
      fs.writeFileSync(configPath, JSON.stringify(buildConfig({
        server: variant,
        mode: 'selected',
        applications: [{ path: 'C:\\Apps\\Telegram.exe' }],
        healthPort: 23456 + index,
        ruleSetPaths
      })));
      const result = spawnSync(executable, ['check', '-c', configPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bridged XHTTP config uses the local Xray SOCKS proxy', () => {
  const config = buildConfig({
    server: { ...server, transport: 'xhttp', flow: '' },
    mode: 'full',
    applications: [],
    bridgePort: 19080,
    tunAddress: '172.31.253.1/30'
  });
  assert.deepEqual(config.outbounds[0], {
    type: 'socks', tag: 'proxy', server: '127.0.0.1', server_port: 19080, version: '5'
  });
  const xrayRule = config.route.rules.find((item) => item.process_name?.includes('xray.exe'));
  assert.equal(xrayRule.outbound, 'direct');
  assert.deepEqual(config.inbounds[0].address, ['172.31.253.1/30', 'fd7a:7465:6d70::1/126']);
});
