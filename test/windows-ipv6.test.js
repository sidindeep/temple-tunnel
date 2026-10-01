const test = require('node:test');
const assert = require('node:assert/strict');
const { detectWindowsIPv6 } = require('../src/windows-ipv6');

test('Windows DWORD masks distinguish native IPv6 disable from transition tunnels and IPv4 preference', async () => {
  for (const [components, disabled] of [[0, false], [1, false], [32, false], [16, true], [17, true], [255, true], [4294967295, true]]) {
    const result = await detectWindowsIPv6({ platform: 'win32', execute: async (exe, args, options) => {
      assert.equal(exe, 'powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5000);
      assert.doesNotMatch(args.at(-1), /Set-Item|New-Item|SetValue|Remove-Item/);
      return { stdout: `${components}\r\n` };
    } });
    assert.deepEqual(result, { disabled, status: 'read', components });
  }
});

test('failed, malformed or out-of-range registry reads preserve IPv6 capture', async () => {
  for (const stdout of ['', '-1', '4294967296', '16 extra', '0x10', '16.5', 'secret']) {
    assert.deepEqual(await detectWindowsIPv6({ platform: 'win32', execute: async () => ({ stdout }) }),
      { disabled: false, status: 'unknown' });
  }
  assert.deepEqual(await detectWindowsIPv6({ platform: 'win32', execute: async () => { throw Error('Access denied'); } }),
    { disabled: false, status: 'unknown' });
});

test('other operating systems never read Windows settings', async () => {
  assert.deepEqual(await detectWindowsIPv6({ platform: 'linux', execute: async () => assert.fail('Unexpected shell') }),
    { disabled: false, status: 'not-windows' });
});
