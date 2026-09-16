const crypto = require('node:crypto');
const http = require('node:http');
const { buildOutbound } = require('./singbox');

function poolKey(state, servers) {
  return crypto.createHash('sha256').update(JSON.stringify([
    state.activeSubscriptionId, state.mode, state.selectedApplications,
    state.bypassApplications, state.russianSitesViaVpn, state.customRouting, state.dnsPreset, state.ipv6Policy, state.dnsPolicy, state.killSwitch, servers
  ])).digest('hex');
}

// XHTTP members use distinct SOCKS listeners inside one shared Xray process.
function preparePool(config, active, candidates, port, bridgePorts = new Map(), probePorts = new Map()) {
  if (active.transport === 'xhttp' && !bridgePorts.has(active.id)) return null;
  const members = new Map();
  const outbounds = [];
  for (const server of [active, ...candidates]) {
    if (members.size >= 5) break;
    if (members.has(server.id) || (server.transport === 'xhttp' && !bridgePorts.has(server.id))) continue;
    if (active.connectionEngine === 'xray' && server.transport === 'tcp'
      && server.security === 'reality' && !bridgePorts.has(server.id)) continue;
    try {
      const tag = `node-${crypto.createHash('sha256').update(server.id).digest('hex').slice(0, 24)}`;
      outbounds.push({ ...buildOutbound(server, bridgePorts.get(server.id) || 0), tag });
      members.set(server.id, tag);
    } catch { /* An invalid reserve must not prevent the working server starting. */ }
  }
  if (members.size < 2) return null;
  const secret = crypto.randomBytes(32).toString('hex');
  config.outbounds = [
    { type: 'selector', tag: 'proxy', outbounds: [...members.values()],
      default: members.get(active.id), interrupt_exist_connections: true },
    ...outbounds, { type: 'direct', tag: 'direct' }
  ];
  config.experimental = { clash_api: { external_controller: `127.0.0.1:${port}`, secret } };
  const checks = new Map();
  for (const [id, listenPort] of probePorts) {
    if (!members.has(id)) continue;
    const tag = `check-${members.get(id)}`;
    config.inbounds.push({type:'mixed', tag, listen:'127.0.0.1', listen_port:listenPort});
    config.route.rules.unshift({inbound:tag, action:'route', outbound:members.get(id)});
    checks.set(id,listenPort);
  }
  return { port, secret, members, bridgeIds:new Set(bridgePorts.keys()), probePorts:checks,
    activeId: active.id, checks:new Map(), activeConfirmedAt:Date.now() };
}

function selectOutbound(pool, id, signal) {
  const name = pool.members.get(id);
  if (!name) return Promise.reject(new Error('Server is not prepared'));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: pool.port,
      path: '/proxies/proxy', method: 'PUT', signal,
      headers: { Authorization: `Bearer ${pool.secret}`, 'Content-Type': 'application/json' }
    }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 204 ? resolve()
        : reject(new Error('Core rejected server switch')));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('Core switch timed out')), 2000);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end(JSON.stringify({ name }));
  });
}

module.exports = { poolKey, preparePool, selectOutbound };
