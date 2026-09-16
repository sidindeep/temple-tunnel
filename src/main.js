const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Notification, powerMonitor, nativeImage, net: electronNet } = require('electron');
// This UI does not need GPU rendering. Avoid exercising unstable display drivers.
// Must run before Electron becomes ready or creates any windows.
app.disableHardwareAcceleration();
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadSubscription, isSupportedTransport } = require('./subscription');
const { buildConfig } = require('./singbox');
const { buildXrayConfig, buildXrayGroup } = require('./xray');
const { measureEndpointLatency, measureTunnelLatency, checkTunnelConnectivity, checkTunnelReadiness } = require('./latency');
const { resolveServer, probeServer } = require('./server-probe');
const { recordResult, rankCandidates, selectWorkingServer, hedgeDelay, HISTORY_TTL } = require('./connection-selection');
const { connectionError, classifyConnectionError, connectionErrorMessages } = require('./connection-errors');
const { createConnectionNotices } = require('./connection-notices');
const { createFileLog, sanitizeLog, coreDiagnostic, isLocalCoreFailure, attachCoreLogReader } = require('./file-log');
const { poolKey, preparePool, selectOutbound } = require('./tunnel-pool');
const { normalizeRouting, normalizeDns } = require('./routing-settings');
const { nextReserve, preferPrepared, INTERVAL_MS } = require('./reserve-monitor');
const { retryDelay } = require('./retry-policy');
const { organizeSubscriptions } = require('./subscription-organization');
const { normalizeKillSwitch, normalizeIpv6, normalizeDnsPolicy } = require('./security-settings');
const { createGuard, guardArguments } = require('./network-guard');
const { readImport } = require('./import-source');
const { createUpdates } = require('./signed-updates');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);
let signedUpdates, updatedCores, updateBusy = false;
async function checkCoreUpdate(generation) {
  for (const file of generation.manifest.files) {
    const binary = path.join(generation.directory,file.name);
    const { stdout } = await executeFile(binary,['version'],{windowsHide:true,timeout:10000,maxBuffer:65536});
    const actual = stdout.match(file.name === 'sing-box.exe' ? /sing-box version (\d+\.\d+\.\d+)/ : /Xray (\d+\.\d+\.\d+)/)?.[1];
    if (actual !== file.version) throw new Error('Версия ядра не совпадает с подписанным манифестом.');
  }
  const server = servers().find(item => item.id === state.selectedServerId);
  if (!server) throw new Error('Для проверки совместимости ядер сначала добавьте и выберите сервер.');
  await fsp.mkdir(runtimeDir(),{recursive:true});
  const file = path.join(runtimeDir(),`update-check-${crypto.randomUUID()}.json`);
  try {
    const config = buildConfig({server,applications:[],mode:'full',bridgePort:server.transport === 'xhttp' ? 12345 : 0,
      ipv6Policy:state.ipv6Policy,dnsPolicy:state.dnsPolicy,dnsPreset:state.dnsPreset,customRouting:state.customRouting,ruleSetPaths:rulesPath()});
    await fsp.writeFile(file,JSON.stringify(config),{mode:0o600});
    await executeFile(path.join(generation.directory,'sing-box.exe'),['check','-c',file],{windowsHide:true,timeout:15000,maxBuffer:65536});
    if (server.protocol !== 'hysteria2' && ['tcp','xhttp'].includes(server.transport)) {
      await fsp.writeFile(file,JSON.stringify(buildXrayConfig({server,socksPort:12346})),{mode:0o600});
      await executeFile(path.join(generation.directory,'xray.exe'),['run','-test','-config',file],{windowsHide:true,timeout:15000,maxBuffer:65536});
    }
  } catch { throw new Error('Новые ядра не прошли проверку текущей конфигурации. Сохранена прежняя версия.'); }
  finally { await removeRuntimeConfig(file); }
}
async function launchSignedInstaller(generation) {
  const fresh = await signedUpdates.readGeneration(generation.id);
  if (fresh.manifest.version === require('../package.json').version) {
    await signedUpdates.activate(fresh);
    return 'Установщик текущей версии сохранён для будущего отката.';
  }
  const confirmation = await dialog.showMessageBox(mainWindow,{type:'info',message:`Установить Temple Tunnel ${fresh.manifest.version}?`,
    detail:'Подпись и файлы проверены. Приложение закроется, откроется установщик.',buttons:['Установить','Отмена'],defaultId:1,cancelId:1});
  if (confirmation.response !== 0) return 'Отменено.';
  await manualDisconnect();
  // NSIS is an interactive installer; it waits for the old app to exit.
  await signedUpdates.readGeneration(generation.id);
  const child = spawn(path.join(fresh.directory,'setup.exe'),[],{detached:true,stdio:'ignore',windowsHide:false});
  await new Promise((resolve,reject) => {child.once('spawn',resolve);child.once('error',reject);});
  child.unref(); await signedUpdates.activate(fresh); app.quit();
  return 'Установщик запущен.';
}
let networkGuard;
let activeTunName = '-';
function guardCores() { return [process.execPath, corePath(), xrayPath()]; }
async function armGuard(tun = '-') {
  if (state.killSwitch === 'off') return;
  if (!networkGuard) throw new Error('Системная защита недоступна.');
  await networkGuard.apply(state, guardCores(), tun);
}
async function manualDisconnect() {
  await stopTunnel({ immediate: true });
  activeTunName = '-';
  if (state.killSwitch === 'session') await networkGuard?.clear();
  else if (state.killSwitch === 'always') await armGuard();
  pushState();
}
let fileLog;
let connectionNotification;
const connectionNotices = createConnectionNotices((title, body) => {
  try {
    if (!Notification.isSupported()) return;
    connectionNotification?.close();
    connectionNotification = new Notification({ title, body });
    connectionNotification.on('failed', () => log('Windows не смогла показать уведомление VPN.'));
    connectionNotification.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    connectionNotification.show();
  } catch { log('Уведомления Windows недоступны.'); }
});
const { validateRule, loadCachedRules, updateRules } = require('./rule-updater');
let cachedRulePaths;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow;
let coreProcess;
let coreConfigPath;
let xrayProcess;
let xrayConfigPath;
let latencyRefreshInFlight;
let healthTimer;
let subscriptionTimer;
let subscriptionUpdateInFlight = false;
let healthCheckInFlight = false;
let confirmingConnection = false;
let awaitingServerRecovery = false;
let serverLatencies = new Map();
let subscriptionCache;
let activeHealthPort = 0;
let autoReconnectTimer;
let warningClearTimer;
let logPushTimer;
let saveQueue = Promise.resolve();
let tunnelOperationId = 0;
let connectionController;
let selectionInFlight;
let latencyController;
let connectionMemory = {};
let automaticRecoveryActive = false;
let activePool;
let reserveController;
let reserveTimer;
let reserveCheckInFlight;
let networkTimer;
let networkSuspended = false;
let networkReconnect = false;
let networkTransition;
let networkSignature;
let networkStableAt = 0;
let networkRetryAt = 0;
let networkRetryAttempt = 0;
let networkRetryTimer;
const failedServerIds = new Set();
const SUGGESTED_APPLICATIONS = [
  { name: 'Telegram', processName: 'Telegram.exe', glyph: 'T' },
  { name: 'WhatsApp', processName: 'WhatsApp.exe', glyph: 'W' },
  { name: 'Discord', processName: 'Discord.exe', glyph: 'D' },
  { name: 'Claude', processName: 'Claude.exe', glyph: 'C' },
  { name: 'ChatGPT', processName: 'ChatGPT.exe', glyph: 'G' },
  { name: 'Codex', processName: 'Codex.exe', glyph: '⌘' },
  { name: 'Cursor', processName: 'Cursor.exe', glyph: 'C' },
  { name: 'Slack', processName: 'slack.exe', glyph: 'S' },
  { name: 'Figma', processName: 'Figma.exe', glyph: 'F' },
  { name: 'Google Chrome', processName: 'chrome.exe', glyph: '●' },
  { name: 'Microsoft Edge', processName: 'msedge.exe', glyph: 'E' },
  { name: 'Firefox', processName: 'firefox.exe', glyph: 'F' }
];
let state = {
  subscriptionEncrypted: '',
  serversEncrypted: '',
  subscriptionsEncrypted: '',
  activeSubscriptionId: '',
  selectedServerId: '',
  selectedApplications: [],
  bypassApplications: [],
  mode: 'selected',
  russianSitesViaVpn: true,
  connectionStrategy: 'auto',
  customRouting: { proxy: [], direct: [], block: [] },
  dnsPreset: 'legacy',
  killSwitch: 'off',
  ipv6Policy: 'block',
  dnsPolicy: 'routing',
  status: 'disconnected',
  error: '',
  warning: '',
  logs: []
};

function dataFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function runtimeDir() {
  return path.join(app.getPath('userData'), 'runtime');
}

function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows не предоставила защищённое хранилище ключей.');
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
}

function decrypt(payload, fallback) {
  if (!payload) return fallback;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(payload, 'base64')));
  } catch {
    return fallback;
  }
}

async function loadState() {
  try {
    const stored = JSON.parse(await fsp.readFile(dataFile(), 'utf8'));
    state = { ...state, ...stored, status: 'disconnected', error: '', warning: '', logs: [] };
    state.customRouting = normalizeRouting(decrypt(stored.routingEncrypted, {}));
    state.dnsPreset = normalizeDns(stored.dnsPreset || 'legacy');
    state.killSwitch = normalizeKillSwitch(stored.killSwitch || 'off');
    state.ipv6Policy = normalizeIpv6(stored.ipv6Policy || 'block');
    state.dnsPolicy = normalizeDnsPolicy(stored.dnsPolicy || 'routing');
    if (!['auto', 'manual'].includes(state.connectionStrategy)) state.connectionStrategy = 'auto';
    connectionMemory = decrypt(stored.connectionMemoryEncrypted, {}) || {};
    subscriptionCache = undefined;
    let migrated = false;
    if (!Array.isArray(stored.selectedApplications) && Array.isArray(stored.applications)) {
      state.selectedApplications = stored.applications;
      migrated = true;
    }
    if (!Array.isArray(state.selectedApplications)) state.selectedApplications = [];
    if (!Array.isArray(state.bypassApplications)) state.bypassApplications = [];
    const selectedApplications = normalizeApplicationList(state.selectedApplications);
    const bypassApplications = normalizeApplicationList(state.bypassApplications);
    if (selectedApplications.length !== state.selectedApplications.length) migrated = true;
    if (bypassApplications.length !== state.bypassApplications.length) migrated = true;
    state.selectedApplications = selectedApplications;
    state.bypassApplications = bypassApplications;
    if (!['full', 'selected', 'bypass'].includes(state.mode)) {
      state.mode = 'selected';
      migrated = true;
    }

    if (!state.subscriptionsEncrypted && state.subscriptionEncrypted) {
      const source = decrypt(state.subscriptionEncrypted, '');
      const legacyServers = decrypt(state.serversEncrypted, []);
      if (source && Array.isArray(legacyServers) && legacyServers.length) {
        const id = crypto.randomUUID();
        state.subscriptionsEncrypted = encrypt([{
          id,
          name: 'Основная подписка',
          source,
          servers: legacyServers,
          selectedServerId: state.selectedServerId
        }]);
        state.activeSubscriptionId = id;
        state.subscriptionEncrypted = '';
        state.serversEncrypted = '';
        migrated = true;
      }
    }

    const savedSubscriptions = subscriptions();
    const active = savedSubscriptions.find((item) => item.id === state.activeSubscriptionId) || savedSubscriptions[0];
    if (active && active.id !== state.activeSubscriptionId) {
      state.activeSubscriptionId = active.id;
      state.selectedServerId = active.selectedServerId || chooseServerId(active.servers, '');
      migrated = true;
    }
    if (migrated) await saveState();
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load settings:', error.message);
  }
}

function saveState() {
  const persisted = {
    killSwitch: state.killSwitch, ipv6Policy: state.ipv6Policy, dnsPolicy: state.dnsPolicy,
    routingEncrypted: encrypt(state.customRouting),
    dnsPreset: state.dnsPreset,
    connectionStrategy: state.connectionStrategy,
    connectionMemoryEncrypted: encrypt(connectionMemory),
    subscriptionEncrypted: state.subscriptionEncrypted,
    serversEncrypted: state.serversEncrypted,
    subscriptionsEncrypted: state.subscriptionsEncrypted,
    activeSubscriptionId: state.activeSubscriptionId,
    selectedServerId: state.selectedServerId,
    selectedApplications: state.selectedApplications,
    bypassApplications: state.bypassApplications,
    mode: state.mode,
    russianSitesViaVpn: state.russianSitesViaVpn !== false
  };
  const contents = JSON.stringify(persisted, null, 2);
  const targetPath = dataFile();
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const write = async () => {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fsp.writeFile(temporaryPath, contents, { mode: 0o600 });
      try {
        await fsp.rename(temporaryPath, targetPath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        await fsp.writeFile(targetPath, contents, { mode: 0o600 });
      }
    } finally {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    }
  };
  const pending = saveQueue.catch(() => {}).then(write);
  saveQueue = pending;
  return pending;
}

function subscriptions() {
  if (subscriptionCache) return subscriptionCache;
  const stored = decrypt(state.subscriptionsEncrypted, []);
  subscriptionCache = Array.isArray(stored) ? stored : [];
  return subscriptionCache;
}

function activeSubscription() {
  const saved = subscriptions();
  return saved.find((item) => item.id === state.activeSubscriptionId) || saved[0];
}

function servers() {
  const active = activeSubscription();
  if (active) return Array.isArray(active.servers) ? active.servers : [];
  return decrypt(state.serversEncrypted, []);
}

function subscriptionUrl() {
  return activeSubscription()?.source || decrypt(state.subscriptionEncrypted, '');
}

function chooseServerId(availableServers, preferredId) {
  if (!Array.isArray(availableServers) || !availableServers.length) return '';
  const preferred = availableServers.find((item) => item.id === preferredId && isSupportedTransport(item.transport));
  const compatible = availableServers.find((item) => isSupportedTransport(item.transport));
  return (preferred || compatible || availableServers[0]).id;
}

function applicationProcessName(application) {
  return String(application?.processName || path.basename(application?.path || '')).trim();
}

function applicationIdentity(application) {
  return applicationProcessName(application).toLowerCase();
}

function normalizeApplicationList(applications) {
  const normalized = [];
  const known = new Set();
  for (const application of applications) {
    const processName = applicationProcessName(application);
    const identity = processName.toLowerCase();
    if (!identity || known.has(identity)) continue;
    known.add(identity);
    normalized.push({
      name: String(application.name || path.basename(processName, '.exe')).slice(0, 100),
      processName,
      path: application.path ? String(application.path) : '',
      custom: Boolean(application.custom)
    });
  }
  return normalized;
}

function storeSubscriptions(saved) {
  subscriptionCache = saved;
  state.subscriptionsEncrypted = encrypt(saved);
}

function publicState() {
  const activeApplications = state.mode === 'bypass' ? state.bypassApplications : state.selectedApplications;
  const savedSubscriptions = subscriptions();
  const active = savedSubscriptions.find((item) => item.id === state.activeSubscriptionId) || savedSubscriptions[0];
  return {
    subscriptionConfigured: savedSubscriptions.length > 0 || Boolean(state.subscriptionEncrypted),
    subscriptions: savedSubscriptions.map((item) => ({
      id: item.id,
      name: item.name,
      hidden: Boolean(item.hidden),
      metadata: item.metadata || {},
      importReport: item.importReport || {},
      updatedAt: item.updatedAt || null,
      serverCount: Array.isArray(item.servers) ? item.servers.length : 0,
      active: item.id === active?.id
    })),
    activeSubscriptionId: active?.id || '',
    servers: servers().map(({ id, name, host, port, transport, security }) => {
      const latency = serverLatencies.get(id) || { status: 'pending', ms: null, kind: 'endpoint' };
      return {
        id, name, host, port, transport, security,
        supported: isSupportedTransport(transport),
        latencyStatus: latency.status,
        latencyMs: latency.ms,
        latencyKind: latency.kind,
        latencyCheckedAt: latency.checkedAt || null
      };
    }),
    selectedServerId: state.selectedServerId,
    applications: activeApplications,
    connectionStrategy: state.connectionStrategy,
    customRouting: state.customRouting,
    dnsPreset: state.dnsPreset,
    suggestedApplications: SUGGESTED_APPLICATIONS,
    killSwitch: state.killSwitch, guardActive: Boolean(networkGuard?.active), guardKnown: Boolean(networkGuard?.known),
    ipv6Policy: state.ipv6Policy, dnsPolicy: state.dnsPolicy,
    mode: state.mode,
    russianSitesViaVpn: state.russianSitesViaVpn !== false,
    status: state.status,
    error: state.error,
    warning: state.warning,
    recovering: automaticRecoveryActive || confirmingConnection || networkReconnect,
    retryAt: networkReconnect && state.status === 'reconnecting' ? networkRetryAt : 0,
    logs: state.logs.slice(-120)
  };
}

async function refreshServerLatencies() {
  if (latencyRefreshInFlight) return latencyRefreshInFlight;

  latencyRefreshInFlight = (async () => {
    const controller = new AbortController();
    latencyController = controller;
    const currentServers = servers();
    const measuredSubscriptionId = state.activeSubscriptionId;
    const measuredOperationId = tunnelOperationId;
    if (!currentServers.length) {
      serverLatencies = new Map();
      pushState();
      return publicState();
    }

    if (state.status === 'connecting' || state.status === 'disconnecting' || state.status === 'reconnecting') return publicState();

    const tunnelPort = state.status === 'connected' ? activeHealthPort : 0;
    const tunnelServerId = tunnelPort
      ? state.selectedServerId
      : '';
    const targets = tunnelServerId
      ? currentServers.filter((server) => server.id === tunnelServerId)
      : currentServers;

    for (const server of targets) {
      const previous = serverLatencies.get(server.id);
      serverLatencies.set(server.id, {
        status: 'measuring',
        ms: previous?.ms ?? null,
        kind: 'tunnel',
        checkedAt: previous?.checkedAt || null
      });
    }
    pushState();

    const measurements = [];
    for (const server of targets) {
      if (measuredSubscriptionId !== state.activeSubscriptionId) break;
      if (!tunnelServerId && state.status !== 'disconnected' && state.status !== 'error') break;
      const result = !tunnelServerId && server.protocol === 'hysteria2'
        ? {status:'unmeasured',ms:null,kind:'tunnel'}
        : tunnelServerId ? await checkTunnelConnectivity(tunnelPort, 7000)
        : await probeServer(server, corePath(), xrayPath(), { signal: controller.signal });
      result.checkedAt = Date.now();
      if (measuredSubscriptionId !== state.activeSubscriptionId || measuredOperationId !== tunnelOperationId) return publicState();
      measurements.push({ id: server.id, result });
      serverLatencies.set(server.id, result);
      pushState();
    }
    if (measuredSubscriptionId !== state.activeSubscriptionId) return publicState();
    const results = new Map(measurements.map(({ id, result }) => [id, result]));
    serverLatencies = new Map(currentServers.map((server) => [
      server.id,
      results.get(server.id) || serverLatencies.get(server.id) || { status: 'pending', ms: null, kind: 'endpoint' }
    ]));
    pushState();
    const activeResult = tunnelServerId ? results.get(tunnelServerId) : undefined;
    if (
      activeResult
      && activeResult.status !== 'ok'
      && state.status === 'connected'
      && activeHealthPort === tunnelPort
      && state.selectedServerId === tunnelServerId
    ) {
      void checkActiveTunnelHealth();
    }
    return publicState();
  })().finally(() => {
    latencyController = undefined;
    latencyRefreshInFlight = undefined;
    for (const [id, result] of serverLatencies) {
      if (result.status === 'measuring') serverLatencies.set(id, {status:'unmeasured',ms:null,kind:'tunnel'});
    }
    pushState();
  });

  return latencyRefreshInFlight;
}

function scheduleReserveCheck(delayMs = 3000) {
  clearTimeout(reserveTimer);
  if (!activePool || state.status !== 'connected' || state.connectionStrategy !== 'auto') return;
  reserveTimer = setTimeout(() => void checkPreparedReserve(), delayMs);
  reserveTimer.unref?.();
}

async function checkPreparedReserve() {
  const pool = activePool;
  if (!pool || reserveCheckInFlight || state.status !== 'connected' || state.connectionStrategy !== 'auto') return;
  if (networkSuspended || networkReconnect || confirmingConnection || electronNet?.isOnline() === false) {
    scheduleReserveCheck(INTERVAL_MS); return;
  }
  const id = nextReserve(pool);
  if (!id) { scheduleReserveCheck(INTERVAL_MS); return; }
  const controller = new AbortController(); reserveController = controller;
  const operationId = tunnelOperationId;
  const pending = (async () => {
    const result = await checkTunnelConnectivity(pool.probePorts.get(id), 3000, undefined, controller.signal);
    if (controller.signal.aborted || operationId !== tunnelOperationId || activePool !== pool
      || state.status !== 'connected' || networkSuspended || electronNet?.isOnline() === false || confirmingConnection) return;
    const checkedAt = Date.now();
    pool.checks.set(id, {...result,checkedAt});
    // Only retain an in-memory observation; no disk write or new core process per probe.
    serverLatencies.set(id,{...result,checkedAt});
    log(`Проверка резерва: ${result.status}; ${result.ms ?? '—'} мс. Работающий сервер сохранён.`);
    pushState();
  })();
  reserveCheckInFlight = pending;
  try { await pending; } catch { /* A monitor error must not disconnect a healthy tunnel. */ }
  finally {
    if (reserveCheckInFlight === pending) reserveCheckInFlight = undefined;
    if (reserveController === controller) reserveController = undefined;
    if (activePool === pool) scheduleReserveCheck(INTERVAL_MS);
  }
}

async function checkActiveTunnelHealth() {
  if (networkSuspended || networkReconnect || electronNet?.isOnline() === false) return;
  if (healthCheckInFlight || (state.status !== 'connected' && !awaitingServerRecovery) || !activeHealthPort) return;
  const checkedPort = activeHealthPort;
  const checkedServerId = state.selectedServerId;
  const checkedOperation = tunnelOperationId;
  const stillCurrent = () => (state.status === 'connected' || awaitingServerRecovery) && activeHealthPort === checkedPort
    && state.selectedServerId === checkedServerId && tunnelOperationId === checkedOperation;
  const checkingMessage = 'Проверяем соединение… Текущий сервер сохраняется до подтверждения сбоя.';
  healthCheckInFlight = true;
  try {
    let result = await checkTunnelReadiness(checkedPort);
    if (!stillCurrent()) return;
    if (awaitingServerRecovery) {
      // Probe the existing outbound: restarting the TUN would also kill direct sessions.
      if (result.status === 'ok') {
        awaitingServerRecovery = false;
        state.status = 'connected';
        state.error = '';
        state.warning = '';
        if (activePool) activePool.activeConfirmedAt = Date.now();
        log('Соединение с выбранным сервером восстановлено без перезапуска туннеля.');
        connectionNotices.connected(servers().find(item => item.id === checkedServerId)?.name || 'VPN');
      }
      return;
    }
    if (result.status === 'ok') { if (activePool) activePool.activeConfirmedAt = Date.now(); return; }
    const confirmationDeadline = Date.now() + 10000;
    confirmingConnection = true;
    state.warning = checkingMessage;
    pushState();
    while (stillCurrent()) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!stillCurrent()) return;
      result = await checkTunnelReadiness(checkedPort);
      if (!stillCurrent()) return;
      if (result.status === 'ok') {
        if (activePool) activePool.activeConfirmedAt = Date.now();
        state.warning = '';
        log('Кратковременный сбой прошёл: текущий сервер сохранён.');
        return;
      }
      if (Date.now() >= confirmationDeadline) {
        scheduleFailover('соединение не восстановилось за 10 секунд повторных проверок нескольких адресов');
        return;
      }
    }
  } finally {
    healthCheckInFlight = false;
    confirmingConnection = false;
    if (state.warning === checkingMessage) state.warning = '';
    pushState();
  }
}

function pushState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:changed', publicState());
}

function scheduleLogPush() {
  if (logPushTimer) return;
  logPushTimer = setTimeout(() => {
    logPushTimer = undefined;
    pushState();
  }, 100);
  logPushTimer.unref?.();
}

function log(message) {
  const clean = sanitizeLog(message);
  if (!clean) return;
  fileLog?.write(clean);
  state.logs.push(`${new Date().toLocaleTimeString('ru-RU')}  ${clean}`);
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  scheduleLogPush();
}

function readDiagnosticCoreLog(child, coreName, chunk) {
  const message = chunk.toString();
  if (/authentication failed|invalid user|invalid password/i.test(message)) child.authErrorCount = (child.authErrorCount || 0) + 1;
  // Inspect each line independently: a chunk can contain unrelated startup and network messages.
  if (message.split(/\r?\n/).some(isLocalCoreFailure)) child.localFailure = true;
  const diagnostic = coreDiagnostic(message);
  if (!diagnostic) return;
  if (child.lastDiagnostic === diagnostic && Date.now() - child.lastDiagnosticAt < 1000) return;
  child.lastDiagnostic = diagnostic;
  child.lastDiagnosticAt = Date.now();
  log(`[${coreName}] ${diagnostic}`);
}

function corePath() {
  if (updatedCores) return path.join(updatedCores.directory,'sing-box.exe');
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor', 'sing-box');
  return path.join(base, app.isPackaged ? 'bin' : '', 'sing-box.exe');
}

function xrayPath() {
  if (updatedCores) return path.join(updatedCores.directory,'xray.exe');
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor');
  return path.join(base, app.isPackaged ? 'bin' : '', 'xray', 'xray.exe');
}

function rulesPath() {
  if (cachedRulePaths) return cachedRulePaths;
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'vendor', 'sing-box');
  return {
    geoipRu: path.join(base, 'rules', 'geoip-ru.srs'),
    geositeRu: path.join(base, 'rules', 'geosite-category-ru.srs')
  };
}

function chooseTunAddress() {
  const usedAddresses = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item?.family === 'IPv4')
      .map((item) => item.address)
  );
  const candidates = [
    '172.31.254.1/30',
    '172.31.253.1/30',
    '10.254.254.1/30',
    '10.253.253.1/30',
    '198.19.255.1/30'
  ];
  const selected = candidates.find((candidate) => !usedAddresses.has(candidate.split('/')[0]));
  if (!selected) throw new Error('Не удалось подобрать свободный адрес для VPN-интерфейса. Отключите другой VPN и повторите попытку.');
  return selected;
}

async function refreshRussianRules() {
  const root = path.join(app.getPath('userData'), 'rule-cache');
  const validate = file => validateRule(corePath(), file);
  cachedRulePaths = await loadCachedRules(root, validate);
  try {
    cachedRulePaths = await updateRules(root, validate);
    log('Российские списки доменов и IP проверены и обновлены.' + (isTunnelActive() ? ' Применятся при следующем подключении.' : ''));
  } catch {
    log('Российские списки не обновлены: используются последние сохранённые или встроенные файлы.');
  }
}

async function removeRuntimeConfig(configPath) {
  if (!configPath) return;
  if (coreConfigPath === configPath) coreConfigPath = undefined;
  if (xrayConfigPath === configPath) xrayConfigPath = undefined;
  try {
    await fsp.rm(configPath, { force: true });
  } catch (error) {
    log(`Не удалось удалить временную конфигурацию: ${error.message}`);
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function probeHttpConnect(port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('тайм-аут проверки')));
    socket.once('error', finish);
    socket.once('connect', () => {
      socket.write('CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\nConnection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      if (/^HTTP\/1\.[01] 200\b/.test(response)) finish();
      else finish(new Error(`локальный прокси ответил ${response.split('\r\n', 1)[0] || 'ошибкой'}`));
    });
  });
}

async function waitForVerifiedTunnel(child, port, timeoutMs = 8000, signal, stage = () => {}) {
  await waitForLocalPort(child, port, 20000, 'sing-box', signal,
    () => stage('Windows ещё подготавливает VPN-интерфейс; ожидаем готовности локального ядра.'));
  stage('Системный туннель и локальный порт готовы.');
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
    if (child.startError) throw child.startError;
    if (child.localFailure) throw connectionError('TUN_FAILED', connectionErrorMessages.local);
    if (child.exitCode !== null) throw connectionError('ENGINE_FAILED', 'VPN-ядро завершилось до установки соединения.');
    const authBefore = (child.authErrorCount || 0) + (xrayProcess?.authErrorCount || 0);
    try {
      const result = await checkTunnelReadiness(port, Math.min(3000, deadline - Date.now()), signal);
      if (result.status !== 'ok') {
        if ((child.authErrorCount || 0) + (xrayProcess?.authErrorCount || 0) > authBefore)
          throw connectionError('AUTH_FAILED', connectionErrorMessages.auth);
        throw new Error(result.kind === 'dns' ? 'DNS через туннель не отвечает' : 'нет защищённого ответа от проверочных адресов');
      }
      stage('Защищённое соединение и DNS через туннель проверены.');
      return {...result, checkedAt: Date.now()};
    } catch (error) {
      if (error.code === 'AUTH_FAILED') throw error;
      lastError = error;
      if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
      log('Защищённая проверка неуспешна; повтор через 250 мс.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`VPN-сервер не подтвердил соединение: ${lastError?.message || 'тайм-аут'}.`);
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopProcess(child, { force = false } = {}) {
  if (!child) return;
  if (child.gracefulHost && child.exitCode === null) {
    try { child.stdin.end('stop\n'); } catch {}
    await waitForProcessExit(child, 3500);
    if (child.exitCode !== null) return;
  }
  if (force) {
    try { child.kill('SIGKILL'); } catch {}
    await waitForProcessExit(child, 750);
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
  await waitForProcessExit(child, 2500);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await waitForProcessExit(child, 1000);
  }
}

async function waitForLocalPort(child, port, timeoutMs = 8000, processName = 'Xray', signal, onSlow = () => {}) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let slowReported = false;
  let lastError;
  while (Date.now() < deadline) {
    if (!slowReported && Date.now() - startedAt >= 5000) { slowReported = true; onSlow(); }
    if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
    if (child.startError) throw child.startError;
    if (child.localFailure) throw connectionError('TUN_FAILED', connectionErrorMessages.local);
    if (child.exitCode !== null) throw connectionError('ENGINE_FAILED', `${processName} завершился до запуска локального прокси.`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(800, () => socket.destroy(new Error('тайм-аут')));
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw connectionError('CORE_READY_TIMEOUT', `${processName}: Windows не завершила запуск локального VPN-ядра за отведённое время.`);
}

function validateCoreConfig(executable, args, fallbackMessage, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(connectionError('ABORT_ERR', 'Подключение отменено.'));
    const check = spawn(executable, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { try { check.kill('SIGKILL'); } catch {} reject(error); } else resolve();
    };
    const cancel = () => finish(connectionError('ABORT_ERR', 'Подключение отменено.'));
    const timer = setTimeout(() => finish(connectionError('LOCAL_CONFIG', 'Проверка конфигурации не завершилась за 5 секунд.')), 5000);
    signal?.addEventListener('abort', cancel, { once: true });
    check.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    check.on('error', finish);
    check.on('exit', (code) => finish(code === 0 ? undefined : connectionError('LOCAL_CONFIG', `${fallbackMessage} ${coreDiagnostic(stderr)}`)));
  });
}

function cancelAutomaticRecovery({ clearWarning = true, clearFailures = true } = {}) {
  connectionNotices.cancel();
  if (autoReconnectTimer) {
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = undefined;
  }
  if (warningClearTimer) {
    clearTimeout(warningClearTimer);
    warningClearTimer = undefined;
  }
  if (clearFailures) failedServerIds.clear();
  if (clearWarning) state.warning = '';
  automaticRecoveryActive = false;
}

function isRecoverableTunnelError(error) {
  if (['cancelled', 'local', 'profile'].includes(classifyConnectionError(error))) return false;
  if (['NO_WORKING_SERVER', 'NO_CANDIDATES', 'AUTH_FAILED', 'DNS_FAILED'].includes(error?.code)) return false;
  const message = String(error?.message || error);
  return !/добавьте хотя бы одно приложение|Сначала выберите сервер|не найден|Переустановите приложение|не удалось подобрать свободный адрес|права администратора/i.test(message);
}

function assertRecoveryActive(automatic) {
  if (automatic && !automaticRecoveryActive) {
    const error = new Error('Автоматическое переподключение отменено пользователем.');
    error.code = 'RECOVERY_CANCELLED';
    throw error;
  }
}

function assertTunnelOperation(operationId, automatic) {
  if (operationId !== tunnelOperationId) {
    const error = new Error('Операция подключения отменена новой командой.');
    error.code = 'TUNNEL_SUPERSEDED';
    throw error;
  }
  assertRecoveryActive(automatic);
}

function isTunnelActive() {
  return Boolean(coreProcess || xrayProcess)
    || ['connecting', 'connected', 'reconnecting', 'disconnecting'].includes(state.status);
}

function nextFailoverServer(failedId) {
  const unavailableIds = new Set(failedServerIds);
  for (const [id, latency] of serverLatencies) {
    if (latency.status === 'auth-error' && Date.now() - latency.checkedAt < 60000) unavailableIds.add(id);
  }
  unavailableIds.add(failedId);
  const memory = selectionHistory();
  return preferPrepared(rankCandidates(servers().filter(candidate => isSupportedTransport(candidate.transport)), {
    history: memory.history, lastSuccessfulId: memory.lastSuccessfulId, failedIds: unavailableIds
  }), activePool)[0];
}

function scheduleFailover(reason) {
  if (networkSuspended || electronNet?.isOnline() === false) {
    void pauseForNetwork();
    return;
  }
  if (autoReconnectTimer) return;
  if (state.connectionStrategy === 'manual') {
    if (coreProcess && activeHealthPort) {
      connectionNotices.lost('Выбранный сервер недоступен. Трафик через VPN не проходит. Ожидаем восстановления этого сервера.');
      awaitingServerRecovery = true;
      state.status = 'reconnecting';
      state.error = '';
      state.warning = 'Выбранный сервер недоступен. Ожидаем его восстановления. Исключения продолжают работать напрямую.';
      log(`Сервер недоступен: ${reason}. Локальный туннель сохранён; проверяем тот же сервер каждые 10 секунд.`);
      pushState();
      return;
    }
    awaitingServerRecovery = false;
    connectionNotices.stopped();
    const operationId = tunnelOperationId;
    void stopTunnel().then(() => {
      if (tunnelOperationId !== operationId + 1) return;
      state.status = 'error';
      state.error = `Выбранный сервер недоступен. ${reason}`;
      connectionNotices.failed();
      pushState();
    });
    return;
  }
  connectionNotices.lost();
  const failedId = state.selectedServerId;
  automaticRecoveryActive = true;
  const failed = servers().find((item) => item.id === failedId);
  recordResult(selectionHistory().history, failedId, { status: 'error', reason: 'network' });
  if (failedId) failedServerIds.add(failedId);
  const next = nextFailoverServer(failedId);

  state.error = '';
  if (!next) {
    connectionNotices.failed();
    automaticRecoveryActive = false;
    const warning = failedServerIds.size > 1
      ? 'Все совместимые серверы этой подписки недоступны. Автопереключение остановлено.'
      : 'Сервер недоступен, а другого совместимого сервера в этой подписке нет.';
    state.status = 'error';
    state.warning = warning;
    pushState();
    void stopTunnel({ keepRecovery: true }).then(() => {
      state.status = 'error';
      state.warning = warning;
      log(`Автопереключение остановлено: ${reason}`);
      pushState();
    });
    return;
  }

  const failedName = failed?.name || 'Текущий сервер';
  state.status = 'reconnecting';
  state.warning = `Сервер «${failedName}» недоступен. Через 2 секунды переключимся на «${next.name}».`;
  log(`Сервер недоступен: ${reason}. Запланировано переключение на ${next.name}.`);
  pushState();

  const subscriptionId = state.activeSubscriptionId;
  autoReconnectTimer = setTimeout(async () => {
    autoReconnectTimer = undefined;
    if (subscriptionId !== state.activeSubscriptionId) return;
    try {
      const available = servers();
      const candidate = available.find((item) => item.id === next.id);
      if (!candidate) throw new Error('Резервный сервер больше не доступен в подписке.');
      state.selectedServerId = candidate.id;
      const saved = subscriptions();
      const active = saved.find((item) => item.id === state.activeSubscriptionId);
      if (active) {
        active.selectedServerId = candidate.id;
        storeSubscriptions(saved);
      }
      await saveState();
      pushState();
      await startTunnel({ automatic: true });
    } catch (error) {
      automaticRecoveryActive = false;
      state.status = 'error';
      state.warning = `Не удалось автоматически переключить сервер: ${error.message}`;
      connectionNotices.failed();
      pushState();
    }
  }, 2000);
  autoReconnectTimer.unref?.();
}

async function stopTunnel({ keepRecovery = false, immediate = false, operationId, keepNetwork = false } = {}) {
  awaitingServerRecovery = false;
  clearTimeout(networkRetryTimer);
  if (operationId === undefined && !keepNetwork) { networkRetryAttempt = 0; networkRetryAt = 0; }
  reserveController?.abort();
  clearTimeout(reserveTimer);
  if (!keepNetwork) networkReconnect = false;
  activePool = undefined;
  const activeOperationId = operationId ?? ++tunnelOperationId;
  connectionController?.abort();
  latencyController?.abort();
  const pendingSelection = selectionInFlight;
  if (!keepRecovery) cancelAutomaticRecovery();
  confirmingConnection = false;
  if (!keepRecovery) state.error = '';
  const coreConfigToRemove = coreConfigPath;
  const xrayConfigToRemove = xrayConfigPath;
  if (!coreProcess && !xrayProcess) {
    activeHealthPort = 0;
    await removeRuntimeConfig(coreConfigToRemove);
    await removeRuntimeConfig(xrayConfigToRemove);
    if (pendingSelection) await pendingSelection.catch(() => {});
    if (activeOperationId === tunnelOperationId) {
      state.status = 'disconnected';
      pushState();
    }
    return;
  }
  const coreToStop = coreProcess;
  const xrayToStop = xrayProcess;
  coreProcess = null;
  xrayProcess = null;
  activeHealthPort = 0;
  state.status = immediate ? 'disconnected' : 'disconnecting';
  pushState();
  await Promise.all([
    stopProcess(coreToStop, { force: immediate }),
    stopProcess(xrayToStop, { force: immediate })
  ]);
  await removeRuntimeConfig(coreConfigToRemove);
  await removeRuntimeConfig(xrayConfigToRemove);
  if (activeOperationId === tunnelOperationId) {
    state.status = 'disconnected';
    pushState();
  }
}

function selectionHistory() {
  // Store a hash only; interface addresses never enter diagnostics or preferences.
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/temple|browsec|tun|tap|loopback/i.test(name))
    .flatMap(([name, entries]) => entries.filter(item => !item.internal && item.family === 'IPv4')
      .map(item => `${name}:${item.mac}:${item.address}`)).sort();
  const key = crypto.createHash('sha256').update(JSON.stringify([state.activeSubscriptionId, interfaces])).digest('hex');
  for (const [id, entry] of Object.entries(connectionMemory)) {
    if (Date.now() - (entry.updatedAt || 0) > HISTORY_TTL) delete connectionMemory[id];
  }
  const memory = connectionMemory[key] ||= { history: {}, lastSuccessfulId: '', updatedAt: Date.now() };
  memory.updatedAt = Date.now();
  return memory;
}

async function pauseForNetwork() {
  if (networkTransition) return networkTransition;
  if (networkReconnect && !coreProcess && !connectionController) return;
  if (!isTunnelActive()) return;
  networkReconnect = true;
  networkRetryAt = 0;
  const pending = (async () => {
    await stopTunnel({ keepNetwork: true });
    if (!networkReconnect) return;
    state.status = 'reconnecting';
    state.warning = networkSuspended ? 'Компьютер спит. VPN восстановится после пробуждения.'
      : 'Ожидаем восстановления сети…';
    log('Восстановление приостановлено: изменение доступности сети.');
    pushState();
  })();
  networkTransition = pending;
  try { await pending; } finally { if (networkTransition === pending) networkTransition = undefined; }
}

async function pollNetwork() {
  const signature = JSON.stringify(Object.entries(os.networkInterfaces())
    .filter(([name]) => !/temple|browsec|tun|tap|loopback/i.test(name))
    .flatMap(([name, entries]) => entries.filter(item => !item.internal)
      .map(item => `${name}:${item.address}`)).sort());
  const changed = networkSignature !== undefined && signature !== networkSignature;
  if (signature !== networkSignature) networkStableAt = Date.now();
  networkSignature = signature;
  if (networkSuspended || networkTransition) return;
  if (changed || electronNet?.isOnline() === false) {
    await pauseForNetwork();
    return;
  }
  if (!networkReconnect || Date.now() - networkStableAt < 2000 || Date.now() < networkRetryAt) return;
  networkReconnect = false;
  log('Сеть доступна; повторная проверка подключения.');
  try { await startTunnel({ retry: true }); }
  catch { state.status = 'error'; state.error = 'Не удалось восстановить VPN после смены сети.'; pushState(); }
}

async function tryHotSwitch(automatic, operationId) {
  const pool = activePool;
  if (!pool || !coreProcess || coreProcess.exitCode !== null || !activeHealthPort
    || !['connected', 'reconnecting'].includes(state.status)
    || pool.key !== poolKey(state, servers()) || !pool.members.has(state.selectedServerId)) return false;
  connectionController?.abort();
  latencyController?.abort();
  reserveController?.abort();
  clearTimeout(reserveTimer);
  if (!automatic) cancelAutomaticRecovery();
  const controller = new AbortController();
  connectionController = controller;
  const child = coreProcess;
  const id = state.selectedServerId;
  state.status = 'connecting'; state.error = ''; pushState();
  try {
    await selectOutbound(pool, id, controller.signal);
    const result = await waitForVerifiedTunnel(child, activeHealthPort, 8000, controller.signal, () => {});
    assertTunnelOperation(operationId, automatic);
    if (child !== coreProcess || child.exitCode !== null) throw new Error('Core stopped');
    pool.activeId = id;
    pool.activeConfirmedAt = Date.now();
    const memory = selectionHistory();
    recordResult(memory.history, id, result); memory.lastSuccessfulId = id;
    serverLatencies.set(id, result);
    await saveState();
    assertTunnelOperation(operationId, automatic);
    if (child !== coreProcess || child.exitCode !== null) throw new Error('Core stopped');
    state.status = 'connected'; state.warning = ''; automaticRecoveryActive = false;
    networkRetryAttempt = 0; networkRetryAt = 0;
    failedServerIds.clear();
    connectionNotices.connected(servers().find(item => item.id === id)?.name || 'VPN');
    log('Сервер переключён без перезапуска TUN; защищённое соединение проверено.');
    scheduleReserveCheck();
    pushState();
    return true;
  } catch {
    if (controller.signal.aborted || operationId !== tunnelOperationId) return true;
    log('Быстрое переключение не подтверждено; выполняется полная проверка подключения.');
    return false;
  } finally {
    if (connectionController === controller) connectionController = undefined;
  }
}

async function startTunnel({ automatic = false, retry = false } = {}) {
  if (!retry && !automatic) { networkRetryAttempt = 0; networkRetryAt = 0; }
  const operationId = ++tunnelOperationId;
  if (state.killSwitch !== 'off' && !isTunnelActive()) { state.status = 'connecting'; pushState(); }
  try { await armGuard(coreProcess ? activeTunName : '-'); }
  catch (error) {
    if (operationId === tunnelOperationId) { state.status = 'error'; state.error = error.message; pushState(); }
    throw error;
  }
  if (operationId !== tunnelOperationId) return;
  if (networkSuspended || electronNet?.isOnline() === false) {
    if (!isTunnelActive()) state.status = 'connecting';
    await pauseForNetwork();
    return;
  }
  networkReconnect = false;
  if (await tryHotSwitch(automatic, operationId)) return;
  if (operationId !== tunnelOperationId) return;
  const startedAt = Date.now();
  const stage = (message) => log(`[Подключение ${operationId}, +${Date.now() - startedAt} мс] ${message}`);
  stage(automatic ? 'Автоматическое подключение.' : 'Ручное подключение.');
  let startedCore;
  let startedXray;
  let coreConfigFile;
  let xrayConfigFile;
  await stopTunnel({ keepRecovery: automatic, operationId });
  stage('Предыдущий туннель остановлен.');
  if (operationId !== tunnelOperationId || (automatic && !automaticRecoveryActive)) return;
  let server = servers().find((item) => item.id === state.selectedServerId);
  if (!server) throw new Error('Сначала выберите сервер.');
  if (!isSupportedTransport(server.transport)) {
    throw new Error(`Сервер использует ${String(server.transport).toUpperCase()}, который пока не поддерживается. Выберите TCP, gRPC, WebSocket или HTTP.`);
  }
  const executable = corePath();
  if (!fs.existsSync(executable)) throw new Error('VPN-ядро sing-box не найдено. Переустановите приложение.');
  let useXray = server.transport === 'xhttp';
  const xrayExecutable = xrayPath();
  if (useXray && !fs.existsSync(xrayExecutable)) throw new Error('VPN-ядро Xray не найдено. Обновите приложение.');

  const ruleSetPaths = rulesPath();
  for (const rulePath of Object.values(ruleSetPaths)) {
    if (!fs.existsSync(rulePath)) throw new Error('Российские списки маршрутизации не найдены. Переустановите приложение.');
  }

  await fsp.mkdir(runtimeDir(), { recursive: true });
  if (operationId !== tunnelOperationId || (automatic && !automaticRecoveryActive)) return;
  const controller = new AbortController();
  connectionController = controller;
  const signal = controller.signal;
  const memory = selectionHistory();
  state.status = 'connecting';
  state.error = '';
  pushState();

  try {
    assertTunnelOperation(operationId, automatic);
    if (state.mode === 'selected' && !state.selectedApplications.length) {
      throw connectionError('LOCAL_CONFIG', 'Добавьте хотя бы одно приложение для VPN.');
    }
    const requestedServerId = server.id;
    const candidates = state.connectionStrategy === 'manual' ? [server]
      : rankCandidates(servers().filter(item => isSupportedTransport(item.transport)), {
        selectedId: server.id, lastSuccessfulId: memory.lastSuccessfulId,
        history: memory.history, failedIds: failedServerIds
      });
    const recentSuccess = candidates[0] && memory.history[candidates[0].id];
    const probeResults = [];
    // A disposable Hysteria session can occupy a server-side session slot after
    // Windows terminates its process. Authenticate only in the working core.
    const hysteriaCandidate = candidates.find(candidate => candidate.protocol === 'hysteria2');
    const directCandidate = async () => ({server:hysteriaCandidate,result:{
      resolvedServer:await resolveServer(hysteriaCandidate, undefined, 5000, signal)
    }});
    const pending = candidates[0]?.protocol === 'hysteria2' ? directCandidate()
      : selectWorkingServer(candidates.filter(candidate => candidate.protocol !== 'hysteria2'), (candidate, probeSignal) => {
      const label = crypto.createHash('sha256').update(candidate.id).digest('hex').slice(0, 12);
      stage(`Проверка кандидата ${label}; транспорт: ${candidate.transport}.`);
      return probeServer(candidate, executable, xrayExecutable, {
        signal: probeSignal,
        onStage: (name, ms) => stage(`Кандидат ${label}: ${name}, ${ms} мс.`)
      });
    }, {
      signal, concurrency: state.connectionStrategy === 'manual' ? 1 : 3,
      hedgeMs: hedgeDelay(recentSuccess, automatic),
      onResult: (candidate, result) => {
        probeResults.push({ candidate, result });
        // Network failures are committed only after another candidate proves the network works.
        if (['auth', 'profile'].includes(result.reason)) recordResult(memory.history, candidate.id, result);
        serverLatencies.set(candidate.id, { status: result.status, ms: result.ms, kind: 'tunnel', checkedAt: Date.now() });
        const label = crypto.createHash('sha256').update(candidate.id).digest('hex').slice(0, 12);
        stage(`Кандидат ${label}: ${result.status}; причина: ${result.reason || 'нет'}; ${result.ms ?? '—'} мс.`);
      }
    }).catch(error => {
      if (hysteriaCandidate && ['NO_WORKING_SERVER','AUTH_FAILED','PROFILE_INVALID','DNS_FAILED'].includes(error.code))
        return directCandidate();
      throw error;
    });
    selectionInFlight = pending;
    let selected;
    try { selected = await pending; }
    finally { if (selectionInFlight === pending) selectionInFlight = undefined; }
    assertTunnelOperation(operationId, automatic);
    server = selected.server;
    for (const { candidate, result } of probeResults) {
      if (!['auth', 'profile'].includes(result.reason)) recordResult(memory.history, candidate.id, result);
      if (result.status !== 'ok' && result.status !== 'cancelled') failedServerIds.add(candidate.id);
    }
    useXray = server.transport === 'xhttp' || selected.result.resolvedServer?.connectionEngine === 'xray';
    const resolvedServer = selected.result.resolvedServer;
    state.selectedServerId = server.id;
    state.warning = server.id !== requestedServerId ? `Проверяем сервер «${server.name}».` : '';
    pushState();
    stage('Сервер выбран; готовим проверку основного туннеля.');
    stage(`DNS готов; сервер: ${crypto.createHash('sha256').update(server.id).digest('hex').slice(0, 12)}; транспорт: ${server.transport}; режим: ${state.mode}.`);
    assertTunnelOperation(operationId, automatic);
    const poolCandidates = [resolvedServer, ...rankCandidates(servers().filter(item => isSupportedTransport(item.transport)
      && (useXray || item.transport !== 'xhttp')), { history: memory.history })]
      .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index).slice(0, 5);
    const bridgePorts = new Map();
    let bridgePort = 0;
    if (useXray) {
      bridgePort = await allocateLoopbackPort();
      bridgePorts.set(server.id, bridgePort);
      assertTunnelOperation(operationId, automatic);
      const bridgeMembers = [{ server: resolvedServer, port: bridgePort }];
      const resolvedBackups = await Promise.all(poolCandidates.filter(item =>
        (item.transport === 'xhttp' || (item.transport === 'tcp' && item.security === 'reality')) && item.id !== server.id)
        .map(async item => { try { return await resolveServer(item, undefined, 300, signal); } catch { return null; } }));
      assertTunnelOperation(operationId, automatic);
      for (const backup of resolvedBackups.filter(Boolean)) {
        const port = await allocateLoopbackPort();
        bridgePorts.set(backup.id, port); bridgeMembers.push({server:backup, port});
      }
      const xrayConfig = buildXrayGroup(bridgeMembers);
      assertTunnelOperation(operationId, automatic);
      xrayConfigFile = path.join(runtimeDir(), `xray-${crypto.randomUUID()}.json`);
      xrayConfigPath = xrayConfigFile;
      await fsp.writeFile(xrayConfigFile, JSON.stringify(xrayConfig, null, 2), { mode: 0o600 });
      try {
        await validateCoreConfig(xrayExecutable, ['run', '-test', '-c', xrayConfigFile], 'Проверка XHTTP-конфигурации завершилась ошибкой.', signal);
      } catch(error) {
        if (signal.aborted || bridgeMembers.length < 2) throw error;
        bridgePorts.clear(); bridgePorts.set(server.id, bridgePort);
        await fsp.writeFile(xrayConfigFile, JSON.stringify(buildXrayConfig({server:resolvedServer,socksPort:bridgePort})), {mode:0o600});
        await validateCoreConfig(xrayExecutable, ['run', '-test', '-c', xrayConfigFile], 'Проверка XHTTP-конфигурации завершилась ошибкой.', signal);
        stage('Некорректный резерв XHTTP исключён; основной профиль сохранён.');
      }
      stage('Конфигурация Xray проверена.');
      assertTunnelOperation(operationId, automatic);

      const xrayChild = spawn(xrayExecutable, ['run', '-c', xrayConfigFile], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      startedXray = xrayChild;
      xrayProcess = xrayChild;
      attachCoreLogReader(xrayChild.stdout, line => readDiagnosticCoreLog(xrayChild, 'Xray', line));
      attachCoreLogReader(xrayChild.stderr, line => readDiagnosticCoreLog(xrayChild, 'Xray', line));
      xrayChild.on('error', (error) => {
        if (xrayProcess !== xrayChild) return;
        xrayChild.startError = error;
        if (state.status === 'connecting') return;
        state.status = 'error';
        state.error = `Ошибка Xray: ${error.message}`;
        pushState();
      });
      xrayChild.on('exit', (code) => {
        if (xrayProcess !== xrayChild) return;
        xrayProcess = null;
        removeRuntimeConfig(xrayConfigFile);
        if (state.status === 'connected' && activePool && !activePool.bridgeIds.has(activePool.activeId)) {
          for (const id of activePool.bridgeIds) {
            activePool.members.delete(id); activePool.probePorts.delete(id); activePool.checks.delete(id);
          }
          log('Резервный Xray остановился; работающий нативный туннель сохранён.');
          return;
        }
        activeHealthPort = 0;
        if (coreProcess) {
          const runningCore = coreProcess;
          coreProcess = null;
          try { runningCore.kill('SIGTERM'); } catch {}
        }
        if (!['connecting', 'disconnecting'].includes(state.status)) {
          scheduleFailover(`XHTTP-движок остановился${code ? ` с кодом ${code}` : ''}`);
        }
      });
      await waitForLocalPort(xrayChild, bridgePort, 5000, 'Xray', signal);
      stage('Локальный порт Xray готов.');
      assertTunnelOperation(operationId, automatic);
    }

    const healthPort = await allocateLoopbackPort();
    assertTunnelOperation(operationId, automatic);
    const tunAddress = chooseTunAddress();
    // Wintun may still be deleting the previous adapter after process exit.
    // Reusing its name can race Windows PnP and fail with already-exists/not-found.
    const tunName = `temple-tun-${crypto.randomBytes(6).toString('hex')}`;
    const config = buildConfig({
      server: resolvedServer,
      customRouting: state.customRouting,
      dnsPreset: state.dnsPreset,
      ipv6Policy: state.ipv6Policy, dnsPolicy: state.dnsPolicy,
      directDns: state.killSwitch !== 'off' ? require('node:dns').getServers().find(ip => net.isIP(ip) === 4) || '1.1.1.1' : undefined,
      applications: state.mode === 'bypass' ? state.bypassApplications : state.selectedApplications,
      mode: state.mode,
      russianSitesViaVpn: state.russianSitesViaVpn !== false,
      healthPort,
      bridgePort,
      tunAddress,
      tunName,
      ruleSetPaths
    });
    const singleConfig = JSON.stringify(config);
    const probePorts = new Map();
    for (const candidate of poolCandidates) {
      if (candidate.protocol === 'hysteria2') continue;
      if (candidate.transport !== 'xhttp' || bridgePorts.has(candidate.id)) probePorts.set(candidate.id, await allocateLoopbackPort());
    }
    let pool = preparePool(config, resolvedServer, poolCandidates, await allocateLoopbackPort(), bridgePorts, probePorts);
    if (pool) pool.key = poolKey(state, servers());
    assertTunnelOperation(operationId, automatic);
    coreConfigFile = path.join(runtimeDir(), `config-${crypto.randomUUID()}.json`);
    coreConfigPath = coreConfigFile;
    await fsp.writeFile(coreConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      await validateCoreConfig(executable, ['check', '-c', coreConfigFile], 'Проверка конфигурации завершилась ошибкой.', signal);
    } catch (error) {
      if (!pool || signal.aborted) throw error;
      pool = null;
      await fsp.writeFile(coreConfigFile, singleConfig, { mode: 0o600 });
      await validateCoreConfig(executable, ['check', '-c', coreConfigFile], 'Проверка конфигурации завершилась ошибкой.', signal);
      stage('Резервная группа отклонена ядром; используется проверенный основной профиль.');
    }
    stage('Конфигурация sing-box проверена; запуск ядра.');
    assertTunnelOperation(operationId, automatic);

    const gracefulHost = process.platform === 'win32' && server.protocol === 'hysteria2';
    const hostExecutable = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'core-host.exe')
      : path.join(__dirname, '..', 'vendor', 'core-host', 'core-host.exe');
    const child = spawn(gracefulHost ? hostExecutable : executable,
      gracefulHost ? [executable, coreConfigFile] : ['run', '-c', coreConfigFile], {
      windowsHide: true,
      stdio: [gracefulHost ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    child.gracefulHost = gracefulHost;
    child.stdin?.on('error', () => {});
    startedCore = child;
    coreProcess = child;
    const readCoreLog = (chunk) => {
      readDiagnosticCoreLog(child, 'sing-box', chunk);
    };
    attachCoreLogReader(child.stdout, readCoreLog);
    attachCoreLogReader(child.stderr, readCoreLog);
    child.on('error', (error) => {
      if (coreProcess !== child) return;
      child.startError = error;
      if (state.status === 'connecting') return;
      state.status = 'error';
      state.error = error.message;
      pushState();
    });
    child.on('exit', (code) => {
      if (coreProcess !== child) return;
      coreProcess = null;
      activeHealthPort = 0;
      removeRuntimeConfig(coreConfigFile);
      if (xrayProcess) {
        const runningXray = xrayProcess;
        xrayProcess = null;
        try { runningXray.kill('SIGTERM'); } catch {}
      }
      if (!['connecting', 'disconnecting'].includes(state.status)) {
        scheduleFailover(`VPN-туннель остановился${code ? ` с кодом ${code}` : ''}`);
      } else {
        if (state.status === 'disconnecting') {
          state.status = 'disconnected';
          pushState();
        }
      }
    });

    if (state.killSwitch !== 'off') {
      await waitForLocalPort(child, healthPort, 8000, 'sing-box', signal);
      await armGuard(tunName);
      assertTunnelOperation(operationId, automatic);
    }
    activeTunName = tunName;
    const verifiedLatency = await waitForVerifiedTunnel(child, healthPort, 8000, signal, stage);
    stage(`Защищённое соединение подтверждено; проверка: ${verifiedLatency.ms} мс.`);
    assertTunnelOperation(operationId, automatic);
    if (coreProcess !== child || child.exitCode !== null) throw connectionError('ENGINE_FAILED', 'VPN-ядро остановилось после проверки соединения.');
    await removeRuntimeConfig(coreConfigFile);
    await removeRuntimeConfig(xrayConfigFile);
    assertTunnelOperation(operationId, automatic);
    activeHealthPort = healthPort;
    activePool = pool;
    if (pool) pool.activeConfirmedAt = Date.now();
    serverLatencies.set(server.id, verifiedLatency);
    recordResult(memory.history, server.id, verifiedLatency);
    memory.lastSuccessfulId = server.id;
    const saved = subscriptions();
    const active = saved.find(item => item.id === state.activeSubscriptionId);
    if (active) { active.selectedServerId = server.id; storeSubscriptions(saved); }
    await saveState();
    assertTunnelOperation(operationId, automatic);
    if (coreProcess !== child || child.exitCode !== null) throw connectionError('ENGINE_FAILED', 'VPN-ядро остановилось до завершения подключения.');
    state.status = 'connected';
    networkRetryAttempt = 0; networkRetryAt = 0;
    connectionNotices.connected(server.name);
    state.error = '';
    failedServerIds.clear();
    if (!automatic) state.warning = '';
    if (automatic) {
      automaticRecoveryActive = false;
      state.warning = `Подключение восстановлено через сервер «${server.name}».`;
      const successMessage = state.warning;
      warningClearTimer = setTimeout(() => {
        warningClearTimer = undefined;
        if (state.warning === successMessage) {
          state.warning = '';
          pushState();
        }
      }, 8000);
      warningClearTimer.unref?.();
    }
    log(useXray ? 'Соединение через Xray проверено и туннель запущен.' : 'VPN-соединение проверено и туннель запущен.');
    scheduleReserveCheck();
    pushState();
  } catch (error) {
    const staleOperation = operationId !== tunnelOperationId || error.code === 'TUNNEL_SUPERSEDED' || signal.aborted;
    if (coreProcess === startedCore) coreProcess = null;
    if (xrayProcess === startedXray) xrayProcess = null;
    if (!staleOperation) activeHealthPort = 0;
    await Promise.all([stopProcess(startedCore), stopProcess(startedXray)]);
    await removeRuntimeConfig(coreConfigFile);
    await removeRuntimeConfig(xrayConfigFile);
    if (staleOperation) return;
    state.status = 'error';
    const reason = classifyConnectionError(error);
    state.error = ['NO_CANDIDATES', 'NO_WORKING_SERVER'].includes(error.code) ? error.message
      : reason === 'local' ? error.message : connectionErrorMessages[reason];
    stage(`Ошибка подключения: ${reason}; код: ${error.code || 'NETWORK_FAILED'}.`);
    if (startedCore && ['auth', 'profile'].includes(reason)) recordResult(memory.history, server.id, {status:'error',reason});
    await saveState();
    if (operationId !== tunnelOperationId) return;
    if (error.code === 'RECOVERY_CANCELLED' || (automatic && !automaticRecoveryActive)) {
      state.status = 'disconnected';
      state.error = '';
      pushState();
    } else if (['NO_WORKING_SERVER', 'DNS_FAILED'].includes(error.code)) {
      automaticRecoveryActive = false;
      networkReconnect = true;
      const delayMs = retryDelay(networkRetryAttempt++);
      networkRetryAt = Date.now() + delayMs;
      state.status = 'reconnecting'; state.error = '';
      state.warning = 'Рабочее соединение пока не найдено.';
      clearTimeout(networkRetryTimer);
      networkRetryTimer = setTimeout(() => void pollNetwork().catch(() => {}), delayMs);
      networkRetryTimer.unref?.();
      pushState();
    } else if (state.connectionStrategy === 'auto' && (isRecoverableTunnelError(error)
      || (startedCore && server.protocol === 'hysteria2' && error.code === 'AUTH_FAILED'))) {
      scheduleFailover(error.message);
    } else {
      automaticRecoveryActive = false;
      connectionNotices.failed();
      pushState();
    }
  } finally {
    if (connectionController === controller) connectionController = undefined;
  }
}

async function addSubscription({ name, source }) {
  const cleanSource = String(source || '').trim();
  if (!cleanSource) throw new Error('Введите ссылку подписки или VLESS-ключ.');
  const downloaded = await downloadSubscription(cleanSource);
  const saved = subscriptions();
  const id = crypto.randomUUID();
  const cleanName = String(name || '').trim().slice(0, 80) || `Подписка ${saved.length + 1}`;
  const selectedServerId = chooseServerId(downloaded, '');
  const tunnelRunning = isTunnelActive();

  saved.push({ id, name: cleanName, source: cleanSource, servers: downloaded, selectedServerId,
    metadata: downloaded.metadata || {}, importReport: downloaded.importReport || {}, updatedAt: Date.now() });
  storeSubscriptions(saved);
  state.activeSubscriptionId = id;
  state.selectedServerId = selectedServerId;
  state.subscriptionEncrypted = '';
  state.serversEncrypted = '';
  serverLatencies = new Map();
  await saveState();
  if (tunnelRunning) await startTunnel();
  else pushState();
  return publicState();
}

async function updateSubscription({ id, name, source }) {
  const saved = subscriptions();
  const stored = saved.find((item) => item.id === String(id || ''));
  if (!stored) throw new Error('Подписка не найдена.');

  const cleanName = String(name || '').trim().slice(0, 80) || stored.name;
  const cleanSource = String(source || '').trim();
  const sourceChanged = Boolean(cleanSource && cleanSource !== stored.source);
  const nameChanged = cleanName !== stored.name;
  if (!nameChanged && !sourceChanged) return publicState();
  let downloaded;
  if (sourceChanged) downloaded = await downloadSubscription(cleanSource);

  const active = stored.id === state.activeSubscriptionId;
  const tunnelRunning = isTunnelActive();
  stored.name = cleanName;
  if (sourceChanged) {
    stored.source = cleanSource;
    stored.servers = downloaded;
    stored.metadata = downloaded.metadata || {};
    stored.importReport = downloaded.importReport || {};
    stored.updatedAt = Date.now();
    stored.selectedServerId = chooseServerId(downloaded, stored.selectedServerId);
  }
  storeSubscriptions(saved);
  if (active && sourceChanged) {
    state.selectedServerId = stored.selectedServerId;
    serverLatencies = new Map();
  }
  await saveState();
  if (active && sourceChanged && tunnelRunning) await startTunnel();
  else pushState();
  return publicState();
}

async function deleteSubscription(id) {
  const saved = subscriptions();
  const index = saved.findIndex((item) => item.id === String(id || ''));
  if (index < 0) throw new Error('Подписка не найдена.');
  const removed = saved[index];
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Удалить подписку?',
    message: `Удалить «${removed.name}»?`,
    detail: 'Ссылка, ключ и сохранённый список серверов этой подписки будут удалены.',
    buttons: ['Удалить', 'Отмена'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (confirmation.response !== 0) return publicState();

  const wasActive = removed.id === state.activeSubscriptionId;
  const tunnelRunning = isTunnelActive();
  saved.splice(index, 1);
  storeSubscriptions(saved);
  if (wasActive) {
    const next = saved.find(item => !item.hidden) || saved[0];
    state.activeSubscriptionId = next?.id || '';
    state.selectedServerId = next ? chooseServerId(next.servers, next.selectedServerId) : '';
    if (next) { next.selectedServerId = state.selectedServerId; next.hidden = false; }
    serverLatencies = new Map();
    storeSubscriptions(saved);
  }
  await saveState();
  if (wasActive && tunnelRunning) {
    if (saved.length) await startTunnel();
    else await stopTunnel({ immediate: true });
  } else pushState();
  return publicState();
}

async function selectSubscription(id) {
  const saved = subscriptions();
  const selectedSubscription = saved.find((item) => item.id === id);
  if (!selectedSubscription) throw new Error('Подписка не найдена.');
  if (selectedSubscription.id === state.activeSubscriptionId) return publicState();

  const tunnelRunning = isTunnelActive();
  selectedSubscription.selectedServerId = chooseServerId(
    selectedSubscription.servers,
    selectedSubscription.selectedServerId
  );
  selectedSubscription.hidden = false;
  storeSubscriptions(saved);
  state.activeSubscriptionId = selectedSubscription.id;
  state.selectedServerId = selectedSubscription.selectedServerId;
  serverLatencies = new Map();
  await saveState();
  if (tunnelRunning) await startTunnel();
  else pushState();
  return publicState();
}

async function refreshSubscription({ automatic = false } = {}) {
  if (subscriptionUpdateInFlight) return publicState();
  subscriptionUpdateInFlight = true;
  try {
  const active = activeSubscription();
  const url = active?.source || subscriptionUrl();
  if (!active || !url) throw new Error('Сначала добавьте подписку.');
  const operationId = tunnelOperationId;
  const downloaded = await downloadSubscription(url);
  const saved = subscriptions();
  const storedActive = saved.find((item) => item.id === active.id);
  if (!storedActive || storedActive.source !== url || state.activeSubscriptionId !== active.id
      || operationId !== tunnelOperationId) return publicState();
  const tunnelRunning = isTunnelActive();
  if (automatic && tunnelRunning) {
    const previous = storedActive.servers.find(item => item.id === state.selectedServerId);
    const replacement = downloaded.find(item => item.id === state.selectedServerId);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(replacement)) {
      storedActive.metadata = downloaded.metadata || {};
      storedActive.updatedAt = Date.now();
      storeSubscriptions(saved); await saveState(); pushState();
      log('Обновление подписки отложено: параметры работающего сервера изменились.');
      return publicState();
    }
  }
  storedActive.metadata = downloaded.metadata || {};
  storedActive.updatedAt = Date.now();
  if (JSON.stringify(storedActive.servers) === JSON.stringify(downloaded)) {
    storeSubscriptions(saved); await saveState(); pushState();
    return publicState();
  }

  storedActive.servers = downloaded;
  storedActive.selectedServerId = chooseServerId(downloaded, storedActive.selectedServerId);
  storeSubscriptions(saved);
  state.selectedServerId = storedActive.selectedServerId;
  serverLatencies = new Map();
  await saveState();
  if (tunnelRunning && !automatic) await startTunnel();
  else pushState();
  if (automatic) log(`Список серверов автоматически обновлён: ${downloaded.length}.`);
  return publicState();
  } finally { subscriptionUpdateInFlight = false; }
}

async function autoRefreshSubscription() {
  if (!activeSubscription() || ['connecting', 'disconnecting', 'reconnecting'].includes(state.status)) return;
  try { await refreshSubscription({ automatic: true }); }
  catch { log('Не удалось автоматически обновить подписку. Сохранён прежний список серверов.'); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'Temple Tunnel',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await loadState();
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption unavailable');
    fileLog = await createFileLog(path.join(app.getPath('userData'), 'logs'), {
    protect: value => safeStorage.encryptString(value),
    unprotect: value => safeStorage.decryptString(value),
    onError: () => {
      state.logs.push('Не удалось сохранить журнал на диск.');
      scheduleLogPush();
    }
  });
  } catch {
    log('Зашифрованный журнал недоступен. Запись на диск отключена.');
  }
  log(`Запуск Temple Tunnel ${app.getVersion()}; PID ${process.pid}.`);
  if (process.platform === 'win32') app.setAppUserModelId('local.templetunnel.app');
  const availableServers = servers();
  const normalizedServerId = chooseServerId(availableServers, state.selectedServerId);
  if (normalizedServerId !== state.selectedServerId) {
    state.selectedServerId = normalizedServerId;
    const saved = subscriptions();
    const active = saved.find((item) => item.id === state.activeSubscriptionId);
    if (active) {
      active.selectedServerId = normalizedServerId;
      storeSubscriptions(saved);
    }
    await saveState();
  }

  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('subscription:set', async (_event, input) => addSubscription(
    typeof input === 'string' ? { source: input } : (input || {})
  ));
  ipcMain.handle('subscription:update', async (_event, input) => updateSubscription(input || {}));
  ipcMain.handle('subscription:delete', async (_event, id) => deleteSubscription(String(id || '')));
  ipcMain.handle('subscription:select', async (_event, id) => selectSubscription(String(id || '')));
  ipcMain.handle('subscription:refresh', () => refreshSubscription());
  ipcMain.handle('update:install', async () => {
    if (updateBusy) throw new Error('Дождитесь завершения текущего обновления.');
    updateBusy = true;
    try {
      const selected = await dialog.showOpenDialog(mainWindow,{title:'Подписанный пакет обновления',properties:['openFile'],filters:[{name:'Манифест обновления',extensions:['json']}]});
      if (selected.canceled) return 'Отменено.';
      const generation = await signedUpdates.stage(selected.filePaths[0]);
      if (generation.manifest.kind === 'app') return await launchSignedInstaller(generation);
      await checkCoreUpdate(generation);
      const running = isTunnelActive();
      await stopTunnel({immediate:true});
      updatedCores = await signedUpdates.activate(generation);
      if (running) {
        try { await startTunnel(); }
        catch { /* Connection status is checked below before retaining the update. */ }
        if (state.status !== 'connected') {
          await stopTunnel({immediate:true});
          updatedCores = await signedUpdates.rollbackCores();
          await startTunnel();
          return 'Соединение на новых ядрах не подтверждено. Восстановлена предыдущая версия.';
        }
      }
      else if (state.killSwitch === 'always' || networkGuard?.active) await armGuard();
      return 'Подписанные ядра установлены. Предыдущая версия сохранена для отката.';
    } finally { updateBusy = false; }
  });
  ipcMain.handle('update:rollback', async () => {
    if (updateBusy) throw new Error('Дождитесь завершения текущего обновления.');
    updateBusy = true;
    try {
      const selected = await dialog.showMessageBox(mainWindow,{type:'question',message:'Какое обновление откатить?',buttons:['Ядра VPN','Приложение','Отмена'],defaultId:2,cancelId:2});
      if (selected.response === 2) return 'Отменено.';
      if (selected.response === 1) {
        const previous = await signedUpdates.previous('app');
        if (!previous) throw new Error('Предыдущий подписанный установщик ещё не сохранён.');
        return await launchSignedInstaller(previous);
      }
      if (!await signedUpdates.current('cores')) throw new Error('Обновлённые ядра не установлены.');
      const previous = await signedUpdates.previous('cores');
      if (previous) await checkCoreUpdate(previous);
      const running = isTunnelActive(); await stopTunnel({immediate:true});
      updatedCores = await signedUpdates.rollbackCores();
      if (running) await startTunnel();
      else if (state.killSwitch === 'always' || networkGuard?.active) await armGuard();
      return updatedCores ? 'Восстановлена предыдущая версия ядер.' : 'Восстановлены ядра из установщика приложения.';
    } finally { updateBusy = false; }
  });
  ipcMain.handle('network:diagnose', async () => {
    const port = activeHealthPort;
    if (!port || state.status !== 'connected') return 'Сначала подключите VPN. Проверка использует локальный выход VPN и не подтверждает отсутствие утечек всех приложений.';
    const [tls, dns, guard] = await Promise.all([
      checkTunnelConnectivity(port, 5000), require('./dns-health').checkDns(port, 5000),
      networkGuard?.inspect().catch(() => null)
    ]);
    if (activeHealthPort !== port) return 'Подключение изменилось во время проверки. Повторите проверку.';
    const tun = Object.entries(os.networkInterfaces()).find(([name]) => name === activeTunName)?.[1] || [];
    return `Выход VPN: ${tls.status === 'ok' ? 'доступен' : 'ошибка'}. DNS через VPN: ${dns.status === 'ok' ? 'работает' : 'ошибка'}. IPv6-интерфейс: ${tun.some(a => a.family === 'IPv6') ? 'есть' : 'не обнаружен'}. Kill switch: ${guard === null ? 'не удалось проверить' : guard ? 'активен' : 'выключен'}. Это проверка VPN-выхода; для проверки утечек конкретного приложения нужен отдельный сетевой тест.`;
  });
  ipcMain.handle('subscription:import-file', async (_event, image) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: image ? 'Загрузить картинку с QR-кодом' : 'Импортировать список ключей',
      properties: ['openFile'], filters: image ? [{ name: 'Изображения', extensions: ['png','jpg','jpeg'] }]
        : [{ name: 'Подписка или ключи', extensions: ['txt','conf','list'] }] });
    if (result.canceled) return null;
    return readImport(result.filePaths[0], Boolean(image), nativeImage);
  });
  ipcMain.handle('subscription:organize', async (_event, change) => {
    storeSubscriptions(organizeSubscriptions(subscriptions(), state.activeSubscriptionId, change));
    await saveState(); pushState(); return publicState();
  });
  ipcMain.handle('servers:ping', () => refreshServerLatencies());
  ipcMain.handle('recovery:cancel', async () => {
    cancelAutomaticRecovery({ clearWarning: false });
    await manualDisconnect();
    state.status = 'disconnected';
    state.error = '';
    state.warning = 'Автоматическое переподключение остановлено пользователем.';
    pushState();
    return publicState();
  });
  ipcMain.handle('apps:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите приложения',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Приложения Windows', extensions: ['exe'] }]
    });
    if (result.canceled) return publicState();
    const shouldRestart = isTunnelActive();
    const target = state.mode === 'bypass' ? state.bypassApplications : state.selectedApplications;
    const knownProcesses = new Set(target.map(applicationIdentity).filter(Boolean));
    let changed = false;
    for (const filePath of result.filePaths) {
      const processName = path.basename(filePath);
      const identity = processName.toLowerCase();
      const existing = target.find(item => applicationIdentity(item) === identity);
      if (existing && existing.path !== filePath) { existing.path = filePath; existing.custom = true; changed = true; }
      if (!knownProcesses.has(identity)) {
        target.push({
          name: path.basename(filePath, '.exe'),
          processName,
          path: filePath,
          custom: true
        });
        knownProcesses.add(identity);
        changed = true;
      }
    }
    if (!changed) return publicState();
    await saveState();
    if (shouldRestart) await startTunnel();
    else { if (state.killSwitch === 'always' || networkGuard?.active) await armGuard(); pushState(); }
    return publicState();
  });
  ipcMain.handle('apps:remove', async (_event, appPath) => {
    const shouldRestart = isTunnelActive();
    const listKey = state.mode === 'bypass' ? 'bypassApplications' : 'selectedApplications';
    const previousLength = state[listKey].length;
    const next = state[listKey].filter((item) => (item.path || item.processName) !== appPath);
    if (state.killSwitch !== 'off' && state.mode === 'selected' && !next.length) throw new Error('Сначала отключите Kill switch или добавьте другое приложение.');
    state[listKey] = next;
    if (state[listKey].length === previousLength) return publicState();
    await saveState();
    if (shouldRestart) await startTunnel();
    else { if (state.killSwitch === 'always' || networkGuard?.active) await armGuard(); pushState(); }
    return publicState();
  });
  ipcMain.handle('apps:toggle', async (_event, application) => {
    if (state.mode !== 'selected') return publicState();
    const shouldRestart = isTunnelActive();
    const key = applicationIdentity(application);
    if (!key) throw new Error('Не удалось определить имя процесса приложения.');
    const exists = state.selectedApplications.some((item) => applicationIdentity(item) === key);
    if (state.killSwitch !== 'off' && !exists) throw new Error('При включённом Kill switch добавляйте приложения через кнопку «Добавить», указав EXE-файл.');
    if (state.killSwitch !== 'off' && exists && state.selectedApplications.length === 1) throw new Error('Сначала отключите Kill switch или добавьте другое приложение.');
    if (exists) {
      state.selectedApplications = state.selectedApplications.filter((item) => applicationIdentity(item) !== key);
    } else {
      state.selectedApplications.push({
        name: String(application.name),
        processName: applicationProcessName(application),
        path: application.path ? String(application.path) : '',
        custom: Boolean(application.custom)
      });
    }
    await saveState();
    if (shouldRestart) await startTunnel();
    else { if (state.killSwitch === 'always' || networkGuard?.active) await armGuard(); pushState(); }
    return publicState();
  });
  ipcMain.handle('settings:update', async (_event, update) => {
    // Validate all new fields before mutating any preferences.
    const customRouting = update.customRouting === undefined ? undefined : normalizeRouting(update.customRouting);
    const dnsPreset = update.dnsPreset === undefined ? undefined : normalizeDns(update.dnsPreset);
    const killSwitch = update.killSwitch === undefined ? state.killSwitch : normalizeKillSwitch(update.killSwitch);
    const ipv6Policy = update.ipv6Policy === undefined ? state.ipv6Policy : normalizeIpv6(update.ipv6Policy);
    const dnsPolicy = update.dnsPolicy === undefined ? state.dnsPolicy : normalizeDnsPolicy(update.dnsPolicy);
    if (killSwitch !== 'off') guardArguments({ ...state, ...update, customRouting: customRouting || state.customRouting }, guardCores());
    const tunnelRunning = isTunnelActive();
    let routingChanged = false;
    let preferenceChanged = false;
    if (killSwitch !== state.killSwitch || (killSwitch === 'off' && networkGuard?.active)) {
      if (killSwitch === 'off') await networkGuard?.clear();
      else if (killSwitch === 'always' || tunnelRunning) {
        if (!networkGuard) throw new Error('Системная защита недоступна.');
        await networkGuard.apply({ ...state, ...update, killSwitch, customRouting: customRouting || state.customRouting }, guardCores(), tunnelRunning ? activeTunName : '-');
      }
      state.killSwitch = killSwitch; routingChanged = true;
    }
    if (ipv6Policy !== state.ipv6Policy) { state.ipv6Policy = ipv6Policy; routingChanged = true; }
    if (dnsPolicy !== state.dnsPolicy) { state.dnsPolicy = dnsPolicy; routingChanged = true; }
    if (customRouting && JSON.stringify(customRouting) !== JSON.stringify(state.customRouting)) {
      state.customRouting = customRouting; routingChanged = true;
    }
    if (dnsPreset !== undefined && dnsPreset !== state.dnsPreset) {
      state.dnsPreset = dnsPreset; routingChanged = true;
    }
    if (['auto', 'manual'].includes(update.connectionStrategy) && update.connectionStrategy !== state.connectionStrategy) {
      state.connectionStrategy = update.connectionStrategy;
      preferenceChanged = true;
      // A healthy tunnel stays in place when only the selection policy changes.
      routingChanged ||= ['connecting', 'reconnecting'].includes(state.status);
    }
    if (typeof update.russianSitesViaVpn === 'boolean' && update.russianSitesViaVpn !== state.russianSitesViaVpn) {
      state.russianSitesViaVpn = update.russianSitesViaVpn;
      routingChanged ||= state.mode === 'full';
    }
    if (['full', 'selected', 'bypass'].includes(update.mode) && update.mode !== state.mode) {
      state.mode = update.mode;
      routingChanged = true;
    }
    if (typeof update.selectedServerId === 'string') {
      const selected = servers().find((item) => item.id === update.selectedServerId);
      if (!selected) throw new Error('Выбранный сервер не найден. Обновите подписку.');
      if (!isSupportedTransport(selected.transport)) {
        throw new Error(`${String(selected.transport).toUpperCase()} пока не поддерживается встроенным VPN-движком. Выберите сервер TCP/REALITY из списка.`);
      }
      if (state.connectionStrategy !== 'manual') {
        state.connectionStrategy = 'manual';
        preferenceChanged = true;
        routingChanged ||= ['connecting', 'reconnecting'].includes(state.status);
      }
      if (state.selectedServerId !== update.selectedServerId) {
        state.selectedServerId = update.selectedServerId;
        const saved = subscriptions();
        const active = saved.find((item) => item.id === state.activeSubscriptionId);
        if (active) {
          active.selectedServerId = update.selectedServerId;
          storeSubscriptions(saved);
        }
        routingChanged = true;
      }
    }
    if (!routingChanged && !preferenceChanged) return publicState();
    await saveState();
    if (tunnelRunning && routingChanged) await startTunnel();
    else {
      if (state.killSwitch === 'always' || (state.killSwitch !== 'off' && networkGuard?.active)) await armGuard();
      scheduleReserveCheck(); pushState();
    }
    return publicState();
  });
  ipcMain.handle('tunnel:toggle', async () => {
    if (isTunnelActive()) {
      await manualDisconnect();
    } else {
      await startTunnel();
    }
    return publicState();
  });
  ipcMain.handle('logs:open', async () => {
    const directory = path.join(app.getPath('userData'), 'logs');
    await fsp.mkdir(directory, { recursive: true });
    return shell.openPath(directory);
  });
  ipcMain.handle('logs:export', async () => {
    if (!fileLog) throw new Error('Зашифрованный журнал недоступен.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт очищенного журнала',
      defaultPath: `Temple-Tunnel-log-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Текстовый журнал', extensions: ['txt'] }]
    });
    if (!result.canceled && result.filePath) {
      await fsp.writeFile(result.filePath, await fileLog.exportText(), { mode: 0o600 });
      shell.showItemInFolder(result.filePath);
    }
  });

  signedUpdates = createUpdates(path.join(app.getPath('userData'),'updates'),await fsp.readFile(path.join(__dirname,'release-public.pem')),
    require('../package.json').version);
  try { updatedCores = await signedUpdates.current('cores'); }
  catch { state.warning = 'Сохранённое обновление не прошло проверку. Используются ядра из установщика.'; }
  const guardExecutable = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'network-guard.exe')
    : path.join(__dirname, '..', 'vendor', 'network-guard', 'network-guard.exe');
  networkGuard = createGuard(guardExecutable);
  try {
    await networkGuard.inspect();
    if (state.killSwitch === 'always') await armGuard();
    else if (networkGuard.active) state.warning = 'После предыдущего завершения осталась блокировка Kill switch. Подключите VPN или отключите Kill switch в настройках.';
  } catch (error) { state.warning = error.message; }
  createWindow();
  void refreshRussianRules();
  void autoRefreshSubscription();
  subscriptionTimer = setInterval(() => void autoRefreshSubscription(), 60 * 60 * 1000);
  subscriptionTimer.unref?.();
  healthTimer = setInterval(() => void checkActiveTunnelHealth(), 10000);
  healthTimer.unref?.();
  powerMonitor?.on('suspend', () => { networkSuspended = true; void pauseForNetwork(); });
  powerMonitor?.on('resume', () => { networkSuspended = false; networkStableAt = Date.now(); });
  networkTimer = setInterval(() => void pollNetwork().catch(() => {}), 2000);
  networkTimer.unref?.();
  void pollNetwork();
});

let logFlushedOnQuit = false;
let logFlushInProgress = false;
app.on('before-quit', (event) => {
  if ((fileLog || selectionInFlight || latencyRefreshInFlight) && !logFlushedOnQuit) {
    event.preventDefault();
    if (!logFlushInProgress) {
      logFlushInProgress = true;
      tunnelOperationId += 1;
      connectionController?.abort();
      latencyController?.abort();
      log('Завершение приложения.');
      Promise.allSettled([selectionInFlight, latencyRefreshInFlight])
        .then(async () => {
          await stopTunnel({ immediate: true });
          if (state.killSwitch === 'session') await networkGuard?.clear();
          else if (state.killSwitch === 'always') await armGuard();
          await fileLog?.flush();
        }).catch(() => {}).finally(() => { logFlushedOnQuit = true; app.quit(); });
    }
    return;
  }
  clearInterval(subscriptionTimer);
  clearTimeout(networkRetryTimer);
  clearTimeout(reserveTimer);
  reserveController?.abort();
  clearInterval(networkTimer);
  networkReconnect = false;
  tunnelOperationId += 1;
  connectionController?.abort();
  latencyController?.abort();
  cancelAutomaticRecovery();
  if (logPushTimer) {
    clearTimeout(logPushTimer);
    logPushTimer = undefined;
  }
  activeHealthPort = 0;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = undefined;
  }
  if (coreProcess) {
    try {
      if (coreProcess.gracefulHost) coreProcess.stdin.end('stop\n');
      else coreProcess.kill('SIGTERM');
    } catch {}
    coreProcess = null;
  }
  if (xrayProcess) {
    try { xrayProcess.kill('SIGTERM'); } catch {}
    xrayProcess = null;
  }
  if (coreConfigPath) {
    try { fs.rmSync(coreConfigPath, { force: true }); } catch {}
    coreConfigPath = undefined;
  }
  if (xrayConfigPath) {
    try { fs.rmSync(xrayConfigPath, { force: true }); } catch {}
    xrayConfigPath = undefined;
  }
});

app.on('window-all-closed', () => app.quit());
