const net = require('node:net');
const tls = require('node:tls');

function measureTcpLatency({ host, port }, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.createConnection({ host, port, lookup: require('./bootstrap-dns').socketLookup });
    let settled = false;

    const finish = (status, ms = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, ms });
    };

    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('error', () => finish('error'));
    socket.once('connect', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      finish('ok', Math.max(1, Math.round(elapsed)));
    });
  });
}

function measureEndpointLatency(server, timeoutMs = 5000) {
  if (server.protocol === 'hysteria2') return Promise.resolve({status: 'unmeasured', ms: null, kind: 'endpoint'});
  if (!server.security || server.security === 'none') {
    return measureTcpLatency(server, timeoutMs).then((result) => ({ ...result, kind: 'endpoint' }));
  }

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const requestedName = server.serverName || server.host;
    const socket = tls.connect({
      host: server.host,
      port: server.port,
      lookup: require('./bootstrap-dns').socketLookup,
      servername: net.isIP(requestedName) ? undefined : requestedName,
      rejectUnauthorized: false
    });
    let settled = false;

    const finish = (status, ms = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, ms, kind: 'endpoint' });
    };

    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('error', () => finish('error'));
    socket.once('secureConnect', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      finish('ok', Math.max(1, Math.round(elapsed)));
    });
  });
}

function measureTunnelLatency(proxyPort, timeoutMs = 7000, target = { host: '1.1.1.1', servername: 'cloudflare-dns.com' }, signal) {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled', ms: null, kind: 'tunnel' });
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    let tlsSocket;
    let response = Buffer.alloc(0);
    let settled = false;

    const deadline = setTimeout(() => finish('timeout'), timeoutMs);

    const finish = (status, ms = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      if (tlsSocket) tlsSocket.destroy(); else socket.destroy();
      resolve({ status, ms, kind: 'tunnel' });
    };
    const onAbort = () => finish('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('error', () => finish('error'));
    socket.once('close', () => finish('error'));
    socket.once('connect', () => {
      socket.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\n\r\n`);
    });
    socket.on('data', function readConnectResponse(chunk) {
      response = Buffer.concat([response, chunk]);
      if (response.length > 16384) return finish('error');
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      socket.removeListener('data', readConnectResponse);
      if (!/^HTTP\/1\.[01] 200\b/.test(response.toString('latin1', 0, headerEnd))) {
        finish('error');
        return;
      }

      const buffered = response.subarray(headerEnd + 4);
      tlsSocket = tls.connect({
        socket,
        servername: target.servername,
        rejectUnauthorized: true
      });
      if (buffered.length) tlsSocket.unshift(buffered);
      tlsSocket.setTimeout(timeoutMs, () => finish('timeout'));
      tlsSocket.once('error', () => finish('error'));
      tlsSocket.once('secureConnect', () => {
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        finish('ok', Math.max(1, Math.round(elapsed)));
      });
    });
  });
}

async function checkTunnelConnectivity(port, timeoutMs = 3000, probe = measureTunnelLatency, signal) {
  if (signal?.aborted) return { status: 'cancelled', ms: null, kind: 'tunnel' };
  const targets = [
    {host: '1.1.1.1', servername: 'cloudflare-dns.com'},
    {host: 'www.google.com', servername: 'www.google.com'},
    {host: 'www.microsoft.com', servername: 'www.microsoft.com'}
  ];
  const controller = new AbortController();
  const results = new Array(targets.length);
  let remaining = targets.length;
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      controller.abort();
      resolve(result);
    };
    const cancel = () => finish({ status: 'cancelled', ms: null, kind: 'tunnel' });
    signal?.addEventListener('abort', cancel, { once: true });
    targets.forEach((target, index) => {
      Promise.resolve().then(() => probe(port, timeoutMs, target, controller.signal))
        .catch(() => ({ status: 'error', ms: null, kind: 'tunnel' }))
        .then(result => {
          if (finished) return;
          results[index] = result;
          remaining--;
          if (result.status === 'ok' || remaining === 0) {
            finish(result.status === 'ok' ? result : results[0]);
          }
        });
    });
  });
}

async function checkTunnelReadiness(port, timeoutMs = 3000, signal) {
  const [tlsResult, dnsResult] = await Promise.all([
    checkTunnelConnectivity(port, timeoutMs, undefined, signal),
    require('./dns-health').checkDns(port, timeoutMs, signal)
  ]);
  return tlsResult.status !== 'ok' ? tlsResult : dnsResult.status !== 'ok' ? dnsResult : tlsResult;
}

module.exports = { measureTcpLatency, measureEndpointLatency, measureTunnelLatency, checkTunnelConnectivity, checkTunnelReadiness };
