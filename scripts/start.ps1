param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
$health = $null
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:37841/api/health' -TimeoutSec 2
} catch { }
if ($null -ne $health) {
    if ($health.service -ne 'VALHEIM RESOURCE MANAGER') { throw 'Port occupied by another service.' }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:37841' }
    Write-Output 'Already running: http://127.0.0.1:37841'
    exit 0
}
if (@(Get-NetTCPConnection -LocalPort 37841 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Port 37841 is occupied and the expected backend did not answer; refusing another launch.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$runtimePath = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$serverScript = Join-Path $projectRoot 'server\main.mjs'
$serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log')
$serverProcess.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'server.pid') -Encoding Ascii
$ready = $false
for ($i=0; $i -lt 30; $i++) {
    try { $health = Invoke-RestMethod 'http://127.0.0.1:37841/api/health' -TimeoutSec 1; if ($health.service -eq 'VALHEIM RESOURCE MANAGER') { $ready = $true; break } } catch { }
    Start-Sleep -Milliseconds 300
}
if (-not $ready) { throw 'Backend did not start. See .runtime/server-error.log.' }
$snapshotConfig = Join-Path $projectRoot 'data\snapshot-source.json'
if (Test-Path -LiteralPath $snapshotConfig) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $watchScript = Join-Path $PSScriptRoot 'watch_snapshot.py'
        $watchProcess = Start-Process -FilePath $pythonCommand.Source -ArgumentList ('-u "'+$watchScript+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'snapshot.log') -RedirectStandardError (Join-Path $runtimePath 'snapshot-error.log')
        $watchProcess.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'snapshot.pid') -Encoding Ascii
    }
}
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:37841' }
Write-Output 'Running: http://127.0.0.1:37841'
