const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createSettingsStore } = require('../src/settings-store');

async function temporaryStore(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'temple-settings-'));
  try { await work(path.join(directory, 'settings.json')); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('failed replacement leaves the prior settings and backup intact', () => temporaryStore(async file => {
  const old = '{"version":1}';
  await fs.writeFile(file, old);
  const io = { ...fs, rename: async (source, target) => {
    if (target === file) throw Object.assign(Error('Windows file locked'), { code: 'EPERM' });
    return fs.rename(source, target);
  } };
  const store = createSettingsStore(file, io);
  store.accept(old);
  await assert.rejects(store.save('{"version":2}'), { code: 'EPERM' });
  assert.equal(await fs.readFile(file, 'utf8'), old);
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), old);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['settings.json','settings.json.bak']);
}));

test('valid backup restores settings while archiving damaged bytes', () => temporaryStore(async file => {
  const store = createSettingsStore(file);
  await store.save('{"version":1}');
  await store.save('{"version":2}');
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), '{"version":1}');
  await fs.writeFile(file, '{damaged');
  assert.equal(await store.hasValidBackup(JSON.parse), true);
  const archived = await store.restore(JSON.parse);
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":1}');
  assert.equal(await fs.readFile(archived, 'utf8'), '{damaged');
}));

test('startup keeps unreadable encrypted settings and offers a valid backup', () => temporaryStore(async file => {
  const original = '{"subscriptionsEncrypted":"Y29ycnVwdA=="}';
  await fs.writeFile(file, original);
  await fs.writeFile(`${file}.bak`, '{}');
  const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
  const code = source.slice(source.indexOf('function dataFile()'), source.indexOf('function activeSubscription()'));
  const context = vm.createContext({
    app: { getPath: () => path.dirname(file) }, path, crypto, process, Buffer,
    createSettingsStore, fsp: fs, saveQueue: Promise.resolve(),
    safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw Error('synthetic DPAPI failure'); } },
    state: { mode:'bypass', selectedApplications:[], bypassApplications:[], connectionStrategy:'auto' },
    subscriptionCache:undefined, connectionMemory:{},
    normalizeRouting: value => value, normalizeDns: value => value,
    normalizeKillSwitch: value => value, normalizeIpv6: value => value,
    normalizeDnsPolicy: value => value, normalizeApplicationList: value => value,
    DEFAULT_TUNNEL_MODE:'bypass', console:{ error(){} }
  });
  vm.runInContext(code, context);
  await context.loadState();
  assert.equal(vm.runInContext('settingsReadOnly',context), true);
  assert.equal(vm.runInContext('settingsBackupAvailable',context), true);
  assert.match(context.state.warning, /не удалось открыть/i);
  assert.throws(() => context.saveState(), /заблокировано/i);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const damaged = await vm.runInContext('settingsStore.restore(validateStoredSettings)',context);
  assert.equal(await fs.readFile(damaged, 'utf8'), original);
  vm.runInContext('settingsReadOnly = false; settingsBackupAvailable = false',context);
  await context.loadState();
  assert.equal(vm.runInContext('settingsReadOnly',context), false);
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
}));
