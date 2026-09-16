const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1160,
    height: 760,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const checks = await window.webContents.executeJavaScript(`(async () => {
    const clickPage = (name) => {
      document.querySelector('[data-page="' + name + '"]').click();
      return document.getElementById(name + 'Page').classList.contains('active');
    };
    const subscription = clickPage('subscription');
    const subscriptionList = document.querySelectorAll('.subscription-row').length === 2;
    document.querySelector('.subscription-row:not(.active) .subscription-select').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const subscriptionSwitch = document.querySelector('.subscription-row.active .subscription-copy strong').textContent === 'Резервная';
    const subscriptionActions = document.querySelectorAll('.subscription-edit').length === 2
      && document.querySelectorAll('.subscription-delete').length === 2;
    document.querySelector('.subscription-edit').click();
    const subscriptionEdit = document.getElementById('subscriptionFormTitle').textContent === 'Редактировать подписку'
      && document.getElementById('subscriptionSubmitButton').textContent === 'Сохранить изменения'
      && document.getElementById('subscriptionUrl').value === ''
      && !document.getElementById('cancelSubscriptionEditButton').hidden;
    document.getElementById('cancelSubscriptionEditButton').click();
    const logs = clickPage('logs');
    const home = clickPage('home');
    const warningVisible = !document.getElementById('warningBanner').hidden
      && document.getElementById('warningBanner').textContent.includes('2 секунды');
    const cancelRecoveryVisible = !document.getElementById('cancelReconnectButton').hidden;
    document.querySelector('[data-mode="full"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fullHidesApplications = document.getElementById('applicationsPanel').hidden
      && document.getElementById('contentGrid').classList.contains('full-mode');
    document.querySelector('[data-mode="selected"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const selectedShowsChecklist = !document.getElementById('applicationsPanel').hidden
      && document.querySelectorAll('.app-check').length > 0;
    document.querySelector('[data-mode="bypass"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bypassShowsOnlyExclusions = !document.getElementById('applicationsPanel').hidden
      && document.getElementById('applicationsTitle').textContent === 'Исключения из VPN'
      && document.querySelectorAll('.app-check').length === 0
      && document.querySelectorAll('.app-row').length === 1
      && document.querySelectorAll('.remove-button').length === 1;
    const xhttpSupported = [...document.querySelectorAll('.server-row')].some((row) =>
      row.textContent.includes('XHTTP Preview') && !row.classList.contains('unsupported')
    );
    const serverLatency = [...document.querySelectorAll('.server-latency')].some((node) => node.textContent.includes('мс'));
    const serversInSubscriptionOrder = document.querySelector('.server-row .server-copy strong').textContent.includes('Финляндия');
    const keyboardAccessibleServers = [...document.querySelectorAll('.server-row')].every((row) => row.tagName === 'BUTTON');
    const strategy = document.getElementById('connectionStrategy');
    const autoDefault = strategy.value === 'auto';
    document.querySelector('.server-row').click();
    await new Promise(resolve=>setTimeout(resolve,20));
    const manualAfterSelection = strategy.value === 'manual';
    strategy.value = 'auto'; strategy.dispatchEvent(new Event('change'));
    await new Promise(resolve=>setTimeout(resolve,20));
    if (!autoDefault || !manualAfterSelection || strategy.value !== 'auto') throw Error('Connection strategy control failed');
    const power = document.getElementById('powerButton');
    const powerStartsEnabled = !power.disabled;
    power.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const powerConnected = power.classList.contains('on') && power.getAttribute('aria-pressed') === 'true';
    power.click();
    const powerStopsImmediately = !power.classList.contains('on');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const powerDisconnected = !power.classList.contains('on') && power.getAttribute('aria-pressed') === 'false';
    return { subscription, subscriptionList, subscriptionSwitch, subscriptionActions, subscriptionEdit, logs, home, warningVisible, cancelRecoveryVisible, fullHidesApplications, selectedShowsChecklist, bypassShowsOnlyExclusions, xhttpSupported, serverLatency, serversInSubscriptionOrder, keyboardAccessibleServers, powerStartsEnabled, powerConnected, powerStopsImmediately, powerDisconnected };
  })()`);
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`UI smoke check failed: ${JSON.stringify(checks)}`);
  }
  const retryUi = await window.webContents.executeJavaScript(`(async () => {
    const previous = currentState;
    render({...previous,status:'reconnecting',warning:'Рабочее соединение пока не найдено.',retryAt:Date.now()+2000});
    const power = document.getElementById('powerButton');
    const waiting = power.classList.contains('busy') && !power.classList.contains('on')
      && power.getAttribute('aria-pressed') === 'false';
    const first = document.getElementById('warningBanner').textContent;
    await new Promise(resolve=>setTimeout(resolve,1400));
    const countdown = first.includes('2 с.') && document.getElementById('warningBanner').textContent.includes('1 с.');
    render(previous);
    return waiting && countdown;
  })()`);
  if (!retryUi) throw new Error('Retry countdown or waiting power indicator failed');
  const organizationUi = await window.webContents.executeJavaScript(`(async () => {
    const pause = () => new Promise(r=>setTimeout(r,30));
    document.querySelector('[data-page="subscription"]').click();
    const list = document.getElementById('subscriptionList');
    const before = [...list.children].map(r=>r.dataset.subscriptionId);
    const row = list.querySelector('.subscription-row:not(.active)');
    const hiddenId = row.dataset.subscriptionId;
    row.querySelector('.subscription-hide').click(); await pause();
    const hidden = document.getElementById('hiddenSubscriptionList');
    if (hidden.children.length !== 1 || hidden.firstChild.dataset.subscriptionId !== hiddenId) return false;
    hidden.querySelector('.subscription-hide').click(); await pause();
    if (list.children.length !== 2 || !document.getElementById('hiddenSubscriptions').hidden) return false;
    const transfer = new DataTransfer();
    list.lastChild.querySelector('.subscription-drag').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    list.firstChild.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer,clientY:0})); await pause();
    if (list.firstChild.dataset.subscriptionId !== before[1]) return false;
    const active = currentState.subscriptions.find(s=>s.id===currentState.activeSubscriptionId);
    return document.getElementById('activeSubscriptionName').textContent === active.name;
  })()`);
  if (!organizationUi) throw new Error('Subscription hiding, order or heading failed');
  window.setSize(980, 640);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const compactLayoutFits = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-page="home"]').click();
    const main = document.querySelector('main').getBoundingClientRect();
    const card = document.querySelector('.connection-card').getBoundingClientRect();
    return document.documentElement.scrollWidth <= window.innerWidth
      && main.right <= window.innerWidth
      && card.right <= main.right
      && card.bottom <= window.innerHeight;
  })()`);
  if (!compactLayoutFits) throw new Error('UI does not fit the minimum 980x640 window.');
  window.setSize(1160, 760);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const subscriptionPageActive = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-page="subscription"]').click();
    return document.getElementById('subscriptionPage').classList.contains('active');
  })()`);
  if (!subscriptionPageActive) throw new Error('Subscription preview page did not activate.');
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const subscriptionImage = await window.webContents.capturePage();
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'subscription-preview-0.8.0.png'), subscriptionImage.toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="home"]').click()`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-mode="full"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const russianControlWorks = await window.webContents.executeJavaScript(`(async () => {
    const control = document.getElementById('russianSitesViaVpn');
    if (document.getElementById('russianSitesControl').hidden || !control.checked) return false;
    control.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    return !control.checked && document.getElementById('modeDescription').textContent.includes('напрямую');
  })()`);
  if (!russianControlWorks) throw new Error('Russian routing control failed');
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'ui-preview.png'), image.toPNG());
  const routingWorks = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-page="routing"]').click();
    if (!document.getElementById('routingPage').classList.contains('active')) return false;
    const proxy = document.getElementById('routeProxy');
    proxy.value = 'example.com'; proxy.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('dnsPreset').value = 'cloudflare';
    document.getElementById('saveRoutingButton').click();
    await new Promise(resolve=>setTimeout(resolve,50));
    return document.getElementById('routingStatus').textContent.includes('сохранены') && proxy.value === 'example.com'
      && document.getElementById('dnsPreset').value === 'cloudflare';
  })()`);
  if (!routingWorks) throw new Error('Routing settings UI failed');
  const protectionUi = await window.webContents.executeJavaScript(`(async () => {
    for (const [id,value] of [['ipv6Policy','tunnel'],['dnsPolicy','vpn'],['killSwitch','session']]) {
      const control=document.getElementById(id);control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));
    }
    document.getElementById('saveRoutingButton').click();await new Promise(resolve=>setTimeout(resolve,30));
    if(document.getElementById('ipv6Policy').value!=='tunnel'||document.getElementById('killSwitch').value!=='session')return false;
    document.getElementById('diagnoseNetworkButton').click();await new Promise(resolve=>setTimeout(resolve,20));
    if(!document.getElementById('networkDiagnostics').textContent.includes('DNS'))return false;
    document.querySelector('[data-page="subscription"]').click();document.getElementById('importQrButton').click();
    await new Promise(resolve=>setTimeout(resolve,20));
    if(document.getElementById('subscriptionUrl').value!=='https://example.com/qr')return false;
    document.getElementById('importTextButton').click();await new Promise(resolve=>setTimeout(resolve,20));
    if(!document.getElementById('subscriptionUrl').value.includes('\\n'))return false;
    document.querySelector('[data-page="logs"]').click();document.getElementById('installUpdateButton').click();
    await new Promise(resolve=>setTimeout(resolve,20));
    return document.getElementById('updateStatus').textContent.includes('Подпись');
  })()`);
  if (!protectionUi) throw new Error('Protection/import/update UI failed');
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="routing"]').click()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'routing-preview.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.getElementById('saveRoutingButton').scrollIntoView({block:'end'})`);
  await new Promise(resolve=>setTimeout(resolve,100));
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'protection-preview.png'), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(__dirname, '..', '.cache', 'ui-smoke-result.json'), JSON.stringify({checks,routingWorks,retryUi,organizationUi,protectionUi}));
  app.quit();
}).catch(error => {
  fs.writeFileSync(path.join(__dirname, '..', '.cache', 'ui-smoke-error.txt'), error.stack || String(error));
  app.exit(1);
});
