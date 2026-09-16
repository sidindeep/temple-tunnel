const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildXrayConfig } = require('../src/xray');

app.setPath('userData', path.join(app.getPath('appData'), 'temple-tunnel'));

function decrypt(payload) {
  return JSON.parse(safeStorage.decryptString(Buffer.from(payload, 'base64')));
}

function run() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const subscriptions = settings.subscriptionsEncrypted ? decrypt(settings.subscriptionsEncrypted) : [];
  const active = subscriptions.find((item) => item.id === settings.activeSubscriptionId) || subscriptions[0];
  const servers = active?.servers || (settings.serversEncrypted ? decrypt(settings.serversEncrypted) : []);
  const xhttpServers = servers.filter((server) => server.transport === 'xhttp');
  if (!xhttpServers.length) throw new Error('No XHTTP profiles found in the stored settings.');

  const executable = path.join(__dirname, '..', 'vendor', 'xray', 'xray.exe');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'temple-stored-xhttp-'));
  let passed = 0;
  try {
    for (const [index, server] of xhttpServers.entries()) {
      const configPath = path.join(directory, `config-${index}.json`);
      fs.writeFileSync(configPath, JSON.stringify(buildXrayConfig({ server, socksPort: 19080 + index })), { mode: 0o600 });
      const result = spawnSync(executable, ['run', '-test', '-c', configPath], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || 'configuration rejected')
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[UUID]')
          .replace(/(?:\d{1,3}\.){3}\d{1,3}/g, '[IP]');
        throw new Error(`Stored XHTTP profile ${index + 1} failed: ${detail.trim()}`);
      }
      passed += 1;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write(`Stored XHTTP configs verified offline: ${passed}/${xhttpServers.length}\n`);
}

app.whenReady().then(() => {
  try {
    run();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    app.exit(1);
  }
});
