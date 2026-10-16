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
  const rule = config.route.rules.find((item) => item.process_path?.includes('C:\\Apps\\Telegram.exe'));
  assert.deepEqual(rule.process_path, ['C:\\Apps\\Telegram.exe']);
  assert.equal(rule.outbound, 'proxy');
  assert.equal(config.route.rules.find((item) => item.rule_set).outbound, 'direct');
  assert.equal(config.route.rules.find((item) => item.inbound === 'health-in').outbound, 'proxy');
  assert.equal(config.dns.final, 'dns-direct');
  assert.equal(config.dns.rules.find((item) => item.process_path).server, 'dns-proxy');
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
  assert.equal(config.route.rules.find((item) => item.process_path).outbound, 'direct');
  assert.equal(config.dns.final, 'dns-proxy');
  assert.equal(config.dns.rules.find((item) => item.process_path).server, 'dns-direct');
});

test('selected mode routes shared Windows DNS through VPN without widening application traffic', () => {
  const config = buildConfig({ server, mode: 'selected',
    applications: [{ path: 'C:\\Apps\\ChatGPT.exe' }],
    customRouting: { direct: ['example.ru'], block: ['blocked.example'] },
    ruleSetPaths: { geoipRu: 'geoip-ru.srs', geositeRu: 'geosite-category-ru.srs' } });
  function dnsDestination(domain, processName, processPath = '') {
    const rule = config.dns.rules.find(item => {
      if (item.rule_set) return false; // No regional membership for these synthetic domains.
      if (item.domain_suffix && !item.domain_suffix.some(suffix =>
        domain === suffix || domain.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`))) return false;
      if (item.process_name && !item.process_name.includes(processName)) return false;
      if (item.process_path && !item.process_path.includes(processPath)) return false;
      return true;
    });
    return rule?.action === 'reject' ? 'reject' : rule?.server || config.dns.final;
  }
  assert.equal(dnsDestination('public.example', 'svchost.exe'), 'dns-proxy');
  assert.equal(dnsDestination('public.example', 'ChatGPT.exe', 'C:\\Apps\\ChatGPT.exe'), 'dns-proxy');
  assert.equal(dnsDestination('public.example', 'other.exe'), 'dns-direct');
  assert.equal(dnsDestination('api.example.ru', 'svchost.exe'), 'dns-direct');
  assert.equal(dnsDestination('device.lan', 'svchost.exe'), 'dns-direct');
  assert.equal(dnsDestination('blocked.example', 'svchost.exe'), 'reject');
  const sharedIndex = config.dns.rules.findIndex(rule => rule.process_name?.includes('svchost.exe'));
  assert.ok(sharedIndex > config.dns.rules.findIndex(rule => rule.rule_set));
  assert.equal(config.route.final, 'direct');
  assert.equal(config.route.rules.some(rule => rule.process_name?.includes('svchost.exe')), false);
});

test('shared Windows DNS fallback is limited to selected mode with routing DNS policy', () => {
  for (const mode of ['full', 'selected', 'bypass']) {
    for (const dnsPolicy of ['routing', 'vpn']) {
      const config = buildConfig({ server, mode, dnsPolicy, applications: [{ processName: 'test.exe' }] });
      assert.equal(config.dns.rules.some(rule => rule.process_name?.includes('svchost.exe')),
        mode === 'selected' && dnsPolicy === 'routing');
      if (dnsPolicy === 'vpn') assert.ok(config.dns.rules.some(rule =>
        rule.server === 'dns-proxy' && !rule.process_name && !rule.process_path));
    }
  }
});

test('system-disabled IPv6 omits IPv6 addressing while retaining strict routing and IPv4 DNS', () => {
  for (const ipv6Policy of ['block', 'tunnel']) {
    const config = buildConfig({ server, mode: 'full', applications: [], systemIPv6Disabled: true, ipv6Policy });
    assert.deepEqual(config.inbounds[0].address, ['172.31.254.1/30']);
    assert.equal(config.inbounds[0].strict_route, true);
    assert.equal(config.inbounds[0].auto_route, true);
    assert.equal(config.dns.strategy, 'ipv4_only');
    assert.equal(config.route.final, 'proxy');
  }
  const normal = buildConfig({ server, mode: 'full', applications: [], ipv6Policy: 'block' });
  assert.equal(normal.inbounds[0].address.length, 2);
  assert.ok(normal.route.rules.some(rule => rule.inbound === 'tun-in' && rule.ip_version === 6 && rule.action === 'reject'));
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

test('all modes route captured upstream DNS directly while preserving domain and application policies', () => {
  for (const mode of ['full', 'selected', 'bypass']) {
    const config = buildConfig({ server, mode, applications: [{ processName: 'Telegram.exe' }],
      directDns: '192.0.2.53', customRouting: { direct: ['dzen.ru'] }, healthPort: 23456 });
    assert.deepEqual(config.dns.servers.find(item => item.tag === 'dns-direct'),
      { type: 'udp', tag: 'dns-direct', server: '192.0.2.53', server_port: 53 });
    assert.equal(config.dns.rules.find(rule => rule.domain_suffix?.includes('dzen.ru')).server, 'dns-direct');
    assert.equal(config.dns.rules.find(rule => rule.inbound === 'dns-health-in').server, 'dns-proxy');
    assert.equal(config.inbounds[0].strict_route, mode === 'full');
  }
});

test('application rules use exact paths and keep name-only fallback separate', () => {
  const config = buildConfig({
    server,
    mode: 'selected',
    applications: [
      { processName: 'Telegram.exe' },
      { processName: 'telegram.EXE', path: 'C:\\Apps\\telegram.EXE' },
      { processName: 'telegram.exe', path: 'C:\\Other\\telegram.exe' },
      { processName: 'TELEGRAM.EXE' }
    ]
  });
  const nameRule = config.route.rules.find((item) => item.outbound === 'proxy' && item.process_name);
  const pathRule = config.route.rules.find((item) => item.outbound === 'proxy' && item.process_path);
  assert.deepEqual(nameRule.process_name, ['Telegram.exe']);
  assert.deepEqual(pathRule.process_path, ['C:\\Apps\\telegram.EXE', 'C:\\Other\\telegram.exe']);
});

test('excluded VPN sockets keep native DNS and IPv6 before generic interception', () => {
  const excluded = 'C:\\VPN\\kvpncsvc.exe';
  const config = buildConfig({ server, mode: 'bypass', applications: [{ path: excluded }],
    customRouting: { proxy: ['vpn.example'] }, healthPort: 23456, tunAddress: '10.254.254.1/30' });
  const rules = config.route.rules;
  const exception = rules.findIndex(rule => rule.process_path?.includes(excluded));
  const peer = rules.findIndex(rule => rule.ip_cidr?.includes('10.254.254.2/32') && rule.port === 53);
  assert.ok(peer < exception);
  assert.ok(exception < rules.findIndex(rule => rule.action === 'sniff'));
  assert.ok(exception < rules.findIndex(rule => rule.ip_version === 6 && rule.action === 'reject'));
  assert.ok(exception < rules.findIndex(rule => rule.protocol === 'dns'));
  assert.ok(exception < rules.findIndex(rule => rule.domain_suffix?.includes('vpn.example')));
  assert.equal(rules[exception].inbound, 'tun-in');
  assert.equal(rules[exception].outbound, 'direct');
  assert.equal(config.inbounds[0].strict_route, false);
  assert.equal(rules.find(rule => rule.inbound === 'health-in').outbound, 'proxy');
});

test('split routing releases global DNS filters only when IPv6 is captured or fully disabled', () => {
  for (const mode of ['selected', 'bypass']) {
    const options = { server, mode, applications: [{ processName: 'example.exe' }] };
    assert.equal(buildConfig(options).inbounds[0].strict_route, false);
    for (const components of [0x11, 0xff, 0xffffffff]) {
      const config = buildConfig({ ...options, systemIPv6Disabled: true, systemIPv6Components: components });
      assert.equal(config.inbounds[0].strict_route, false);
      assert.equal(config.inbounds[0].address.length, 1);
    }
    for (const components of [undefined, 0x10]) {
      assert.equal(buildConfig({ ...options, systemIPv6Disabled: true, systemIPv6Components: components }).inbounds[0].strict_route, true);
    }
  }
});

test('physical upstream pins remote VPN and direct DNS without binding the local bridge', () => {
  const options = { server, mode: 'bypass', applications: [], upstreamInterface: 'Ethernet', directDns: '192.0.2.53' };
  const config = buildConfig(options);
  assert.ok(config.outbounds.every(outbound => outbound.bind_interface === 'Ethernet'));
  assert.equal(config.dns.servers.find(item => item.tag === 'dns-direct').bind_interface, 'Ethernet');
  const bridge = buildConfig({ ...options, bridgePort: 23456 });
  assert.equal(bridge.outbounds[0].bind_interface, undefined);
  const hysteria = buildConfig({ ...options, server: { ...server, protocol: 'hysteria2', password: 'test' } });
  assert.equal(hysteria.outbounds[0].bind_interface, 'Ethernet');
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
    for (const [index, variant] of [...variants, ...variants].entries()) {
      const configPath = path.join(directory, `config-${index}.json`);
      fs.writeFileSync(configPath, JSON.stringify(buildConfig({
        server: variant,
        mode: 'selected',
        applications: [{ path: 'C:\\Apps\\Telegram.exe' }],
        healthPort: 23456 + index,
        directDns: '192.0.2.53', upstreamInterface: 'Ethernet',
        systemIPv6Disabled: index >= variants.length,
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
