param([string]$TunInterface = '')
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this validation from an administrator PowerShell. No filters have been changed.'
}
$guardPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\vendor\network-guard\network-guard.exe'))
$testTun = if ($TunInterface) { $TunInterface } else { '-' }
foreach ($mode in @('full','bypass','selected')) {
  $arguments = @('validate',$mode,$testTun,'--allow',$guardPath)
  if ($mode -eq 'selected') { $arguments += @('--protect',([Environment]::ProcessPath)) }
  # Windows PowerShell 5.1 does not expose Environment.ProcessPath.
  if ($mode -eq 'selected' -and -not $arguments[-1]) { $arguments[-1] = (Get-Process -Id $PID).Path }
  & $guardPath @arguments
  if ($LASTEXITCODE -ne 0) { throw "WFP validation failed for $mode. The transaction was aborted." }
  Write-Output "$mode : native WFP transaction validated and aborted."
}
Write-Output 'No blocking filters were committed. Packet-level crash/reconnect tests are still required in an isolated Windows VM.'
