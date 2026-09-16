const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { buildConfig } = require('../src/singbox');
const { buildXrayConfig } = require('../src/xray');
const { measureTunnelLatency, checkTunnelConnectivity } = require('../src/latency');
app.setPath('userData', path.join(app.getPath('appData'), 'temple-tunnel'));

const port = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'temple-diagnostic-'));
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'temple-tunnel', 'settings.json')));
    const subs = JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted, 'base64')));
    for (const sub of subs.filter(s => process.argv.includes('--honey') ? /honey/i.test(s.name) : process.argv.includes('--hysteria2') ? s.servers.some(server => server.protocol === 'hysteria2') : /mori/i.test(s.name))) {
      if (process.argv.includes('--fresh')) {
        const fresh = await require('../src/subscription').downloadSubscription(sub.source);
        process.stdout.write(JSON.stringify({freshProfiles: fresh.length, unchanged: JSON.stringify(fresh) === JSON.stringify(sub.servers)})+'\n');
        sub.servers = fresh;
      }
      for (const [index, server] of sub.servers.entries()) {
        if (process.argv.includes('--metadata')) {
          process.stdout.write(JSON.stringify({index:index+1,name:server.name,transport:server.transport})+'\n');
          continue;
        }
        if (process.argv.includes('--first') && index > 0) continue;
        if (process.argv.includes('--hysteria2') && server.protocol !== 'hysteria2') continue;
        if (process.argv.includes('--probe')) {
          const result = await require('../src/server-probe').probeServer(server, path.join(__dirname, '../vendor/sing-box/sing-box.exe'), path.join(__dirname, '../vendor/xray/xray.exe'));
          process.stdout.write(JSON.stringify({index:index+1, result})+'\n');
          continue;
        }
        const children = [];
        let logs = '';
        const start = (exe, config, args, label) => {
          const file = path.join(dir, `${label}.json`);
          fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
          const child = spawn(exe, [...args, file], { windowsHide: true });
          child.stderr.on('data', c => { logs += c; });
          child.stdout.on('data', c => { logs += c; });
          child.on('error', e => { logs += e.message; });
          children.push(child);
        };
        try {
          const effectiveServer = process.argv.includes('--resolve')
            ? await require('../src/server-probe').resolveServer(server) : server;
          const healthPort = await port();
          const bridgePort = server.transport === 'xhttp' ? await port() : 0;
          if (bridgePort) start(path.join(__dirname, '../vendor/xray/xray.exe'), buildXrayConfig({server: effectiveServer, socksPort: bridgePort}), ['run','-c'], 'xray');
          const config = buildConfig({ server: effectiveServer, mode:'full', applications:[], healthPort, bridgePort });
          config.inbounds = config.inbounds.filter(i => i.tag === 'health-in');
          start(path.join(__dirname, '../vendor/sing-box/sing-box.exe'), config, ['run','-c'], 'core');
          await new Promise(r => setTimeout(r, 500));
          const result = await measureTunnelLatency(healthPort, 5000);
          const health = await checkTunnelConnectivity(healthPort, 5000);
          const websites = await Promise.all(['https://www.microsoft.com/', 'https://www.google.com/'].map(url => new Promise(resolve => {
            const request = spawn('curl.exe', ['--proxy', `http://127.0.0.1:${healthPort}`, '--max-time', '8', '--silent', '--output', 'NUL', '--write-out', '%{http_code}', url], {windowsHide:true});
            let status = '';
            request.stdout.on('data', c => { status += c; });
            request.on('error', () => resolve({url, error:'curl unavailable'}));
            request.on('exit', code => resolve({url, status, code}));
          })));
          const codes = [...new Set((logs.match(/(?:FATAL|ERROR)[^\r\n]*/g) || []).map(line => line.replace(/(?:vless|https?):\/\/\S+/gi, '[URL]').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[UUID]')))];
          process.stdout.write(JSON.stringify({ subscription:sub.name, index:index+1, transport:server.transport, security:server.security, result, health, websites, errors:codes.slice(-2) })+'\n');
        } finally {
          for (const child of children) child.kill();
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }
  } catch (e) { process.stderr.write(e.message+'\n'); process.exitCode=1; }
  finally { fs.rmSync(dir,{recursive:true,force:true}); app.exit(process.exitCode || 0); }
});
