$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$report = Join-Path $root '.cache\guard-diagnostic.txt'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
('Elevated: ' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) | Set-Content -LiteralPath $report -Encoding UTF8
$installedGuard = Join-Path $env:LOCALAPPDATA 'Programs\Temple Tunnel\resources\bin\network-guard.exe'
'Installed helper:' | Out-File -LiteralPath $report -Append -Encoding UTF8
$ErrorActionPreference = 'Continue'
& $installedGuard status 2>&1 | Out-File -LiteralPath $report -Append -Encoding UTF8
('Installed status exit: ' + $LASTEXITCODE) | Out-File -LiteralPath $report -Append -Encoding UTF8
$ErrorActionPreference = 'Stop'
$guard = Join-Path $root 'vendor\network-guard\network-guard.exe'
& $guard status 2>&1 | Out-File -LiteralPath $report -Append -Encoding UTF8
('Status exit: ' + $LASTEXITCODE) | Out-File -LiteralPath $report -Append -Encoding UTF8
& (Join-Path $PSScriptRoot 'check-wfp.ps1') 2>&1 | Out-File -LiteralPath $report -Append -Encoding UTF8
'Completed' | Out-File -LiteralPath $report -Append -Encoding UTF8
