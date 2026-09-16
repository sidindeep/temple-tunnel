// Read-only check of the active subscription through local proxies. Never creates TUN or saves settings.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { selectWorkingServer, rankCandidates } = require('../src/connection-selection');
const { probeServer } = require('../src/server-probe');
const { isSupportedTransport } = require('../src/subscription');
const os = require('node:os');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'temple-selection-check-'));
// Electron safeStorage uses the encrypted key in Local State. Work on a private copy.
const localState = path.join(app.getPath('appData'), 'temple-tunnel', 'Local State');
if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(scratch, 'Local State'));
app.setPath('userData', scratch);

app.whenReady().then(async () => {
  const started = Date.now();
  let step = 'read-settings', exitCode = 0;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'temple-tunnel', 'settings.json')));
    step = 'decrypt-subscription';
    const decrypt = value => value ? JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) : [];
    const subscriptions = decrypt(settings.subscriptionsEncrypted);
    if (process.argv.includes('--verify-update')) {
      const before = JSON.parse(fs.readFileSync(path.join(__dirname, '../.cache/update-0.10.0-backup/settings.json')));
      const previous = decrypt(before.subscriptionsEncrypted);
      console.log(JSON.stringify({
        subscriptionsPreserved: previous.every(old => subscriptions.some(item => item.id === old.id && item.name === old.name && item.source === old.source)),
        applicationsAndRoutingPreserved: ['activeSubscriptionId','selectedApplications','bypassApplications','mode','russianSitesViaVpn']
          .every(key => JSON.stringify(before[key]) === JSON.stringify(settings[key])),
        profileCounts: subscriptions.map(item => item.servers.length),
        profilesRefreshed: JSON.stringify(previous.map(item=>item.servers)) !== JSON.stringify(subscriptions.map(item=>item.servers)),
        selectedServerPresent: subscriptions.find(item=>item.id===settings.activeSubscriptionId)?.servers.some(server=>server.id===settings.selectedServerId)
      }));
      return;
    }
    const active = subscriptions.find(item => item.id === settings.activeSubscriptionId) || subscriptions[0];
    const servers = (active?.servers || decrypt(settings.serversEncrypted)).filter(server => isSupportedTransport(server.transport));
    step = 'select-server';
    const candidates = rankCandidates(servers, { selectedId: settings.selectedServerId });
    const summary = [];
    const winner = await selectWorkingServer(candidates, (server, signal) => probeServer(server,
      path.join(__dirname, '../vendor/sing-box/sing-box.exe'), path.join(__dirname, '../vendor/xray/xray.exe'), {
        signal, onStage: (stage, ms) => summary.push({candidate: candidates.indexOf(server) + 1, stage, ms})
      }), { hedgeMs: 0, onResult: (server, result) => summary.push({candidate:candidates.indexOf(server)+1,status:result.status,reason:result.reason,ms:result.ms}) });
    console.log(JSON.stringify({ok:true,candidates:candidates.length,winner:candidates.indexOf(winner.server)+1,
      transport:winner.server.transport,totalMs:Date.now()-started,stages:summary}));
  } catch (error) {
    console.log(JSON.stringify({ok:false,step,code:error.code || 'CHECK_FAILED',totalMs:Date.now()-started}));
    exitCode = 1;
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  }
});
