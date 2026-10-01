const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRunningProcessPath, upgradeRunningApplicationPaths } = require('../src/process-path');
const { guardArguments } = require('../src/network-guard');
const { buildConfig } = require('../src/singbox');

test('process picker resolves a service EXE when Windows hides its process image path', async () => {
  const execute = async (_binary, args) => {
    assert.ok(args.includes('-NonInteractive'));
    return { stdout: JSON.stringify({ name: 'kvpncsvc.exe', path: null,
      servicePath: '"C:\\Program Files (x86)\\Kerio\\VPN Client\\kvpncsvc.exe"' }) };
  };
  const file = await resolveRunningProcessPath(5364, 'kvpncsvc.exe', execute);
  assert.equal(file, 'C:\\Program Files (x86)\\Kerio\\VPN Client\\kvpncsvc.exe');
  const application = { processName: 'kvpncsvc.exe', path: file };
  assert.ok(guardArguments({ mode: 'bypass', bypassApplications: [application] }, []).includes(file));
  const config = buildConfig({ server: { host: '192.0.2.1', port: 443, uuid: 'test', security: 'none' },
    mode: 'bypass', applications: [application] });
  assert.ok(config.route.rules.some(rule => rule.process_path?.includes(file) && rule.outbound === 'direct'));
});

test('process picker rejects a reused PID and unrelated EXE path', async () => {
  const reused = async () => ({ stdout: JSON.stringify({ name: 'other.exe', path: 'C:\\Apps\\other.exe' }) });
  assert.equal(await resolveRunningProcessPath(5364, 'kvpncsvc.exe', reused), '');
  const unrelated = async () => ({ stdout: JSON.stringify({ name: 'kvpncsvc.exe', path: 'C:\\Apps\\other.exe' }) });
  assert.equal(await resolveRunningProcessPath(5364, 'kvpncsvc.exe', unrelated), '');
  assert.equal(await resolveRunningProcessPath(NaN, 'kvpncsvc.exe', unrelated), '');
});

test('stored name-only exceptions gain exact paths for running services', async () => {
  const applications = [{ processName: 'kvpncsvc.exe', path: '' }, { processName: 'offline.exe', path: '' }];
  const changed = await upgradeRunningApplicationPaths(applications,
    [{ processName: 'kvpncsvc.exe', pid: 5364 }], async () => 'C:\\Kerio\\kvpncsvc.exe');
  assert.equal(changed, true);
  assert.equal(applications[0].path, 'C:\\Kerio\\kvpncsvc.exe');
  assert.equal(applications[1].path, '');
});
