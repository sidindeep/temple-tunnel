function buildXrayTls(server) {
  if (server.security === 'reality') {
    return {
      security: 'reality',
      realitySettings: {
        show: false,
        fingerprint: server.fingerprint || 'chrome',
        serverName: server.serverName || server.host,
        publicKey: server.publicKey,
        shortId: server.shortId || '',
        spiderX: server.spiderX || '/'
      }
    };
  }

  if (server.security === 'tls') {
    const tlsSettings = {
      serverName: server.serverName || server.host,
      allowInsecure: Boolean(server.allowInsecure),
      fingerprint: server.fingerprint || 'chrome'
    };
    if (server.alpn?.length) tlsSettings.alpn = server.alpn;
    return { security: 'tls', tlsSettings };
  }

  return { security: 'none' };
}

function buildXrayConfig({ server, socksPort }) {
  if (!server || !['xhttp','tcp'].includes(server.transport)) {
    throw new Error('Xray-конфигурация поддерживает XHTTP и TCP.');
  }
  if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535) {
    throw new Error('Некорректный локальный порт Xray.');
  }

  const xhttpSettings = {
    host: server.hostHeader || '',
    path: server.path || '/',
    mode: server.xhttpMode || 'auto'
  };
  if (server.xhttpExtra) xhttpSettings.extra = server.xhttpExtra;

  const user = {
    id: server.uuid,
    encryption: server.encryption || 'none'
  };
  if (server.flow) user.flow = server.flow;

  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'temple-socks',
      listen: '127.0.0.1',
      port: socksPort,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true }
    }],
    outbounds: [{
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [{
          address: server.host,
          port: server.port,
          users: [user]
        }]
      },
      streamSettings: {
        network: server.transport,
        ...buildXrayTls(server),
        ...(server.transport === 'xhttp' ? {xhttpSettings} : {})
      }
    }]
  };
}

function buildXrayGroup(members) {
  const config = { log: { loglevel: 'warning' }, inbounds: [], outbounds: [], routing: { rules: [] } };
  for (const [index, {server, port}] of members.entries()) {
    const single = buildXrayConfig({server, socksPort:port});
    const inboundTag = `bridge-in-${index}`, outboundTag = `bridge-out-${index}`;
    config.inbounds.push({...single.inbounds[0], tag:inboundTag});
    config.outbounds.push({...single.outbounds[0], tag:outboundTag});
    config.routing.rules.push({type:'field', inboundTag:[inboundTag], outboundTag});
  }
  return config;
}

module.exports = { buildXrayConfig, buildXrayGroup, buildXrayTls };
