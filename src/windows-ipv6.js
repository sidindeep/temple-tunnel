const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// DisabledComponents bit 4 disables native IPv6 interfaces, including Wintun.
// Bit 0 only disables Windows transition tunnels and must not disable our TUN.
async function detectWindowsIPv6({ platform = process.platform, execute = run } = {}) {
  if (platform !== 'win32') return { disabled: false, status: 'not-windows' };
  const script = "$ErrorActionPreference='Stop'; "
    + "$key=Get-Item -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters'; "
    + "$value=$key.GetValue('DisabledComponents',$null); "
    + "if ($null -eq $value) { '0' } "
    + "elseif ($key.GetValueKind('DisabledComponents') -eq 'DWord') "
    + "{ [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$value),0).ToString([Globalization.CultureInfo]::InvariantCulture) } "
    + "else { throw 'Unexpected registry type' }";
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 });
    const text = String(stdout).trim();
    if (!/^\d{1,10}$/.test(text)) throw new Error('Invalid registry result');
    const components = Number(text);
    if (!Number.isInteger(components) || components > 0xffffffff) throw new Error('Invalid DWORD');
    return { disabled: Boolean(components & 0x10), status: 'read', components };
  } catch {
    // Unknown system state must never silently remove IPv6 capture.
    return { disabled: false, status: 'unknown' };
  }
}

module.exports = { detectWindowsIPv6 };
