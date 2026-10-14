const test = require('node:test');
const assert = require('node:assert/strict');
const { detectWindowsDirectDns, selectDirectDns } = require('../src/windows-dns');

const adapter = (name, servers, metric = 25, connected = true) => ({ name, servers, metric, connected });

test('direct DNS ignores Temple TUN and disconnected adapters, ranking physical default routes', () => {
  const rows = [
    adapter('temple-tun-stale', ['172.31.254.2'], 0),
    adapter('TEMPLE-TUN-new', ['172.30.254.2'], 1),
    adapter('Unplugged Ethernet', ['192.0.2.9'], 2, false),
    adapter('Wi-Fi', ['192.0.2.2'], 55),
    adapter('Ethernet', ['192.0.2.1'], 25)
  ];
  assert.equal(selectDirectDns(rows), '192.0.2.1');
  assert.equal(selectDirectDns(adapter('Ethernet', ['::1', '127.0.0.1', '0.0.0.0', 'invalid', '192.0.2.1'])), '192.0.2.1');
});

test('Windows discovery snapshots interface DNS without changing adapter settings', async () => {
  const result = await detectWindowsDirectDns({ platform: 'win32', execute: async (exe, args, options) => {
    assert.equal(exe, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    assert.match(args.at(-1), /Get-NetRoute/);
    assert.match(args.at(-1), /Get-DnsClientServerAddress/);
    assert.doesNotMatch(args.at(-1), /Set-|New-|Remove-/);
    return { stdout: JSON.stringify([adapter('temple-tun-old', ['172.31.254.2'], 0), adapter('Ethernet', ['192.0.2.1'])]) };
  } });
  assert.deepEqual(result, { server: '192.0.2.1', source: 'windows-interface' });
});

test('a lower-metric corporate VPN cannot replace the physical upstream', async () => {
  const rows = [
    { ...adapter('Kerio Virtual Network', ['10.0.0.53'], 1), physical: false },
    { ...adapter('Ethernet', ['192.0.2.53'], 55), physical: true },
    { ...adapter('temple-tun-active', ['172.31.254.2'], 0), physical: false }
  ];
  assert.equal(selectDirectDns(rows), '192.0.2.53');
  assert.deepEqual(await detectWindowsDirectDns({ platform: 'win32', execute: async () => ({ stdout: JSON.stringify(rows) }) }),
    { server: '192.0.2.53', source: 'windows-interface', interfaceName: 'Ethernet' });
  rows[1].servers = [];
  assert.deepEqual(await detectWindowsDirectDns({ platform: 'win32', execute: async () => ({ stdout: JSON.stringify(rows) }) }),
    { server: '1.1.1.1', source: 'fallback', interfaceName: 'Ethernet' });
});

test('unavailable, malformed or TUN-only discovery falls back without using the active TUN DNS', async () => {
  for (const stdout of ['', 'null', '{}', '"secret"', '[]', JSON.stringify([adapter('temple-tun-old', ['172.31.254.2'])])]) {
    assert.deepEqual(await detectWindowsDirectDns({ platform: 'win32', execute: async () => ({ stdout }) }),
      { server: '1.1.1.1', source: 'fallback' });
  }
  assert.deepEqual(await detectWindowsDirectDns({ platform: 'win32', execute: async () => { throw Error('timeout'); } }),
    { server: '1.1.1.1', source: 'fallback' });
  assert.deepEqual(await detectWindowsDirectDns({ platform: 'linux', execute: async () => assert.fail('Unexpected shell') }),
    { server: '1.1.1.1', source: 'fallback' });
});
