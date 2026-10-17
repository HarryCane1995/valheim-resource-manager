$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pidPath = Join-Path $projectRoot '.runtime\server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'No owned backend PID.'; exit 0 }
$watchPidPath = Join-Path $projectRoot '.runtime\snapshot.pid'
if (Test-Path -LiteralPath $watchPidPath) {
    $watchProcessId = [int](Get-Content -LiteralPath $watchPidPath -Raw)
    $watchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$watchProcessId"
    $watchScript = Join-Path $PSScriptRoot 'watch_snapshot.py'
    if ($watchProcess -and $watchProcess.Name -eq 'python.exe' -and $watchProcess.CommandLine -and $watchProcess.CommandLine.TrimEnd().EndsWith(('"'+$watchScript+'"'),[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $watchProcessId }
    elseif ($watchProcess) { throw 'Snapshot PID belongs to another command; refusing to stop.' }
    Remove-Item -LiteralPath $watchPidPath
}
$serverProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId"
$serverScript = Join-Path $projectRoot 'server\main.mjs'
if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine -and $serverProcess.CommandLine.TrimEnd().EndsWith(('"'+$serverScript+'"'),[StringComparison]::OrdinalIgnoreCase)) {
    Stop-Process -Id $serverProcessId -ErrorAction Stop
    Write-Output 'Owned backend stopped. SQLite data retained.'
} elseif ($serverProcess) { throw 'PID now belongs to another process; refusing to stop.' }
Remove-Item -LiteralPath $pidPath
