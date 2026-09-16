const path = require('node:path');
const { customRules, proxyDns } = require('./routing-settings');

function buildTls(server) {
  if (server.security === 'none') return undefined;

  const tls = {
    enabled: true,
    server_name: server.serverName,
    insecure: Boolean(server.allowInsecure)
  };

  if (server.fingerprint) {
    tls.utls = { enabled: true, fingerprint: server.fingerprint };
  }
  if (server.security === 'reality') {
    if (!server.publicKey) throw new Error('В REALITY-профиле отсутствует публичный ключ.');
    tls.reality = {
      enabled: true,
      public_key: server.publicKey,
      short_id: server.shortId || ''
    };
  }
  return tls;
}

function buildTransport(server) {
  if (!server.transport || server.transport === 'tcp') return undefined;
  if (server.transport === 'grpc') {
    const transport = { type: 'grpc', service_name: server.serviceName || '' };
    if (server.authority) transport.idle_timeout = '15s';
    return transport;
  }
  if (server.transport === 'ws' || server.transport === 'websocket') {
    const transport = { type: 'ws', path: server.path || '/' };
    if (server.hostHeader) transport.headers = { Host: server.hostHeader };
    return transport;
  }
  if (server.transport === 'httpupgrade') {
    const transport = { type: 'httpupgrade', path: server.path || '/' };
    if (server.hostHeader) transport.host = server.hostHeader;
    return transport;
  }
  if (server.transport === 'http' || server.transport === 'h2') {
    const transport = { type: 'http', path: server.path || '/' };
    if (server.hostHeader) transport.host = [server.hostHeader];
    return transport;
  }
  throw new Error(`Транспорт ${server.transport} пока не поддерживается.`);
}

function buildOutbound(server, bridgePort = 0) {
  if (server.protocol === 'hysteria2') {
    return { type: 'hysteria2', tag: 'proxy', server: server.host, server_port: server.port,
      password: server.password,
      tls: {enabled: true, server_name: server.serverName, insecure: Boolean(server.allowInsecure)},
      ...(server.obfs ? {obfs: server.obfs} : {})
    };
  }
  if (bridgePort) {
    return {
      type: 'socks',
      tag: 'proxy',
      server: '127.0.0.1',
      server_port: bridgePort,
      version: '5'
    };
  }
  const outbound = {
    type: 'vless',
    tag: 'proxy',
    server: server.host,
    server_port: server.port,
    uuid: server.uuid,
    packet_encoding: server.packetEncoding || 'xudp'
  };
  if (server.flow) outbound.flow = server.flow;
  const tls = buildTls(server);
  if (tls) outbound.tls = tls;
  const transport = buildTransport(server);
  if (transport) outbound.transport = transport;
  return outbound;
}

function buildRuleSets(ruleSetPaths) {
  if (!ruleSetPaths) return [];
  return [
    { type: 'local', tag: 'geoip-ru', format: 'binary', path: ruleSetPaths.geoipRu },
    { type: 'local', tag: 'geosite-category-ru', format: 'binary', path: ruleSetPaths.geositeRu }
  ];
}

function buildDns({ mode, processNames, useRussianBypass, customRouting, dnsPreset, healthPort = 0, ipv6Policy = 'block', dnsPolicy = 'routing', directDns }) {
  const rules = [
    {
      domain_suffix: ['.local', '.localhost', '.lan'],
      action: 'route',
      server: 'dns-direct'
    }
  ];
  if (healthPort) rules.unshift({ inbound: 'dns-health-in', action: 'route', server: 'dns-proxy', disable_cache: true });

  rules.push(...customRules(customRouting, true).filter(rule => dnsPolicy !== 'vpn' || rule.action === 'reject'));
  if (dnsPolicy === 'vpn') rules.push({ action: 'route', server: 'dns-proxy' });
  if (useRussianBypass) {
    rules.push({ rule_set: 'geosite-category-ru', action: 'route', server: 'dns-direct' });
  }
  if (mode === 'selected') {
    rules.push({ process_name: processNames, action: 'route', server: 'dns-proxy' });
  } else if (mode === 'bypass' && processNames.length) {
    rules.push({ process_name: processNames, action: 'route', server: 'dns-direct' });
  }

  return {
    servers: [
      directDns ? { type: 'udp', tag: 'dns-direct', server: directDns, server_port: 53, detour: 'direct' } : { type: 'local', tag: 'dns-direct' },
      proxyDns(dnsPreset)
    ],
    rules,
    final: mode === 'full' || mode === 'bypass' ? 'dns-proxy' : 'dns-direct',
    strategy: ipv6Policy === 'block' ? 'ipv4_only' : 'prefer_ipv4'
  };
}

function buildConfig({ server, applications, mode, russianSitesViaVpn = true, healthPort = 0, bridgePort = 0, tunAddress = '172.31.254.1/30', tunName = 'temple-tun', ruleSetPaths, customRouting, dnsPreset, ipv6Policy = 'block', dnsPolicy = 'routing', directDns }) {
  if (!server) throw new Error('Сначала выберите сервер.');
  const processNames = [];
  const knownProcesses = new Set();
  for (const application of applications) {
    const processName = application.processName || path.basename(application.path || application.name);
    const identity = String(processName || '').toLowerCase();
    if (identity && !knownProcesses.has(identity)) {
      knownProcesses.add(identity);
      processNames.push(processName);
    }
  }
  if (mode === 'selected' && processNames.length === 0) {
    throw new Error('Для раздельного туннелирования добавьте хотя бы одно приложение.');
  }

  const ruleSets = buildRuleSets(ruleSetPaths);
  const useRussianBypass = (mode !== 'full' || russianSitesViaVpn === false) && ruleSets.length === 2;

  const rules = [];
  if (healthPort) {
    rules.push({ inbound: 'dns-health-in', action: 'hijack-dns' });
    rules.push({ inbound: 'health-in', action: 'route', outbound: 'proxy' });
  }
  // Capture both families even when IPv6 is disabled: never leave IPv6 outside TUN.
  if (ipv6Policy === 'block') rules.push({ inbound: 'tun-in', ip_version: 6, action: 'reject' });
  rules.push(
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { ip_is_private: true, action: 'route', outbound: 'direct' },
    { process_name: ['xray.exe', 'Temple Tunnel.exe'], action: 'route', outbound: 'direct' }
  );
  rules.push(...customRules(customRouting));

  if (useRussianBypass) {
    rules.push({
      rule_set: ['geoip-ru', 'geosite-category-ru'],
      action: 'route',
      outbound: 'direct'
    });
  }

  if (mode === 'selected') {
    rules.push({ process_name: processNames, action: 'route', outbound: 'proxy' });
  } else if (mode === 'bypass' && processNames.length) {
    rules.push({ process_name: processNames, action: 'route', outbound: 'direct' });
  }

  return {
    $schema: 'https://sing-box.sagernet.org/schema.json',
    log: { level: 'info', timestamp: true },
    // UDP DNS over the Xray SOCKS bridge can stall while TCP traffic already works.
    // Keep the same resolver, but use HTTPS unless the user chose another provider.
    dns: buildDns({ mode, processNames, useRussianBypass, customRouting,
      dnsPreset: bridgePort && (!dnsPreset || dnsPreset === 'legacy') ? 'cloudflare' : dnsPreset, healthPort, ipv6Policy, dnsPolicy, directDns }),
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: tunName,
        address: [tunAddress, 'fd7a:7465:6d70::1/126'],
        mtu: 1500,
        auto_route: true,
        strict_route: true,
        stack: 'mixed'
      },
      ...(healthPort ? [{
        type: 'direct', tag: 'dns-health-in', listen: '127.0.0.1',
        listen_port: healthPort, network: 'udp'
      }, {
        type: 'mixed',
        tag: 'health-in',
        listen: '127.0.0.1',
        listen_port: healthPort
      }] : [])
    ],
    outbounds: [buildOutbound(server, bridgePort), { type: 'direct', tag: 'direct' }],
    route: {
      rules,
      rule_set: ruleSets,
      final: mode === 'full' || mode === 'bypass' ? 'proxy' : 'direct',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct'
    }
  };
}

module.exports = { buildConfig, buildDns, buildOutbound, buildRuleSets, buildTls, buildTransport };
