$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw 'Windows .NET Framework x64 C# compiler not found.'
}

$source = Join-Path $PSScriptRoot 'CoreHost.cs'
$output = Join-Path $PSScriptRoot '..\vendor\core-host\core-host.exe'
& $compiler /nologo /optimize+ /platform:x64 /target:exe "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Core host build failed with exit code $LASTEXITCODE." }
