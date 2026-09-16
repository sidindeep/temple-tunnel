let currentState;
let editingSubscriptionId = '';
let subscriptionRequestInFlight = false;
let subscriptionRefreshInFlight = false;
let pingRequestInFlight = false;
let powerStopInFlight = false;
let lastLogText = '';
let routingDirty = false;
const renderSignatures = { applications: '', servers: '', subscriptions: '' };

const elements = {
  nav: [...document.querySelectorAll('.nav')],
  pages: {
    home: document.getElementById('homePage'),
    subscription: document.getElementById('subscriptionPage'),
    routing: document.getElementById('routingPage'),
    logs: document.getElementById('logsPage')
  },
  statusBadge: document.getElementById('statusBadge'),
  contentGrid: document.getElementById('contentGrid'),
  applicationsPanel: document.getElementById('applicationsPanel'),
  applicationsTitle: document.getElementById('applicationsTitle'),
  applicationsHelper: document.getElementById('applicationsHelper'),
  appList: document.getElementById('applicationList'),
  emptyApps: document.getElementById('emptyApps'),
  emptyAppsTitle: document.getElementById('emptyAppsTitle'),
  emptyAppsText: document.getElementById('emptyAppsText'),
  serverList: document.getElementById('serverList'),
  emptyServers: document.getElementById('emptyServers'),
  refreshButton: document.getElementById('refreshButton'),
  pingStatus: document.getElementById('pingStatus'),
  serverFlag: document.getElementById('serverFlag'),
  selectedServerName: document.getElementById('selectedServerName'),
  selectedServerDetails: document.getElementById('selectedServerDetails'),
  powerButton: document.getElementById('powerButton'),
  warningBanner: document.getElementById('warningBanner'),
  warningText: document.getElementById('warningText'),
  cancelReconnectButton: document.getElementById('cancelReconnectButton'),
  errorBanner: document.getElementById('errorBanner'),
  subscriptionList: document.getElementById('subscriptionList'),
  emptySubscriptions: document.getElementById('emptySubscriptions'),
  subscriptionStatus: document.getElementById('subscriptionStatus'),
  refreshSubscriptionButton: document.getElementById('refreshSubscriptionButton'),
  subscriptionForm: document.getElementById('subscriptionForm'),
  subscriptionName: document.getElementById('subscriptionName'),
  subscriptionUrl: document.getElementById('subscriptionUrl'),
  subscriptionSubmitButton: document.getElementById('subscriptionSubmitButton'),
  cancelSubscriptionEditButton: document.getElementById('cancelSubscriptionEditButton'),
  modeDescription: document.getElementById('modeDescription'),
  logOutput: document.getElementById('logOutput')
};

function resetSubscriptionForm() {
  editingSubscriptionId = '';
  document.getElementById('subscriptionFormTitle').textContent = 'Добавить подписку';
  document.getElementById('subscriptionSourceLabel').textContent = 'Ссылка подписки или ключ VLESS / Hysteria 2';
  document.getElementById('subscriptionName').value = '';
  const sourceInput = document.getElementById('subscriptionUrl');
  sourceInput.value = '';
  sourceInput.classList.add('masked-secret');
  sourceInput.placeholder = 'https://…/sub/… или vless://…';
  document.getElementById('subscriptionSubmitButton').textContent = 'Добавить и загрузить серверы';
  document.getElementById('cancelSubscriptionEditButton').hidden = true;
}

function updateSubscriptionControls() {
  for (const control of elements.subscriptionForm.querySelectorAll('input, textarea, button')) {
    control.disabled = subscriptionRequestInFlight;
  }
  elements.cancelSubscriptionEditButton.hidden = !editingSubscriptionId;
  elements.refreshSubscriptionButton.disabled = subscriptionRequestInFlight
    || subscriptionRefreshInFlight
    || !(currentState?.subscriptions?.length);
  for (const button of document.querySelectorAll('.subscription-select, .subscription-tool')) {
    if (button.classList.contains('subscription-select') && button.closest('.subscription-row')?.classList.contains('active')) continue;
    button.disabled = subscriptionRequestInFlight;
  }
}

function beginSubscriptionEdit(subscription) {
  editingSubscriptionId = subscription.id;
  document.getElementById('subscriptionFormTitle').textContent = 'Редактировать подписку';
  document.getElementById('subscriptionSourceLabel').textContent = 'Новая ссылка или ключ VLESS / Hysteria 2';
  const nameInput = document.getElementById('subscriptionName');
  nameInput.value = subscription.name;
  const sourceInput = document.getElementById('subscriptionUrl');
  sourceInput.value = '';
  sourceInput.classList.add('masked-secret');
  sourceInput.placeholder = 'Оставьте пустым, чтобы сохранить текущий ключ';
  document.getElementById('subscriptionSubmitButton').textContent = 'Сохранить изменения';
  document.getElementById('cancelSubscriptionEditButton').hidden = false;
  showPage('subscription');
  nameInput.focus();
}

function textNode(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function showPage(name) {
  elements.nav.forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  Object.entries(elements.pages).forEach(([key, page]) => page.classList.toggle('active', key === name));
  if (name === 'logs' && currentState) renderLogs(currentState.logs, true);
}

function renderApplications(applications, suggestedApplications, mode) {
  elements.appList.replaceChildren();
  if (mode === 'full') return;

  const selectedProcesses = new Set(applications.map((item) => String(item.processName || '').toLowerCase()));
  const suggestions = mode === 'selected'
    ? suggestedApplications.map((item) => ({ ...item, custom: false }))
    : [];
  const knownKeys = new Set(suggestions.map((item) => item.processName.toLowerCase()));
  const custom = applications.filter((item) => !knownKeys.has(String(item.processName || '').toLowerCase()));
  const visible = mode === 'bypass' ? applications : [...suggestions, ...custom];
  elements.emptyApps.hidden = visible.length > 0;
  for (const application of visible) {
    const key = application.path || application.processName;
    const selected = selectedProcesses.has(String(application.processName || '').toLowerCase());
    const row = textNode('div', 'app-row', '');
    if (mode === 'selected') {
      const checkbox = textNode('button', `app-check${selected ? ' checked' : ''}`, selected ? '✓' : '');
      checkbox.type = 'button';
      checkbox.title = selected ? 'Не направлять приложение через VPN' : 'Направлять приложение через VPN';
      checkbox.setAttribute('aria-label', `${checkbox.title}: ${application.name}`);
      checkbox.setAttribute('aria-pressed', String(selected));
      checkbox.addEventListener('click', () => run(() => window.temple.toggleApplication(application)));
      row.append(checkbox);
    }
    row.append(textNode('div', 'app-icon', application.glyph || application.name.slice(0, 1).toUpperCase()));
    const copy = textNode('div', 'app-copy', '');
    copy.append(textNode('strong', '', application.name));
    copy.append(textNode('span', '', application.path || application.processName));
    row.append(copy);
    if (mode === 'bypass' || application.custom) {
      const remove = textNode('button', 'remove-button', '×');
      remove.type = 'button';
      remove.title = 'Удалить из списка';
      remove.setAttribute('aria-label', `Удалить ${application.name} из списка`);
      remove.addEventListener('click', () => run(() => window.temple.removeApplication(key)));
      row.append(remove);
    }
    elements.appList.append(row);
  }
}

function latencyView(server) {
  if (server.latencyStatus === 'auth-error') return {label: 'Отказ доступа', className: 'server-latency unavailable'};
  if (server.latencyStatus === 'unmeasured') return {label: '—', className: 'server-latency'};
  if (server.latencyStatus === 'ok' && Number.isFinite(server.latencyMs)) {
    const quality = server.latencyMs <= 80 ? 'fast' : server.latencyMs <= 160 ? 'medium' : 'slow';
    return { label: `${server.latencyMs} мс`, className: `server-latency ${quality}` };
  }
  if (server.latencyStatus === 'measuring' && Number.isFinite(server.latencyMs)) {
    return { label: `${server.latencyMs} мс`, className: 'server-latency measuring' };
  }
  if (server.latencyStatus === 'measuring' || server.latencyStatus === 'pending') {
    return { label: '…', className: 'server-latency measuring' };
  }
  return { label: 'Не удалось измерить', className: 'server-latency unavailable' };
}

function renderServers(servers, selectedId) {
  elements.serverList.replaceChildren();
  elements.emptyServers.hidden = servers.length > 0;
  for (const server of servers) {
    const row = textNode('button', `server-row${server.id === selectedId ? ' selected' : ''}${server.supported ? '' : ' unsupported'}`, '');
    row.type = 'button';
    row.append(textNode('div', 'server-dot', server.security === 'reality' ? 'R' : 'V'));
    const copy = textNode('div', 'server-copy', '');
    copy.append(textNode('strong', '', server.name));
    const details = `${server.transport.toUpperCase()} · ${server.security.toUpperCase()} · ${server.host}:${server.port}`;
    copy.append(textNode('span', '', server.supported ? details : `${details} · пока недоступен`));
    row.append(copy);
    const latency = latencyView(server);
    const latencyNode = textNode('span', latency.className, latency.label);
    const checkedTime = server.latencyCheckedAt ? new Date(server.latencyCheckedAt).toLocaleTimeString('ru-RU') : '';
    latencyNode.title = 'Проверка защищённого соединения через VPN-профиль; достаточно ответа одного из трёх адресов.'
      + (checkedTime ? ` Последняя проверка: ${checkedTime}.` : '');
    if (checkedTime) latencyNode.append(textNode('small', 'latency-time', checkedTime));
    row.append(latencyNode);
    if (server.supported) {
      row.setAttribute('aria-label', `Выбрать сервер ${server.name}, ${latency.label}`);
      row.setAttribute('aria-pressed', String(server.id === selectedId));
      row.addEventListener('click', () => run(() => window.temple.updateSettings({ selectedServerId: server.id })));
    } else {
      row.title = 'Этот транспорт пока не поддерживается приложением.';
      row.setAttribute('aria-disabled', 'true');
      row.disabled = true;
    }
    elements.serverList.append(row);
  }
}

function renderSubscriptions(subscriptions, activeId) {
  elements.subscriptionList.replaceChildren();
  const hiddenList = document.getElementById('hiddenSubscriptionList');
  hiddenList.replaceChildren();
  const hiddenCount = subscriptions.filter(s => s.hidden).length;
  document.getElementById('hiddenSubscriptions').hidden = !hiddenCount;
  document.getElementById('hiddenSubscriptionsTitle').textContent = `Скрытые подписки (${hiddenCount})`;
  const move = (id, target, after = false) => {
    if (id === target || !subscriptions.some(s => s.id === id)) return;
    const ids = subscriptions.map(s => s.id).filter(value => value !== id);
    ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, id);
    return runSubscriptionAction(() => window.temple.organizeSubscriptions({ids}), 'Сохраняем порядок…');
  };
  elements.emptySubscriptions.hidden = subscriptions.length > 0;
  for (const subscription of subscriptions) {
    const active = subscription.id === activeId || subscription.active;
    const row = textNode('div', `subscription-row${active ? ' active' : ''}`, '');
    row.dataset.subscriptionId = subscription.id;
    const handle = textNode('button', 'subscription-tool subscription-drag', '⠿');
    handle.type = 'button'; handle.draggable = true;
    handle.title = `Перетащить «${subscription.name}». Стрелки вверх и вниз меняют порядок.`;
    handle.setAttribute('aria-label', handle.title);
    handle.addEventListener('dragstart', event => {
      event.dataTransfer.setData('text/plain', subscription.id); event.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('keydown', event => {
      if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const group = subscriptions.filter(s => Boolean(s.hidden) === Boolean(subscription.hidden));
      const target = group[group.findIndex(s => s.id === subscription.id) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) move(subscription.id, target.id, event.key === 'ArrowDown');
    });
    row.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
    row.addEventListener('drop', event => {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      move(event.dataTransfer.getData('text/plain'), subscription.id, event.clientY > rect.top + rect.height / 2);
    });
    row.append(handle);
    const select = textNode('button', 'subscription-select', '');
    select.type = 'button';
    select.disabled = active;
    select.append(textNode('span', 'subscription-mark', active ? '✓' : 'S'));
    const copy = textNode('span', 'subscription-copy', '');
    copy.append(textNode('strong', '', subscription.name));
    copy.append(textNode('span', '', `Серверов: ${subscription.serverCount}`));
    const metadata = subscription.metadata || {};
    const bytes = value => `${(value / 1073741824).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ГиБ`;
    if (Number.isFinite(metadata.upload) && Number.isFinite(metadata.download)) {
      const used = metadata.upload + metadata.download;
      copy.append(textNode('span', '', `Использовано: ${bytes(used)}${metadata.total > 0 ? ` из ${bytes(metadata.total)}` : ''}${metadata.total > 0 && used >= metadata.total ? ' · Лимит исчерпан' : ''}`));
    } else if (metadata.total > 0) copy.append(textNode('span', '', `Лимит: ${bytes(metadata.total)}`));
    if (metadata.expire > 0) copy.append(textNode('span', '', `${metadata.expire * 1000 <= Date.now() ? 'Истекла' : 'Действует до'}: ${new Date(metadata.expire * 1000).toLocaleDateString('ru-RU')}`));
    if (!Object.keys(metadata).length) copy.append(textNode('span', '', 'Лимит и срок провайдером не переданы'));
    if (subscription.updatedAt) copy.append(textNode('span', '', `Обновлена: ${new Date(subscription.updatedAt).toLocaleString('ru-RU')}`));
    select.append(copy);
    select.append(textNode('span', `subscription-action${active ? ' active' : ''}`, active ? 'Активна' : 'Выбрать'));
    if (!active) select.addEventListener('click', () => runSubscriptionAction(
      () => window.temple.selectSubscription(subscription.id),
      `Переключение на «${subscription.name}»…`
    ));
    row.append(select);
    const tools = textNode('span', 'subscription-tools', '');
    const edit = textNode('button', 'subscription-tool subscription-edit', '✎');
    edit.type = 'button';
    edit.title = `Редактировать «${subscription.name}»`;
    edit.setAttribute('aria-label', edit.title);
    edit.addEventListener('click', () => beginSubscriptionEdit(subscription));
    const remove = textNode('button', 'subscription-tool subscription-delete', '×');
    remove.type = 'button';
    remove.title = `Удалить «${subscription.name}»`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => runSubscriptionAction(
      () => window.temple.deleteSubscription(subscription.id),
      `Удаление «${subscription.name}»…`,
      () => {
        if (editingSubscriptionId === subscription.id) resetSubscriptionForm();
      }
    ));
    const hide = textNode('button', 'subscription-tool subscription-hide', subscription.hidden ? '↩' : '−');
    hide.type = 'button'; hide.disabled = active && !subscription.hidden;
    hide.title = active && !subscription.hidden ? 'Сначала выберите другую подписку' : subscription.hidden ? 'Вернуть в основной список' : 'Скрыть подписку';
    hide.setAttribute('aria-label', hide.title);
    hide.addEventListener('click', () => runSubscriptionAction(
      () => window.temple.organizeSubscriptions({id:subscription.id,hidden:!subscription.hidden}), 'Сохраняем список…'));
    tools.append(hide, edit, remove);
    row.append(tools);
    (subscription.hidden ? hiddenList : elements.subscriptionList).append(row);
  }
}

function renderLogs(logs, force = false) {
  const text = logs.length ? logs.join('\n') : 'Записей пока нет.';
  if (!force && text === lastLogText) return;
  lastLogText = text;
  elements.logOutput.textContent = text;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function renderStatus(state) {
  const labels = {
    disconnected: 'Не подключено',
    connecting: 'Подключение…',
    connected: 'Подключено',
    reconnecting: 'Ожидаем подключения…',
    disconnecting: 'Отключение…',
    error: 'Ошибка'
  };
  const connectionActive = ['connecting', 'connected', 'reconnecting'].includes(state.status);
  const selectedServer = state.servers.find((server) => server.id === state.selectedServerId && server.supported);
  const missingSelectedApps = state.mode === 'selected' && state.applications.length === 0;
  const cannotConnect = !connectionActive && (!selectedServer || missingSelectedApps);
  const powerLabels = {
    connecting: 'Отменить подключение',
    connected: 'Отключить VPN',
    reconnecting: 'Остановить переподключение'
  };
  const powerLabel = powerLabels[state.status]
    || (missingSelectedApps ? 'Сначала выберите приложение' : !selectedServer ? 'Сначала выберите сервер' : 'Подключить VPN');
  elements.statusBadge.className = `status-badge ${state.status === 'connected' ? 'online' : state.status}`;
  elements.statusBadge.querySelector('span').textContent = labels[state.status] || state.status;
  elements.powerButton.classList.toggle('on', state.status === 'connected');
  elements.powerButton.classList.toggle('busy', ['connecting','reconnecting','disconnecting'].includes(state.status));
  elements.powerButton.disabled = powerStopInFlight || cannotConnect;
  elements.powerButton.title = powerLabel;
  elements.powerButton.setAttribute('aria-label', powerLabel);
  elements.powerButton.setAttribute('aria-pressed', String(state.status === 'connected'));
}

function render(state) {
  if (!routingDirty) {
    for (const key of ['proxy', 'direct', 'block']) document.getElementById(`route${key[0].toUpperCase()}${key.slice(1)}`).value = (state.customRouting?.[key] || []).join('\n');
    document.getElementById('dnsPreset').value = state.dnsPreset || 'legacy';
    document.getElementById('dnsPolicy').value = state.dnsPolicy || 'routing';
    document.getElementById('ipv6Policy').value = state.ipv6Policy || 'block';
    document.getElementById('killSwitch').value = state.killSwitch || 'off';
  }
  currentState = state;
  document.getElementById('guardStatus').textContent = !state.guardKnown ? 'Состояние системной блокировки не подтверждено.' : state.guardActive ? 'Системная блокировка активна.' : 'Системная блокировка выключена.';
  const importInfo = state.subscriptions?.find(item => item.active)?.importReport;
  if (importInfo?.skipped || importInfo?.duplicates) document.getElementById('importReport').textContent = `При импорте пропущено: ${importInfo.skipped || 0}; повторов: ${importInfo.duplicates || 0}. Поддерживаются VLESS и Hysteria 2.`;
  document.getElementById('connectionStrategy').value = state.connectionStrategy || 'auto';
  document.getElementById('connectionStrategy').disabled = ['connecting', 'reconnecting', 'disconnecting'].includes(state.status);
  const fullMode = state.mode === 'full';
  elements.applicationsPanel.hidden = fullMode;
  elements.contentGrid.classList.toggle('full-mode', fullMode);
  elements.applicationsTitle.textContent = state.mode === 'bypass' ? 'Исключения из VPN' : 'Раздельное туннелирование';
  elements.applicationsHelper.textContent = state.mode === 'bypass'
    ? 'Добавьте программы, которые должны работать напрямую, без VPN.'
    : 'Выберите программы, которые будут работать через VPN.';
  elements.emptyAppsTitle.textContent = state.mode === 'bypass' ? 'Исключений нет' : 'Приложения не добавлены';
  elements.emptyAppsText.textContent = state.mode === 'bypass'
    ? 'Нажмите «Добавить», чтобы исключить приложение из VPN.'
    : 'Нажмите «Добавить» и выберите EXE-файл.';
  const applicationSignature = JSON.stringify([state.applications, state.suggestedApplications || [], state.mode]);
  if (applicationSignature !== renderSignatures.applications) {
    renderSignatures.applications = applicationSignature;
    renderApplications(state.applications, state.suggestedApplications || [], state.mode);
  }
  const serverSignature = JSON.stringify([state.servers, state.selectedServerId]);
  if (serverSignature !== renderSignatures.servers) {
    renderSignatures.servers = serverSignature;
    renderServers(state.servers, state.selectedServerId);
  }
  const subscriptionSignature = JSON.stringify([state.subscriptions || [], state.activeSubscriptionId]);
  if (subscriptionSignature !== renderSignatures.subscriptions) {
    renderSignatures.subscriptions = subscriptionSignature;
    renderSubscriptions(state.subscriptions || [], state.activeSubscriptionId);
  }
  renderStatus(state);
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  const modeDescriptions = {
    full: state.russianSitesViaVpn !== false ? 'Весь публичный трафик и DNS идут через VPN.' : 'Российские домены и IP из встроенных списков — напрямую. Остальной публичный трафик — через VPN.',
    selected: 'Через VPN идут выбранные приложения; российские сайты и остальные программы — напрямую.',
    bypass: 'Через VPN идёт всё, кроме выбранных приложений и российских сайтов.'
  };
  elements.modeDescription.textContent = modeDescriptions[state.mode] || '';
  const routeCount = Object.values(state.customRouting || {}).reduce((sum, list) => sum + list.length, 0);
  if (routeCount) elements.modeDescription.textContent += ` Пользовательские маршруты имеют приоритет (${routeCount}).`;
  document.getElementById('russianSitesControl').hidden = state.mode !== 'full';
  document.getElementById('russianSitesViaVpn').checked = state.russianSitesViaVpn !== false;
  document.getElementById('russianSitesViaVpn').disabled = ['connecting', 'disconnecting', 'reconnecting'].includes(state.status);

  const selected = state.servers.find((server) => server.id === state.selectedServerId);
  elements.serverFlag.textContent = selected ? (selected.security === 'reality' ? 'R' : 'V') : '◌';
  elements.selectedServerName.textContent = selected?.name || 'Сервер не выбран';
  elements.selectedServerDetails.textContent = selected
    ? `${selected.transport.toUpperCase()} · ${selected.security.toUpperCase()}`
    : 'Добавьте VLESS-подписку';
  const activeSubscription = (state.subscriptions || []).find((item) => item.id === state.activeSubscriptionId);
  document.getElementById('activeSubscriptionName').textContent = activeSubscription?.name || 'Подписка не выбрана';
  elements.subscriptionStatus.textContent = state.subscriptionConfigured
    ? `Активна «${activeSubscription?.name || 'Подписка'}». Загружено серверов: ${state.servers.length}.`
    : 'Подписки ещё не добавлены.';
  elements.warningBanner.hidden = !state.warning;
  renderRetryCountdown();
  elements.cancelReconnectButton.hidden = !state.recovering;
  elements.errorBanner.hidden = !state.error;
  elements.errorBanner.textContent = state.error || '';
  const pingRefreshing = pingRequestInFlight || state.servers.some((server) => server.latencyStatus === 'measuring');
  elements.refreshButton.disabled = !state.servers.length
    || pingRefreshing
    || ['connecting', 'disconnecting', 'reconnecting'].includes(state.status);
  elements.refreshButton.classList.toggle('spinning', pingRefreshing);
  elements.pingStatus.textContent = pingRefreshing ? 'проверка…' : '';
  if (elements.pages.logs.classList.contains('active')) renderLogs(state.logs);
  updateSubscriptionControls();
}

async function run(action) {
  try {
    const next = await action();
    if (next) render(next);
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message || String(error);
    showPage('home');
  }
}

async function runSubscriptionAction(action, progressText, afterSuccess) {
  if (subscriptionRequestInFlight) return;
  subscriptionRequestInFlight = true;
  elements.subscriptionStatus.textContent = progressText;
  updateSubscriptionControls();
  try {
    const next = await action();
    afterSuccess?.();
    if (next) render(next);
  } catch (error) {
    elements.subscriptionStatus.textContent = `Ошибка: ${error.message || String(error)}`;
  } finally {
    subscriptionRequestInFlight = false;
    updateSubscriptionControls();
  }
}

elements.nav.forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    showPage('subscription');
    document.getElementById('subscriptionUrl').focus();
  }
});
document.getElementById('addAppButton').addEventListener('click', () => run(() => window.temple.addApplications()));
elements.refreshButton.addEventListener('click', async () => {
  if (pingRequestInFlight) return;
  pingRequestInFlight = true;
  render(currentState);
  try {
    const result = await window.temple.pingServers();
    if (result) render(result);
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message || String(error);
  } finally {
    pingRequestInFlight = false;
    render(currentState);
  }
});
elements.refreshSubscriptionButton.addEventListener('click', async () => {
  if (subscriptionRefreshInFlight || subscriptionRequestInFlight) return;
  subscriptionRefreshInFlight = true;
  elements.subscriptionStatus.textContent = 'Обновление активной подписки…';
  updateSubscriptionControls();
  try {
    const result = await window.temple.refreshSubscription();
    render(result);
  } catch (error) {
    elements.subscriptionStatus.textContent = `Ошибка: ${error.message || String(error)}`;
  } finally {
    subscriptionRefreshInFlight = false;
    updateSubscriptionControls();
  }
});
elements.powerButton.addEventListener('click', async () => {
  const shouldStop = ['connecting', 'connected', 'reconnecting', 'disconnecting'].includes(currentState.status);
  if (!shouldStop) {
    await run(() => window.temple.toggleTunnel());
    return;
  }
  if (powerStopInFlight) return;
  powerStopInFlight = true;
  render({ ...currentState, status: 'disconnected', error: '', warning: '', recovering: false });
  try {
    const result = await window.temple.toggleTunnel();
    if (result) render(result);
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message || String(error);
  } finally {
    powerStopInFlight = false;
    render(currentState);
  }
});
document.getElementById('cancelReconnectButton').addEventListener('click', () => run(() => window.temple.cancelRecovery()));
document.getElementById('openLogsButton').addEventListener('click', () => window.temple.openLogs());
document.getElementById('exportLogsButton').addEventListener('click', async () => {
  try { await window.temple.exportLogs(); }
  catch { elements.errorBanner.hidden = false; elements.errorBanner.textContent = 'Не удалось экспортировать журнал.'; }
});
document.getElementById('revealButton').addEventListener('click', () => {
  const input = document.getElementById('subscriptionUrl');
  input.classList.toggle('masked-secret');
});
document.getElementById('cancelSubscriptionEditButton').addEventListener('click', resetSubscriptionForm);
document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => run(() => window.temple.updateSettings({ mode: button.dataset.mode })));
});
document.getElementById('russianSitesViaVpn').addEventListener('change', (event) => {
  void run(() => window.temple.updateSettings({ russianSitesViaVpn: event.target.checked }));
});

document.getElementById('connectionStrategy').addEventListener('change', event => {
  void run(() => window.temple.updateSettings({ connectionStrategy: event.target.value }));
});
document.getElementById('subscriptionForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const nameInput = document.getElementById('subscriptionName');
  const sourceInput = document.getElementById('subscriptionUrl');
  const source = sourceInput.value.trim();
  if (!editingSubscriptionId && !source) return;
  const editingId = editingSubscriptionId;
  runSubscriptionAction(
    () => editingId
      ? window.temple.updateSubscription({ id: editingId, name: nameInput.value.trim(), source })
      : window.temple.setSubscription({ name: nameInput.value.trim(), source }),
    editingId ? 'Сохранение подписки…' : 'Загрузка подписки…',
    resetSubscriptionForm
  );
});

document.getElementById('routingForm').addEventListener('input', () => { routingDirty = true; });
document.getElementById('routingForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('saveRoutingButton');
  const status = document.getElementById('routingStatus');
  const controls = [...document.getElementById('routingForm').elements];
  controls.forEach(control => { control.disabled = true; });
  button.disabled = true; status.textContent = 'Применяем настройки…';
  try {
    const result = await window.temple.updateSettings({
      customRouting: { proxy: document.getElementById('routeProxy').value,
        direct: document.getElementById('routeDirect').value, block: document.getElementById('routeBlock').value },
      dnsPreset: document.getElementById('dnsPreset').value,
      dnsPolicy: document.getElementById('dnsPolicy').value,
      ipv6Policy: document.getElementById('ipv6Policy').value,
      killSwitch: document.getElementById('killSwitch').value
    });
    routingDirty = false; render(result);
    status.textContent = result.status === 'error' ? `Настройки сохранены. VPN не подключён: ${result.error}`
      : result.status === 'reconnecting' ? 'Настройки сохранены. Ожидаем восстановления подключения.' : 'Настройки сохранены и применены.';
  } catch (error) { status.textContent = error.message; }
  finally { controls.forEach(control => { control.disabled = false; }); }
});
function renderRetryCountdown() {
  if (!currentState) return;
  const waiting = currentState.status === 'reconnecting' && currentState.retryAt > 0;
  const seconds = waiting ? Math.max(0, Math.ceil((currentState.retryAt - Date.now()) / 1000)) : 0;
  elements.warningText.textContent = (currentState.warning || '') + (waiting
    ? seconds > 0 ? ` Повторная проверка через ${seconds} с.` : ' Начинаем повторную проверку…' : '');
}
setInterval(renderRetryCountdown, 250);
window.temple.onStateChanged(render);
window.temple.getState().then(render);

for (const [id, image] of [['importTextButton',false],['importQrButton',true]]) {
  document.getElementById(id).addEventListener('click', async () => {
    const button = document.getElementById(id); button.disabled = true;
    const report = document.getElementById('importReport');
    try {
      const result = await window.temple.importSubscriptionFile(image);
      if (!result) return;
      document.getElementById('subscriptionUrl').value = result.source;
      document.getElementById('subscriptionUrl').classList.add('masked-secret');
      report.textContent = result.report + ' Нажмите «Добавить» или «Сохранить изменения».';
    } catch (error) { report.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
for (const [id, output, action] of [
  ['diagnoseNetworkButton','networkDiagnostics', () => window.temple.diagnoseNetwork()],
  ['installUpdateButton','updateStatus', () => window.temple.installUpdate()],
  ['rollbackUpdateButton','updateStatus', () => window.temple.rollbackUpdate()]
]) document.getElementById(id).addEventListener('click', async () => {
  const button = document.getElementById(id); button.disabled = true;
  const result = document.getElementById(output); result.textContent = 'Проверяем…';
  try { result.textContent = await action() || 'Отменено.'; }
  catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
