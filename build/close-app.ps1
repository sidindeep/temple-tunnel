param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\\/]+\.exe$')]
    [string]$ProcessName,
    [ValidateRange(1, 30)]
    [int]$GracefulTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$tracked = @{}

function Get-AppProcesses {
    $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate)
    $byId = @{}
    foreach ($row in $snapshot) { $byId[[int]$row.ProcessId] = $row }
    foreach ($row in $snapshot) {
        if ($row.Name -ieq $ProcessName) { $tracked[[int]$row.ProcessId] = $row }
    }
    # Track descendants before asking the parent to exit, so orphaned cores remain
    # identifiable if the parent dies. Never match all sing-box/xray processes.
    do {
        $added = $false
        foreach ($row in $snapshot) {
            $parentOriginal = $tracked[[int]$row.ParentProcessId]
            $parentLive = $byId[[int]$row.ParentProcessId]
            if ($parentOriginal -and $parentLive -and $parentLive.Name -ieq $parentOriginal.Name -and
                $parentLive.CreationDate -eq $parentOriginal.CreationDate -and !$tracked.ContainsKey([int]$row.ProcessId)) {
                $tracked[[int]$row.ProcessId] = $row
                $added = $true
            }
        }
    } while ($added)
    @($snapshot | Where-Object {
        $original = $tracked[[int]$_.ProcessId]
        $original -and $_.Name -ieq $original.Name -and $_.CreationDate -eq $original.CreationDate
    })
}

try {
    $remaining = @(Get-AppProcesses)
    foreach ($row in $remaining | Where-Object { $_.Name -ieq $ProcessName }) {
        $targetProcess = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
        if ($targetProcess) { [void]$targetProcess.CloseMainWindow() }
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($remaining.Count -and $deadline.Elapsed.TotalSeconds -lt $GracefulTimeoutSeconds) {
        Start-Sleep -Milliseconds 200
        $remaining = @(Get-AppProcesses)
    }
    if ($remaining.Count) {
        foreach ($row in $remaining) {
            # Check identity again before forced termination: PIDs can be reused.
            $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.ProcessId)" -Property ProcessId, Name, CreationDate
            if ($live -and $live.Name -ieq $row.Name -and $live.CreationDate -eq $row.CreationDate) {
                Stop-Process -Id $row.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        $deadline.Restart()
        do {
            Start-Sleep -Milliseconds 200
            $remaining = @(Get-AppProcesses)
        } while ($remaining.Count -and $deadline.Elapsed.TotalSeconds -lt 3)
    }
    if ($remaining.Count) { throw 'Processes still running' }
    Write-Output 'Application stopped.'
    exit 0
} catch {
    # Only a fixed reason leaves the helper; no paths, command lines or user data.
    Write-Output 'Application shutdown failed.'
    exit 1
}
