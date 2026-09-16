const crypto = require('node:crypto');
const { version: APP_VERSION } = require('../package.json');

const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const SUPPORTED_TRANSPORTS = new Set(['tcp', 'grpc', 'ws', 'websocket', 'httpupgrade', 'http', 'h2', 'xhttp', 'hysteria2']);

function isSupportedTransport(transport) {
  return SUPPORTED_TRANSPORTS.has(String(transport || 'tcp').toLowerCase());
}

function parseXhttpExtra(value) {
  if (!value) return undefined;
  if (Buffer.byteLength(value, 'utf8') > 16 * 1024) {
    throw new Error('Параметры XHTTP в подписке слишком большие.');
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error('В VLESS-профиле указаны некорректные дополнительные параметры XHTTP.');
  }
}

function normalizeBase64(value) {
  const cleaned = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
}

function decodeSubscriptionBody(body) {
  const trimmed = body.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('Подписка вернула пустой ответ.');
  if (/^(vless|hysteria2|hy2|vmess|trojan|ss):\/\//im.test(trimmed)) return trimmed;

  try {
    const decoded = Buffer.from(normalizeBase64(trimmed), 'base64').toString('utf8').trim();
    if (/^(vless|hysteria2|hy2|vmess|trojan|ss):\/\//im.test(decoded)) return decoded;
  } catch {
    // Report a useful format error below.
  }

  throw new Error('Формат подписки не распознан. Поддерживаются VLESS, Hysteria 2 и их Base64-списки.');
}

function safeDecode(value, fallback = '') {
  try {
    return decodeURIComponent(value || fallback);
  } catch {
    return value || fallback;
  }
}

function isValidRealityPublicKey(value) {
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(value || '')) return false;
  try {
    return Buffer.from(normalizeBase64(value), 'base64').length === 32;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function parseVlessUri(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('Некорректная VLESS-ссылка в подписке.');
  }

  if (url.protocol !== 'vless:') throw new Error('Поддерживается только протокол VLESS.');
  const uuid = safeDecode(url.username);
  const port = Number(url.port || 443);
  if (!uuid || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VLESS-профиль не содержит корректный UUID, адрес или порт.');
  }

  const q = url.searchParams;
  const transport = (q.get('type') || 'tcp').toLowerCase();
  const security = (q.get('security') || 'none').toLowerCase();
  const name = safeDecode(url.hash.slice(1), `${url.hostname}:${port}`);
  const xhttpExtra = transport === 'xhttp' ? parseXhttpExtra(q.get('extra')) : undefined;

  const server = {
    id: crypto.createHash('sha256').update(uri).digest('hex').slice(0, 24),
    name,
    protocol: 'vless',
    host: url.hostname,
    port,
    uuid,
    flow: q.get('flow') || '',
    encryption: q.get('encryption') || 'none',
    security,
    transport,
    serverName: q.get('sni') || q.get('serverName') || url.hostname,
    fingerprint: q.get('fp') || 'chrome',
    publicKey: q.get('pbk') || q.get('publicKey') || '',
    shortId: q.get('sid') || q.get('shortId') || '',
    serviceName: q.get('serviceName') || q.get('service_name') || '',
    authority: q.get('authority') || '',
    path: q.get('path') || '',
    hostHeader: q.get('host') || '',
    alpn: (q.get('alpn') || '').split(',').map((item) => item.trim()).filter(Boolean),
    spiderX: q.get('spx') || q.get('spiderX') || '/',
    xhttpMode: q.get('mode') || xhttpExtra?.mode || 'auto',
    xhttpExtra,
    allowInsecure: ['1', 'true'].includes((q.get('allowInsecure') || q.get('insecure') || '').toLowerCase()),
    packetEncoding: q.get('packetEncoding') || q.get('packet_encoding') || 'xudp'
  };

  if (isLoopbackHost(server.host)) {
    throw new Error('Подписка вернула служебную заглушку вместо VPN-сервера (локальный адрес). Получите у провайдера стандартную VLESS-подписку для сторонних клиентов.');
  }
  if (server.security === 'reality' && !isValidRealityPublicKey(server.publicKey)) {
    throw new Error('В REALITY-профиле указан некорректный публичный ключ. Получите у провайдера стандартную VLESS-подписку для сторонних клиентов.');
  }

  return server;
}

function parseHysteria2Uri(uri) {
  let url;
  try { url = new URL(uri); } catch { throw new Error('Некорректная ссылка Hysteria 2.'); }
  if (!['hysteria2:', 'hy2:'].includes(url.protocol)) throw new Error('Ожидается профиль Hysteria 2.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 443);
  const password = safeDecode(url.username) + (url.password ? `:${safeDecode(url.password)}` : '');
  if (!host || !password || !Number.isInteger(port) || port < 1 || port > 65535 || isLoopbackHost(host)) {
    throw new Error('Некорректный адрес, порт или пароль Hysteria 2.');
  }
  const q = url.searchParams;
  if (q.has('pinSHA256') || q.has('mport')) throw new Error('Профили Hysteria 2 с pinSHA256 или mport пока не поддерживаются.');
  const obfs = q.get('obfs');
  if (obfs && (obfs !== 'salamander' || !q.get('obfs-password'))) throw new Error('Некорректная маскировка Hysteria 2.');
  return {
    id: crypto.createHash('sha256').update(uri).digest('hex').slice(0, 24),
    name: safeDecode(url.hash.slice(1), `${host}:${port}`),
    protocol: 'hysteria2', transport: 'hysteria2', security: 'tls',
    host, port, password, serverName: q.get('sni') || host,
    allowInsecure: ['1','true'].includes(q.get('insecure') || ''),
    ...(obfs ? {obfs: {type: obfs, password: q.get('obfs-password')}} : {})
  };
}

function parseSubscription(body) {
  const decoded = decodeSubscriptionBody(body);
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const servers = [];
  const errors = [];
  let skipped = 0, duplicates = 0;
  const ids = new Set();

  for (const line of lines) {
    if (!/^(vless|hysteria2|hy2):\/\//i.test(line)) { skipped++; continue; }
    try {
      const server = /^vless:/i.test(line) ? parseVlessUri(line) : parseHysteria2Uri(line);
      if (ids.has(server.id)) { duplicates++; continue; }
      ids.add(server.id); servers.push(server);
    } catch (error) {
      skipped++;
      errors.push(error.message);
    }
  }

  if (!servers.length) {
    throw new Error(errors[0] || 'В подписке нет серверов VLESS или Hysteria 2.');
  }
  Object.defineProperty(servers, 'importReport', { value: { skipped, duplicates } });
  return servers;
}

function parseSubscriptionMetadata(headers) {
  const metadata = {};
  const text = String(headers.get('subscription-userinfo') || '').slice(0, 2048);
  for (const field of text.split(';')) {
    const match = field.trim().match(/^(upload|download|total|expire)\s*=\s*(\d+)$/i);
    if (!match) continue;
    const number = Number(match[2]);
    if (Number.isSafeInteger(number) && number >= 0 && (match[1].toLowerCase() !== 'expire' || number <= 253402300799))
      metadata[match[1].toLowerCase()] = number;
  }
  return metadata;
}

async function downloadSubscription(subscriptionUrl, fetchImpl = require('./bootstrap-dns').fetchWithProtection) {
  if (Buffer.byteLength(String(subscriptionUrl || ''), 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('Ссылка или VLESS-ключ слишком большие.');
  }
  let url;
  if (!/^https?:\/\//i.test(String(subscriptionUrl).trim())) return parseSubscription(subscriptionUrl);
  try {
    url = new URL(subscriptionUrl);
  } catch {
    throw new Error('Введите корректную HTTPS-ссылку подписки или VLESS-ключ.');
  }
  if (['vless:', 'hysteria2:', 'hy2:'].includes(url.protocol)) return parseSubscription(subscriptionUrl);
  if (url.protocol !== 'https:') throw new Error('Для защиты ключа разрешены только HTTPS-ссылки.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        'Accept': 'text/plain, application/octet-stream;q=0.9',
        'User-Agent': `TempleTunnel/${APP_VERSION}`
      }
    });
    if (!response.ok) throw new Error(`Сервер подписки ответил HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_SUBSCRIPTION_BYTES) throw new Error('Ответ подписки слишком большой.');
    let body;
    if (response.body) {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_SUBSCRIPTION_BYTES) { controller.abort(); throw new Error('Ответ подписки слишком большой.'); }
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks).toString('utf8');
    } else body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_SUBSCRIPTION_BYTES) throw new Error('Ответ подписки слишком большой.');
    const servers = parseSubscription(body);
    Object.defineProperty(servers, 'metadata', { value: parseSubscriptionMetadata(response.headers) });
    return servers;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер подписки не ответил за 15 секунд.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  parseSubscriptionMetadata,
  decodeSubscriptionBody,
  downloadSubscription,
  isSupportedTransport,
  parseSubscription,
  parseVlessUri,
  parseHysteria2Uri
};
