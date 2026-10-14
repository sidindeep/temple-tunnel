const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { buildConfig } = require('../src/singbox');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startCore(file) {
  const child = spawn(path.join(__dirname, '../vendor/sing-box/sing-box.exe'), ['run', '-c', file],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => reject(new Error('Loopback core did not start within 5 seconds')), 5000);
    const read = chunk => {
      output += chunk.toString();
      if (!started && output.includes('sing-box started')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      if (!started) reject(new Error(`Loopback core stopped before readiness: ${output}`));
    });
  });
  return { child, ready, closed, output: () => output };
}

async function stopCore(core) {
  if (core.child.exitCode === null) core.child.kill();
  const timer = setTimeout(() => core.child.kill('SIGKILL'), 3000);
  try { await core.closed; }
  finally { clearTimeout(timer); }
}

function exchange(proxyPort, destinationPort, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let header = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let accepted = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Loopback proxy did not complete or reject within 3 seconds')), 3000);
    const finish = (error, echoed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve({ accepted, echoed, body: body.toString() });
    };
    socket.once('connect', () => socket.write(
      `CONNECT 127.0.0.1:${destinationPort} HTTP/1.1\r\nHost: 127.0.0.1:${destinationPort}\r\n\r\n`));
    socket.on('data', chunk => {
      if (!accepted) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.[01] 200\b/.test(header.toString('latin1', 0, end))) return finish();
        accepted = true;
        body = header.subarray(end + 4);
        socket.write(payload);
      } else body = Buffer.concat([body, chunk]);
      if (body.toString() === payload) finish(undefined, true);
    });
    socket.once('error', error => {
      if (error.code === 'ECONNRESET') finish();
      else finish(error);
    });
    socket.once('close', () => finish());
  });
}

test('real core routes an excluded exact EXE before sniff/reject and rejects the same filename at another path',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const diagnostics = path.join(__dirname, '../diagnostics');
    await fs.mkdir(diagnostics, { recursive: true });
    const directory = await fs.mkdtemp(path.join(diagnostics, 'excluded-traffic-'));
    const sockets = new Set();
    let acceptedConnections = 0;
    const echo = net.createServer(socket => {
      acceptedConnections++;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.on('data', chunk => socket.write(chunk));
    });
    const cores = [];
    try {
      const destinationPort = await listen(echo);
      for (const [name, executable, shouldEcho] of [
        ['exact path', process.execPath, true],
        ['wrong path with same filename', path.join(directory, 'other-install', path.basename(process.execPath)), false]
      ]) {
        const proxyPort = await freePort();
        const config = buildConfig({
          server: { host: '127.0.0.1', port: destinationPort, uuid: '11111111-1111-4111-8111-111111111111', security: 'none' },
          mode: 'bypass', applications: [{ processName: path.basename(process.execPath), path: executable }],
          directDns: '127.0.0.1'
        });
        // Keep the generated rule and its inbound tag. Replace only the system
        // adapter with a local listener; no TUN, routes or personal profiles.
        config.inbounds = [{ type: 'mixed', tag: 'tun-in', listen: '127.0.0.1', listen_port: proxyPort }];
        config.log.level = 'debug';
        const bypass = config.route.rules.findIndex(rule => rule.process_path?.includes(executable)
          && rule.inbound === 'tun-in' && rule.outbound === 'direct');
        assert.ok(bypass >= 0, 'Generated exact-process bypass rule must exist');
        assert.ok(bypass < config.route.rules.findIndex(rule => rule.action === 'sniff'), 'Bypass must precede sniff');
        config.route.rules.splice(bypass + 1, 0, { inbound: 'tun-in', action: 'reject' });
        const file = path.join(directory, `${shouldEcho ? 'match' : 'mismatch'}.json`);
        await fs.writeFile(file, JSON.stringify(config), 'utf8');
        const core = startCore(file);
        cores.push(core);
        await core.ready;
        const connectionsBefore = acceptedConnections;
        const payload = 'Temple Tunnel exact-process exclusion';
        const result = await exchange(proxyPort, destinationPort, payload);
        await stopCore(core);
        t.diagnostic(`${name}: ${result.echoed ? 'direct echo received' : 'connection rejected'}; ${core.output()}`);
        assert.equal(result.echoed, shouldEcho, `${name}: real process-path routing result`);
        assert.equal(acceptedConnections - connectionsBefore, shouldEcho ? 1 : 0,
          `${name}: only the exact excluded executable may reach the local destination`);
        if (shouldEcho) assert.equal(result.body, payload);
        else assert.match(core.output(), /reject/i, 'Wrong exact path must reach the terminating reject');
      }
    } finally {
      await Promise.all(cores.map(stopCore));
      for (const socket of sockets) socket.destroy();
      if (echo.listening) await new Promise(resolve => echo.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
