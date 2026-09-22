const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small DOM adapter exercises renderer events without Electron or a real VPN.
class Element {
  constructor() {
    this.children = []; this.listeners = {}; this.attributes = {};
    this.dataset = {}; this.value = ''; this.textContent = ''; this.className = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (enabled ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false)
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector() { return this.children[0]; }
  querySelectorAll() { return []; }
  click() { if (!this.disabled) return this.listeners.click?.({ target: this }); }
}

async function fixture() {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const nav = [...html.matchAll(/class="nav[^"]*" data-page="([^"]+)"><span>(.*?)<\/span>(.*?)<\/button>/g)].map(match => {
    const node = new Element(); node.dataset.page = match[1]; node.textContent = match[2] + match[3];
    const icon = new Element(); icon.textContent = match[2]; node.append(icon); return node;
  });
  const modes = ['full', 'selected', 'bypass'].map(mode => {
    const node = new Element(); node.dataset.mode = mode; return node;
  });
  nodes.get('statusBadge').append(new Element());
  const calls = [];
  let changed;
  let state = {
    status: 'disconnected', mode: 'full', applications: [], logs: [], subscriptions: [],
    servers: [
      { id: 'a', name: 'Finland', transport: 'tcp', security: 'reality', supported: true, latencyStatus: 'unmeasured' },
      { id: 'b', name: 'Germany', transport: 'tcp', security: 'reality', supported: true, latencyStatus: 'unmeasured' }
    ], selectedServerId: 'a'
  };
  const temple = {
    getState: async () => state,
    onStateChanged: fn => { changed = fn; },
    updateSettings: async patch => { calls.push(patch); state = { ...state, ...patch }; return state; },
    toggleTunnel: async () => { calls.push('power'); return state; },
    pingServers: async () => { calls.push('ping'); return state; }
  };
  const document = {
    getElementById: id => { assert.ok(nodes.has(id), `Unknown HTML id ${id}`); return nodes.get(id); },
    querySelectorAll: selector => selector === '.nav' ? nav : selector === '[data-mode]' ? modes : [],
    createElement: () => new Element(), addEventListener() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8'), {
    document, window: { temple }, setInterval() {}, console
  });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, nav, calls, update: patch => { state = { ...state, ...patch }; changed(state); } };
}

test('navigation moves management to its own page and home search preserves selection', async () => {
  const { nodes, nav, calls } = await fixture();
  await nodes.get('homeManageButton').click();
  assert.equal(nodes.get('connectionPage').classList.contains('active'), true);
  assert.equal(nodes.get('pageTitle').textContent, 'Управление подключением');
  await nav.find(node => node.dataset.page === 'home').click();
  assert.equal(nodes.get('homePage').classList.contains('active'), true);
  const search = nodes.get('serverSearch'); search.value = 'GERM'; search.listeners.input();
  assert.equal(nodes.get('homeServerList').children.length, 1);
  assert.equal(nodes.has('serverList'), false);
  assert.equal(nodes.has('powerButton'), false);
  assert.equal(calls.length, 0);
  await nodes.get('homeServerList').children[0].click();
  assert.equal(calls[0].selectedServerId, 'b');
  assert.equal(nodes.get('homeServerName').textContent, 'Germany');
  assert.equal(nodes.get('selectedServerName').textContent, 'Germany');
  search.value = 'absent'; search.listeners.input();
  assert.equal(nodes.get('homeEmptyServers').hidden, false);
  assert.match(nodes.get('homeEmptyServers').textContent, /не найдены/);
});

test('home controls share connection actions, mode validation and state updates', async () => {
  const { nodes, calls, update } = await fixture();
  await nodes.get('homePowerButton').click();
  await nodes.get('homePingButton').click();
  assert.deepEqual(calls, ['power', 'ping']);
  const mode = nodes.get('homeMode'); mode.value = 'selected';
  await mode.listeners.change({ target: mode });
  assert.equal(nodes.get('homePowerButton').disabled, true);
  assert.match(nodes.get('homeConnectionHint').textContent, /выберите приложение/);
  update({ status: 'connecting' });
  assert.equal(nodes.get('homePowerButton').disabled, false);
  assert.equal(nodes.get('homePowerButton').attributes['aria-label'], 'Отменить подключение');
  assert.equal(nodes.get('homePingButton').disabled, true);
  update({ status: 'connected' });
  assert.equal(nodes.get('homePowerButton').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('homeConnectionStatus').textContent, 'Подключено');
  update({ status: 'error', error: 'Test failure', servers: [] });
  assert.equal(nodes.get('errorBanner').hidden, false);
  assert.match(nodes.get('homeEmptyServers').textContent, /Добавьте подписку/);
});
