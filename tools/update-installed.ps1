param(
  [string]$SourceDirectory = (Join-Path $PSScriptRoot '..\dist\win-unpacked'),
  [string]$InstallDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Temple Tunnel'),
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

$source = [System.IO.Path]::GetFullPath($SourceDirectory)
$destination = [System.IO.Path]::GetFullPath($InstallDirectory)
$sourceExecutable = Join-Path $source 'Temple Tunnel.exe'
$sourceArchive = Join-Path $source 'resources\app.asar'
$destinationExecutable = Join-Path $destination 'Temple Tunnel.exe'

if ($source -eq $destination) {
  throw 'Source and installation directories must be different.'
}
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $sourceArchive -PathType Leaf)) {
  throw "The packaged application was not found in: $source"
}
if (-not (Test-Path -LiteralPath $destinationExecutable -PathType Leaf)) {
  throw "Temple Tunnel installation was not found in: $destination"
}

$targetExecutablePath = [System.IO.Path]::GetFullPath($destinationExecutable)
$targetCorePath = [System.IO.Path]::GetFullPath((Join-Path $destination 'resources\bin\sing-box.exe'))
$targetXrayPath = [System.IO.Path]::GetFullPath((Join-Path $destination 'resources\bin\xray\xray.exe'))
$running = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'Temple Tunnel.exe' -or
  ($_.ExecutablePath -and (
    [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetCorePath -or
    [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetXrayPath
  ))
}

foreach ($item in $running) {
  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    [void]$process.CloseMainWindow()
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $remaining = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'Temple Tunnel.exe' -or
    ($_.ExecutablePath -and (
      [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetCorePath -or
      [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetXrayPath
    ))
  }
} while ($remaining -and [DateTime]::UtcNow -lt $deadline)

foreach ($item in $remaining) {
  Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
}

foreach ($item in $remaining) {
  if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) {
    throw 'Temple Tunnel is still running. Close it or run this update with administrator rights. No files were replaced.'
  }
}

Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force

$installedVersion = (Get-Item -LiteralPath $destinationExecutable).VersionInfo.ProductVersion
Write-Output "Temple Tunnel $installedVersion was updated in place."

if (-not $NoLaunch) {
  Start-Process -FilePath $destinationExecutable -WindowStyle Hidden
}
