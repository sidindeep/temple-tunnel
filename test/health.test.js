const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function harness(results, cancel = false) {
  let now = 0;
  let calls = 0;
  const messages = [];
  const sourcePath = path.join(__dirname, '../src/main.js');
  const realRequire = createRequire(sourcePath);
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { app: {disableHardwareAcceleration() {}, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({then() {}})} };
      if (name === './latency') return {checkTunnelReadiness: async () => {
        calls++;
        if (cancel && calls === 2) vm.runInContext('tunnelOperationId++; state.status="disconnected";', context);
        return {status: results[Math.min(calls-1, results.length-1)]};
      }};
      return realRequire(name);
    },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); return {unref(){}}; },
    clearTimeout() {}, console, process, Buffer, messages, __dirname: path.dirname(sourcePath)
  });
  vm.runInContext(fs.readFileSync(sourcePath,'utf8') + `
    let failures = 0;
    scheduleFailover = () => { failures++; };
    pushState = () => {};
    log = message => { messages.push(message); };
    state.status = 'connected'; activeHealthPort = 12345; state.selectedServerId = 'test';
    globalThis.check = checkActiveTunnelHealth;
    globalThis.snapshot = () => ({failures, warning: state.warning, confirmingConnection, messages});
  `, context);
  return {context, calls: () => calls};
}
test('healthy connection does not trigger recovery', async () => {
  const h = harness(['ok']); await h.context.check();
  assert.equal(h.context.snapshot().failures, 0);
  assert.equal(h.calls(), 1);
});
test('brief outage keeps the same server', async () => {
  const h = harness(['timeout','timeout','ok']); await h.context.check();
  assert.equal(h.context.snapshot().failures, 0);
  assert.equal(h.context.snapshot().warning, '');
});
test('persistent outage requires ten seconds of confirmation', async () => {
  const h = harness(['timeout']); await h.context.check();
  assert.equal(h.context.snapshot().failures, 1);
  assert.equal(h.calls(), 11);
  assert.match(h.context.snapshot().messages.join('\n'), /Контрольная проверка VPN не прошла \(HTTPS, тайм-аут\)/);
});
test('manual stop during confirmation prevents failover', async () => {
  const h = harness(['timeout'], true); await h.context.check();
  assert.equal(h.context.snapshot().failures, 0);
  assert.equal(h.context.snapshot().confirmingConnection, false);
});
