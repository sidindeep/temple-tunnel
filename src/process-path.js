const path = require('node:path');

async function resolveRunningProcessPath(pid, processName, execute) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[^\\/:*?"<>|]+\.exe$/i.test(processName)) return '';
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; `
    + `if ($null -eq $p) { return }; `
    + `$s = Get-CimInstance Win32_Service -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue | Select-Object -First 1; `
    + `@{ name = $p.Name; path = $p.ExecutablePath; servicePath = $s.PathName } | ConvertTo-Json -Compress`;
  let result;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
    result = JSON.parse(stdout);
  } catch { return ''; }
  if (String(result.name || '').toLowerCase() !== processName.toLowerCase()) return '';
  const serviceCommand = String(result.servicePath || '').trim();
  const servicePath = serviceCommand.match(/^"([^"]+?\.exe)"(?:\s|$)/i)?.[1]
    || serviceCommand.match(/^(.+?\.exe)(?:\s|$)/i)?.[1] || '';
  for (const candidate of [result.path, servicePath]) {
    const file = String(candidate || '').trim();
    if (path.win32.isAbsolute(file) && path.win32.basename(file).toLowerCase() === processName.toLowerCase()) return file;
  }
  return '';
}

async function upgradeRunningApplicationPaths(applications, running, resolve) {
  let changed = false;
  for (const application of applications) {
    if (application.path) continue;
    const process = running.find(item => item.processName.toLowerCase() === application.processName.toLowerCase());
    if (!process) continue;
    const file = await resolve(process.pid, process.processName);
    if (!file) continue;
    application.path = file;
    changed = true;
  }
  return changed;
}

module.exports = { resolveRunningProcessPath, upgradeRunningApplicationPaths };
