const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isIP } = require('node:net');
const run = promisify(execFile);

function directInterfaces(rows) {
  return (Array.isArray(rows) ? rows : [rows])
    .filter(row => row && row.connected === true && typeof row.name === 'string'
      && row.name.trim() && !/^temple-tun(?:-|$)/i.test(row.name) && Number.isFinite(row.metric))
    .sort((a, b) => Number(b.physical === true) - Number(a.physical === true) || a.metric - b.metric);
}

function selectDirectDns(rows) {
  return directInterfaces(rows)
    .flatMap(row => Array.isArray(row.servers) ? row.servers : [])
    .find(server => typeof server === 'string' && isIP(server) === 4
      && !server.startsWith('127.') && !server.startsWith('0.') && server !== '255.255.255.255');
}

// Snapshot the resolver on an active default-route interface before starting TUN.
// System resolvers can change after TUN starts; never use its DNS peer as upstream.
async function detectWindowsDirectDns({ platform = process.platform, execute = run } = {}) {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
      + "$adapters=@(Get-NetAdapter -IncludeHidden); "
      + "$rows=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object { "
      + "$route=$_; $nic=Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex; "
      + "$adapter=$adapters | Where-Object { $_.ifIndex -eq $route.InterfaceIndex } | Select-Object -First 1; "
      + "$dns=Get-DnsClientServerAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex; "
      + "[pscustomobject]@{name=[string]$nic.InterfaceAlias; connected=($nic.ConnectionState -eq 'Connected'); "
      + "physical=($null -ne $adapter -and $adapter.HardwareInterface -eq $true); "
      + "metric=([int]$route.RouteMetric+[int]$nic.InterfaceMetric); servers=@($dns.ServerAddresses)} }); "
      + "ConvertTo-Json -InputObject $rows -Compress -Depth 4";
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 5000, maxBuffer: 32768 });
      const rows = JSON.parse(String(stdout).trim());
      const physical = directInterfaces(rows).find(row => row.physical === true);
      const server = selectDirectDns(physical ? [physical] : rows);
      const binding = physical ? { interfaceName: physical.name } : {};
      if (server) return { server, source: 'windows-interface', ...binding };
      if (physical) return { server: '1.1.1.1', source: 'fallback', ...binding };
    } catch {}
  }
  // Same public fallback previously used with Kill switch, routed directly.
  return { server: '1.1.1.1', source: 'fallback' };
}

module.exports = { detectWindowsDirectDns, selectDirectDns };
