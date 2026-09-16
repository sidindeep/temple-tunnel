const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

function sanitizeLog(message) {
  return String(message)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:vless|hysteria2|hy2):\/\/\S+/gi, '[VPN PROFILE]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:authorization|[\w-]*token|[\w-]*password|uuid|privateKey|publicKey|shortId)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[UUID]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .trim();
}

async function createFileLog(directory, { protect, unprotect, maxBytes = 5 * 1024 * 1024, backups = 3, days = 7, onError = () => {} } = {}) {
  if (!protect || !unprotect) throw new Error('Защита Windows недоступна.');
  await fs.mkdir(directory, { recursive: true });
  const keyFile = path.join(directory, 'journal-key.dpapi');
  let key;
  try { key = Buffer.from(unprotect(await fs.readFile(keyFile)), 'base64'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не удалось открыть ключ журнала.');
    key = crypto.randomBytes(32);
    await fs.writeFile(keyFile, protect(key.toString('base64')), { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('Неверный ключ журнала.');
  const file = path.join(directory, 'temple-tunnel.enc');
  const files = Array.from({ length: backups + 1 }, (_, i) => i ? `${file}.${i}` : file);
  let queue = Promise.resolve(), timer, pending = [], reported = false;
  async function prune() {
    for (const name of files) {
      try {
        const stat = await fs.stat(name);
        if (Math.min(stat.birthtimeMs, stat.mtimeMs) < Date.now() - days * 86400000) await fs.rm(name);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await prune();
  function enqueue(work) {
    queue = queue.then(work).catch(() => { if (!reported) onError(); reported = true; });
    return queue;
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    const batch = pending; pending = [];
    if (!batch.length) return queue;
    return enqueue(async () => {
      await prune();
      for (const item of batch) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(item), 'utf8'), cipher.final()]);
        const line = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64') + '\n';
        let size = 0;
        try { size = (await fs.stat(file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (size && size + Buffer.byteLength(line) > maxBytes) {
          for (let i = backups; i >= 1; i--) {
            await fs.rm(files[i], { force: true });
            try { await fs.rename(files[i - 1], files[i]); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
        }
        await fs.appendFile(file, line, { mode: 0o600 });
      }
      reported = false;
    });
  }
  return {
    write(message) {
      const clean = sanitizeLog(message).slice(0, Math.min(4096, Math.max(32, Math.floor(maxBytes / 12))));
      if (!clean) return;
      if (pending.length >= 1000) return; // Bound memory under a burst of core errors.
      pending.push({ time: new Date().toISOString(), message: clean });
      if (!timer) { timer = setTimeout(flush, 250); timer.unref?.(); }
    },
    flush,
    async exportText() {
      await flush();
      const rows = [];
      // Serialize reading with rotation/writes to keep export consistent.
      const job = queue.then(async () => {
        for (const name of [...files].reverse()) {
          let content;
          try { content = await fs.readFile(name, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          for (const line of content.split('\n').filter(Boolean)) {
            try {
              const data = Buffer.from(line, 'base64');
              const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
              decipher.setAuthTag(data.subarray(12, 28));
              const item = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
              if (Date.parse(item.time) >= Date.now() - days * 86400000) rows.push(`${item.time}  ${sanitizeLog(item.message)}`);
            } catch { rows.push('[Повреждённая запись пропущена]'); }
          }
        }
      });
      queue = job.catch(() => {});
      await job;
      return rows.join('\n') + '\n';
    }
  };
}

// Persist categories only; never pass raw core output or configuration into the journal.
function isLocalCoreFailure(message) {
  const text = String(message);
  if (!/error|fatal|fail|denied|not permitted|cannot/i.test(text)) return false;
  return /create adapter|open existing adapter|configure tun|create tun|open tun|initialize wintun/i.test(text)
    || (/fatal/i.test(text) && /start service|wintun|tun interface|listen/i.test(text));
}

function coreDiagnostic(message) {
  const text = String(message).replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
  if (/create adapter|open existing adapter/.test(text) && /already exists|not found/.test(text)) return 'Windows ещё освобождает предыдущий VPN-адаптер: конфликт создания Wintun.';
  if (/open interface.*too much time/.test(text)) return 'Windows задерживает открытие VPN-адаптера.';
  if (/authentication failed|invalid user|invalid password/.test(text)) return 'Сервер отклонил авторизацию.';
  if (isLocalCoreFailure(text)) return 'Ошибка создания или запуска локального VPN-интерфейса.';
  if (/operation not permitted|access is denied/.test(text)) return 'Сетевая операция отклонена; это не подтверждает ошибку запуска VPN-интерфейса.';
  if (/timeout|timed out|deadline exceeded/.test(text)) return 'Истёк тайм-аут сетевого запроса.';
  if (/connection refused|actively refused/.test(text)) return 'Соединение отклонено.';
  if (/connection reset|forcibly closed|wsarecv/.test(text)) return 'Удалённая сторона сбросила отдельное соединение; это не означает отключение всего VPN.';
  if (/network is unreachable|network unreachable|no route to host|host is unreachable|unreachable network/.test(text)) return 'Нет сетевого маршрута до адреса назначения.';
  if (/no such host|name resolution|server misbehaving|nxdomain|dns.*(?:failed|error)/.test(text)) return 'Ошибка DNS: не удалось получить адрес сайта или сервера.';
  if (/context canceled|context cancelled|operation was canceled|operation canceled/.test(text)) return 'Сетевой запрос отменён приложением или при переключении соединения.';
  if (/connection closed|closed network connection|closed by (?:remote|peer)|stream.*canceled|\beof\b|broken pipe/.test(text)) return 'Отдельное соединение или поток закрыт; это не означает отключение всего VPN.';
  if (/quic.*(?:error|fail)|application error|transport error/.test(text)) return 'Ошибка транспорта QUIC/Hysteria2.';
  if (/tls|handshake|certificate/.test(text) && /error|fail/.test(text)) return 'Ошибка TLS/рукопожатия.';
  if (/error|fatal/.test(text)) {
    // Only fixed, allowlisted labels leave this function, never raw addresses or secrets.
    const area = /\bdns\b/.test(text) ? 'DNS' : /inbound\/tun|wintun|tun interface/.test(text) ? 'TUN'
      : /\bquic\b|hysteria2/.test(text) ? 'QUIC/Hysteria2' : /\btls\b/.test(text) ? 'TLS'
      : /\boutbound\b/.test(text) ? 'исходящее соединение' : /\binbound\b/.test(text) ? 'входящее соединение' : 'не определён';
    return `${/\bfatal\b/.test(text) ? 'Критическая ошибка' : 'Неклассифицированная ошибка'}; компонент: ${area}. Причина пока не распознана диагностикой.`;
  }
  if (/started|listening/.test(text)) return 'Ядро запущено / порт открыт.';
  return '';
}

// stdout/stderr chunks are not lines. Keep an independent, bounded decoder for each stream.
function attachCoreLogReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '', overflow = false;
  function consume(text, end = false) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!overflow) {
        pending += part;
        if (pending.length > 16384) { pending = ''; overflow = true; }
      }
      if (part.endsWith('\n')) {
        onLine(overflow ? 'ERROR diagnostic line exceeded limit' : pending.trimEnd());
        pending = ''; overflow = false;
      }
    }
    if (end && (pending || overflow)) {
      onLine(overflow ? 'ERROR diagnostic line exceeded limit' : pending);
      pending = ''; overflow = false;
    }
  }
  stream.on('data', chunk => consume(decoder.write(chunk)));
  stream.on('end', () => consume(decoder.end(), true));
}
module.exports = { createFileLog, sanitizeLog, coreDiagnostic, isLocalCoreFailure, attachCoreLogReader };
