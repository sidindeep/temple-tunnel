const { lookup: encryptedLookup } = require('./bootstrap-dns');
const net = require('node:net');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { buildConfig } = require('./singbox');
const { buildXrayConfig } = require('./xray');
const { checkTunnelConnectivity } = require('./latency');
const { connectionError, classifyConnectionError } = require('./connection-errors');

function assertActive(signal) {
  if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
}

async function resolveServer(server, lookup = encryptedLookup, timeoutMs = 5000, signal) {
  assertActive(signal);
  if (net.isIP(server.host)) return server;
  let timer, cancel;
  try {
    const result = await Promise.race([
      lookup(server.host, { family: 4 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(connectionError('DNS_FAILED', 'DNS: истекло время определения адреса сервера.')), timeoutMs);
        cancel = () => reject(connectionError('ABORT_ERR', 'Подключение отменено.'));
        signal?.addEventListener('abort', cancel, { once: true });
      })
    ]);
    return { ...server, host: result.address, serverName: server.serverName || server.host };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function portReady(port, signal) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const done = value => { signal.removeEventListener('abort', cancel); socket.destroy(); resolve(value); };
    const cancel = () => done(false);
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(200, () => done(false));
    if (signal.aborted) cancel();
  });
}

async function probeServerOnce(server, executable, xrayExecutable, { signal, timeoutMs = 8000, onStage = () => {},
  spawnProcess = spawn } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const startedAt = Date.now();
  const stage = name => onStage(name, Date.now() - startedAt);
  const processes = [];
  let directory, coreError;
  function start(exe, args) {
    assertActive(controller.signal);
    const child = spawnProcess(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, done: false };
    entry.exited = new Promise(resolve => {
      const finish = () => { entry.done = true; resolve(); };
      child.once('exit', finish);
      child.once('error', error => { coreError = error; finish(); abort(); });
    });
    const read = chunk => {
      const message = chunk.toString();
      if (/REALITY verification failed/i.test(message)) {
        coreError = connectionError('REALITY_FAILED', 'Проверка REALITY не пройдена.');
        abort();
      } else if (/authentication failed|invalid user|invalid password/i.test(message)) {
        coreError = connectionError('AUTH_FAILED', 'Сервер отклонил ключ.');
        abort();
      } else if (/FATAL|failed to initialize|failed to create|unknown field|decode config/i.test(message)) {
        coreError = connectionError(/access is denied|permission|wintun/i.test(message) ? 'ENGINE_FAILED' : 'PROFILE_INVALID', 'VPN-движок отклонил конфигурацию.');
        abort();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    processes.push(entry);
    return entry;
  }
  async function waitReady(entry, port) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      assertActive(controller.signal);
      if (entry.done) throw coreError || connectionError('PROFILE_INVALID', 'VPN-движок завершился до проверки.');
      if (await portReady(port, controller.signal)) return;
      await delay(75, undefined, { signal: controller.signal });
    }
    throw connectionError('ENGINE_FAILED', 'Локальный прокси не запустился.');
  }
  const kill = () => { for (const entry of processes) if (!entry.done) { try { entry.child.kill('SIGKILL'); } catch {} } };
  controller.signal.addEventListener('abort', kill, { once: true });
  try {
    const resolved = await resolveServer(server, encryptedLookup, Math.min(3000, timeoutMs), controller.signal);
    stage('dns');
    assertActive(controller.signal);
    const port = await allocatePort();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'temple-probe-'));
    assertActive(controller.signal);
    let bridgePort = 0, bridge;
    if (server.transport === 'xhttp' || server.connectionEngine === 'xray') {
      bridgePort = await allocatePort();
      const bridgeFile = path.join(directory, 'xray.json');
      await fs.writeFile(bridgeFile, JSON.stringify(buildXrayConfig({ server: resolved, socksPort: bridgePort })), { mode: 0o600 });
      bridge = start(xrayExecutable, ['run', '-c', bridgeFile]);
    }
    const config = buildConfig({ server: resolved, applications: [], mode: 'full', healthPort: port, bridgePort });
    config.inbounds = config.inbounds.filter(item => item.tag === 'health-in');
    const file = path.join(directory, 'config.json');
    await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const child = start(executable, ['run', '-c', file]);
    await Promise.all([waitReady(child, port), ...(bridge ? [waitReady(bridge, bridgePort)] : [])]);
    stage('proxy-ready');
    const result = await checkTunnelConnectivity(port, Math.min(5000, timeoutMs), undefined, controller.signal);
    if (coreError) throw coreError;
    if (result.status === 'cancelled') assertActive(controller.signal);
    stage('tls-check');
    return { ...result, reason: result.status === 'ok' ? undefined : 'network', resolvedServer: resolved };
  } catch (error) {
    const reason = signal?.aborted ? 'cancelled' : coreError?.code === 'REALITY_FAILED' ? 'reality' : coreError ? classifyConnectionError(coreError)
      : timedOut ? 'network' : classifyConnectionError(error);
    return { status: reason === 'cancelled' ? 'cancelled' : reason === 'auth' ? 'auth-error' : timedOut ? 'timeout' : 'error',
      ms: null, kind: 'tunnel', reason };
  } finally {
    clearTimeout(timer);
    controller.abort();
    kill();
    await Promise.all(processes.map(async entry => {
      if (entry.done) return;
      let stopTimer;
      try { await Promise.race([entry.exited, new Promise(resolve => { stopTimer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(stopTimer); }
    }));
    signal?.removeEventListener('abort', abort);
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    if (processes.some(entry => !entry.done)) throw connectionError('ENGINE_FAILED', 'Не удалось завершить проверочный VPN-процесс.');
  }
}

async function probeServer(server, executable, xrayExecutable, options = {}) {
  const started = Date.now();
  const result = await probeServerOnce(server, executable, xrayExecutable, options);
  const nativeHandshakeFailed = result.reason === 'reality' || (result.reason === 'network' && result.status === 'error');
  if (!nativeHandshakeFailed || server.security !== 'reality' || server.transport !== 'tcp'
    || server.connectionEngine === 'xray' || options.signal?.aborted) return result;
  const remaining = (options.timeoutMs ?? 8000) - (Date.now() - started);
  if (remaining < 500) return result;
  options.onStage?.('reality-xray-fallback', Date.now() - started);
  return probeServerOnce({...server,connectionEngine:'xray'},executable,xrayExecutable,{...options,timeoutMs:remaining});
}

module.exports = { resolveServer, probeServer, probeHysteria: probeServer };
