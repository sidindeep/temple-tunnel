const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
function guardError(error, action) {
  const stage = action === 'status' ? 'проверить' : 'применить';
  const match = String(error.stderr || '').match(/WFP error (?:[a-z-]+: )?(\d+)/);
  const code = match ? Number(match[1]) : undefined;
  if (code === 5) return new Error(`Не удалось ${stage} системную защиту: Windows отказала в доступе. Запустите приложение от администратора.`);
  if (error.code === 'ENOENT') return new Error('Модуль системной защиты не найден. Восстановите установку приложения.');
  if (code === 0x80320004) return new Error('Ошибка модуля системной защиты: указан неизвестный слой WFP. Обновите приложение.');
  return new Error(`Не удалось ${stage} системную защиту.${code === undefined ? ' Проверьте установку приложения и службу BFE Windows.' : ` Код Windows: ${code}.`}`);
}
function applicationPaths(applications) {
  return [...new Set(applications.map(item => {
    if (!item.path || !path.win32.isAbsolute(item.path) || !/\.exe$/i.test(item.path))
      throw new Error(`Для Kill switch добавьте EXE-файл приложения «${item.name || item.processName}» кнопкой «Добавить».`);
    return item.path;
  }))];
}
function guardArguments(state, corePaths, tun = '-') {
  const mode = state.mode;
  // Domain rules cannot be reproduced by a process firewall without stale DNS
  // exemptions. Protect the whole device if they add VPN traffic in selected mode.
  const effectiveMode = mode === 'selected' && state.customRouting?.proxy?.length ? 'full' : mode;
  const allow = [...corePaths];
  if (mode === 'bypass') allow.push(...applicationPaths(state.bypassApplications));
  const protect = effectiveMode === 'selected' ? applicationPaths(state.selectedApplications) : [];
  if (effectiveMode === 'selected' && !protect.length) throw new Error('Для Kill switch выберите приложения и их EXE-файлы.');
  return ['apply', effectiveMode, tun, ...allow.flatMap(p => ['--allow',p]), ...protect.flatMap(p => ['--protect',p])];
}
function createGuard(executable, execute = run) {
  let queue = Promise.resolve(), active = false, known = false;
  function command(args) {
    const pending = queue.catch(() => {}).then(async () => {
      try { return await execute(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 16384 }); }
      catch (error) { throw guardError(error, args[0]); }
    });
    queue = pending; return pending;
  }
  return {
    get active() { return active; },
    get known() { return known; },
    async inspect() {
      try {
        const status = (await command(['status'])).stdout.trim();
        if (!['active','off'].includes(status)) throw new Error('Некорректный ответ системной защиты.');
        active = status === 'active'; known = true; require('./bootstrap-dns').setProtectedDns(active); return active;
      } catch (error) { known = false; throw error; }
    },
    async apply(state, cores, tun) { await command(guardArguments(state,cores,tun)); active = true; known = true; require('./bootstrap-dns').setProtectedDns(true); },
    async clear() { await command(['clear']); active = false; known = true; require('./bootstrap-dns').setProtectedDns(false); }
  };
}
module.exports = { createGuard, guardArguments, applicationPaths, guardError };
