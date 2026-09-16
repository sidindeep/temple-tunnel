const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildXrayConfig } = require('../src/xray');

const server = {
  host: 'example.com',
  port: 443,
  uuid: '11111111-1111-4111-8111-111111111111',
  encryption: 'none',
  flow: '',
  security: 'reality',
  transport: 'xhttp',
  serverName: 'www.example.com',
  fingerprint: 'chrome',
  publicKey: 'YqHW8a4iAc1SZYpTrFVoOQg1F3yAdX1tWXuROZUCsEU',
  shortId: 'abcd',
  spiderX: '/',
  hostHeader: 'cdn.example.com',
  path: '/secret',
  xhttpMode: 'stream-up',
  xhttpExtra: { xPaddingBytes: '100-1000' }
};

test('builds VLESS XHTTP REALITY client with a loopback SOCKS inbound', () => {
  const config = buildXrayConfig({ server, socksPort: 19080 });
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].protocol, 'socks');
  assert.equal(config.outbounds[0].streamSettings.network, 'xhttp');
  assert.equal(config.outbounds[0].streamSettings.security, 'reality');
  assert.equal(config.outbounds[0].streamSettings.xhttpSettings.mode, 'stream-up');
  assert.deepEqual(config.outbounds[0].streamSettings.xhttpSettings.extra, { xPaddingBytes: '100-1000' });
});

test('generated XHTTP config passes bundled Xray validation', { skip: process.platform !== 'win32' }, () => {
  const executable = path.join(__dirname, '..', 'vendor', 'xray', 'xray.exe');
  if (!fs.existsSync(executable)) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'temple-xray-'));
  const configPath = path.join(directory, 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(buildXrayConfig({ server, socksPort: 19080 })));
    const result = spawnSync(executable, ['run', '-test', '-c', configPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
