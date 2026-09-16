const { connectionError } = require('./connection-errors');

const HISTORY_TTL = 24 * 60 * 60 * 1000;
function hedgeDelay(recent, automatic = false, now = Date.now()) {
  if (automatic || !recent?.successAt || recent.failures || now - recent.successAt >= HISTORY_TTL) return 0;
  // Account for local process startup as well as TLS latency; cap the wait on a stale favorite.
  return Math.min(1000, Math.max(350, Math.round((recent.ms || 0) * 1.5 + 300)));
}

function recordResult(history, id, result, now = Date.now()) {
  if (result.status === 'cancelled' || result.reason === 'local') return;
  const previous = history[id] || {};
  if (result.status === 'ok') {
    history[id] = { failures: 0, checkedAt: now, successAt: now,
      ms: Number.isFinite(previous.ms) ? Math.round(previous.ms * 0.7 + result.ms * 0.3) : result.ms,
      cooldownUntil: 0 };
  } else {
    const failures = Math.min(6, (previous.failures || 0) + 1);
    const duration = result.reason === 'auth' || result.status === 'auth-error' ? 60000
      : failures >= 2 ? Math.min(120000, 15000 * 2 ** (failures - 2)) : 0;
    history[id] = { ...previous, failures, checkedAt: now, cooldownUntil: now + duration };
  }
}

function rankCandidates(servers, { selectedId, lastSuccessfulId, history = {}, failedIds = new Set(), now = Date.now() } = {}) {
  const recent = id => now - (history[id]?.checkedAt || 0) < HISTORY_TTL ? history[id] || {} : {};
  return servers.filter(server => !failedIds.has(server.id) && !(recent(server.id).cooldownUntil > now))
    .sort((a, b) => {
      const score = server => {
        const item = recent(server.id);
        const preferred = server.id === lastSuccessfulId && item.successAt && !item.failures;
        return (item.failures || 0) * 10000 + (preferred ? -20000 : server.id === selectedId ? -1000 : 0)
          + Math.min(5000, item.ms ?? 2000);
      };
      return score(a) - score(b);
    });
}

// Workers test local proxies only. All workers finish cleanup before returning a winner.
async function selectWorkingServer(candidates, probe, { signal, concurrency = 3, hedgeMs = 350,
  budgetMs = 15000, onResult = () => {} } = {}) {
  if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
  if (!candidates.length) throw connectionError('NO_CANDIDATES', 'Нет доступных кандидатов. Повторите подключение позже или выберите сервер вручную.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, budgetMs);
  let next = 0, winner, fatal;
  const results = [];
  let releaseBackups;
  const backups = new Promise(resolve => { releaseBackups = resolve; });
  const hedgeTimer = setTimeout(releaseBackups, hedgeMs);
  controller.signal.addEventListener('abort', releaseBackups, { once: true });
  async function worker(index) {
    if (index) await backups;
    while (!controller.signal.aborted && next < candidates.length) {
      const server = candidates[next++];
      let result;
      try { result = await probe(server, controller.signal); }
      catch (error) {
        fatal = error;
        controller.abort();
        return;
      }
      if (controller.signal.aborted) return;
      results.push({ server, result });
      try { onResult(server, result); }
      catch (error) { fatal = error; controller.abort(); return; }
      if (result.status === 'ok') {
        winner = { server, result };
        controller.abort();
        return;
      }
      if (result.reason === 'local') {
        fatal = connectionError('ENGINE_FAILED', 'Не удалось запустить локальный VPN-движок. Проверьте установку приложения.');
        controller.abort();
        return;
      }
      releaseBackups();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), candidates.length) }, (_, i) => worker(i)));
    if (signal?.aborted) throw connectionError('ABORT_ERR', 'Подключение отменено.');
    if (fatal) throw fatal;
    if (winner) return winner;
    const allFinished = results.length === candidates.length;
    const reason = allFinished && results.every(item => item.result.reason === 'auth') ? 'AUTH_FAILED'
      : allFinished && results.every(item => item.result.reason === 'dns') ? 'DNS_FAILED'
      : allFinished && results.every(item => item.result.reason === 'profile') ? 'PROFILE_INVALID' : 'NO_WORKING_SERVER';
    throw Object.assign(connectionError(reason, 'Не найден рабочий сервер за отведённое время.'), { results });
  } finally {
    clearTimeout(timer);
    clearTimeout(hedgeTimer);
    controller.abort();
    signal?.removeEventListener('abort', cancel);
  }
}

module.exports = { recordResult, rankCandidates, selectWorkingServer, hedgeDelay, HISTORY_TTL };
