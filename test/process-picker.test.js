const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.classList = { toggle: (name, enabled) => {
      this.className = enabled ? name : '';
    } };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (!this.disabled) this.listeners.click?.(); }
}

async function fixture(add = async () => {}) {
  const nodes = new Map(['search', 'processList', 'status', 'refreshButton', 'closeButton']
    .map(id => [id, new Element()]));
  const calls = [];
  const picker = {
    list: async () => [
      { processName: 'chrome.exe', pid: 100 },
      { processName: 'game.exe', pid: 200 }
    ],
    add: async process => { calls.push(process.processName); await add(process); },
    close: async () => { calls.push('close'); }
  };
  const document = {
    getElementById: id => nodes.get(id),
    createElement: () => new Element()
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/process-picker.js'), 'utf8'), {
    document, window: { processPicker: picker }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, calls };
}

test('separate picker filters processes and closes after a successful choice', async () => {
  const { nodes, calls } = await fixture();
  assert.equal(nodes.get('processList').children.length, 2);
  const search = nodes.get('search');
  search.value = 'GAME';
  search.listeners.input();
  assert.equal(nodes.get('processList').children.length, 1);
  assert.equal(nodes.get('processList').children[0].children[0].textContent, 'game.exe');
  nodes.get('processList').children[0].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['game.exe', 'close']);
});

test('failed choice keeps the picker open and shows the error', async () => {
  const { nodes, calls } = await fixture(async () => { throw new Error('Не удалось добавить'); });
  nodes.get('processList').children[0].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['chrome.exe']);
  assert.equal(nodes.get('status').textContent, 'Не удалось добавить');
  assert.equal(nodes.get('processList').children[0].disabled, false);
});

test('process picker opens a modal Electron window with its own page', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function openProcessPicker()'), source.indexOf("app.on('second-instance'"));
  const windows = [];
  const parent = {};
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { setWindowOpenHandler() {}, on() {} };
      windows.push(this);
    }
    on() {}
    async loadFile(file) { this.file = file; }
    isDestroyed() { return false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  const context = { BrowserWindow, mainWindow: parent, processPickerWindow: undefined, path, __dirname: path.join(__dirname, '../src') };
  vm.runInNewContext(code, context);
  await context.openProcessPicker();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].options.parent, parent);
  assert.equal(windows[0].options.modal, true);
  assert.match(windows[0].file, /process-picker\.html$/);
  assert.equal(windows[0].shown, true);
  await context.openProcessPicker();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].focused, true);
});
