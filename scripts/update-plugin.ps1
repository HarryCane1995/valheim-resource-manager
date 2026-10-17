$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'installation-guards.ps1')

function Test-VRMGameRunning { return @(Get-Process -Name valheim -ErrorAction SilentlyContinue).Count -gt 0 }
function Get-VRMHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Get-VRMInstallationInventory([string]$Root,[string[]]$Excluded) {
    $files = [System.Collections.Generic.List[object]]::new()
    $directories = [System.Collections.Generic.List[string]]::new()
    $pending = [System.Collections.Generic.Queue[string]]::new();$pending.Enqueue($Root)
    while ($pending.Count -gt 0) {
        $directory=$pending.Dequeue();Assert-PlainDescendant $Root $directory
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            Assert-PlainDescendant $Root $entry.FullName
            $relative=$entry.FullName.Substring($Root.TrimEnd('\').Length+1)
            if ($entry.PSIsContainer) { $directories.Add($relative);$pending.Enqueue($entry.FullName) }
            elseif ($entry.FullName -notin $Excluded) { $files.Add([pscustomobject]@{path=$relative;length=$entry.Length;sha256=(Get-VRMHash $entry.FullName)}) }
        }
    }
    return [pscustomobject]@{directories=@($directories | Sort-Object);files=@($files | Sort-Object path)}
}
function Write-VRMAtomicManifest([string]$Path,[byte[]]$Bytes,[string]$ExpectedHash) {
    Assert-PlainDescendant $projectRoot $Path
    if ((Get-VRMHash $Path) -ne $ExpectedHash) { throw 'Installation receipt changed concurrently; refusing to overwrite it.' }
    $temporary=$Path+'.update-'+[guid]::NewGuid().ToString('N')+'.tmp'
    Assert-PlainDescendant $projectRoot $temporary
    try {
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() }
        if ((Get-VRMHash $Path) -ne $ExpectedHash) { throw 'Installation receipt changed during update.' }
        [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value)
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

# Check before reading credentials or touching installation files; an active process is deferred.
if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim is running. No installation files changed.'};return }
$manifestPath=Join-Path $projectRoot 'data\plugin-install.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'No installation receipt. Use the additive installer for a first installation.' }
$oldManifestBytes=[IO.File]::ReadAllBytes($manifestPath)
$oldManifestHash=Get-VRMHash $manifestPath
$manifest=Read-ValidatedInstallation $projectRoot $manifestPath
$gameRoot=$manifest.gameDirectory;$target=$manifest.plugin;$config=$manifest.config
$source=Join-Path $projectRoot 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
foreach ($path in @($target,$config,(Join-Path $gameRoot 'valheim_Data\Managed\assembly_valheim.dll'))) {
    Assert-PlainDescendant $gameRoot $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Installation is incomplete; nothing updated.' }
}
Assert-PlainDescendant $projectRoot $source
if ((Get-VRMHash (Join-Path $gameRoot 'valheim_Data\Managed\assembly_valheim.dll')) -ne $script:AuditedValheimAssemblyHash) { throw 'Valheim assembly differs from the audited build; nothing updated.' }
if ((Get-VRMHash $target) -ne $manifest.pluginHash) { throw 'Installed DLL differs from receipt; preserving it.' }
if ((Get-VRMHash $config) -ne $manifest.configHash) { throw 'Installed CFG differs from receipt; preserving it.' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Build the plugin before updating it.' }
$sourceAssembly=[Reflection.AssemblyName]::GetAssemblyName($source)
if ($sourceAssembly.Name -ne 'ValheimResourceManager') { throw 'Unexpected replacement assembly identity.' }
$sourceHash=Get-VRMHash $source
if ($sourceHash -eq $manifest.pluginHash) { [pscustomobject]@{status='UNCHANGED';pluginHash=$sourceHash;configPreserved=$true;receiptValidated=$true};return }

$stamp=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-update-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$backup=Join-Path $projectRoot ('data\integration-backup\'+$stamp)
Assert-PlainDescendant $projectRoot $backup
$beforeInventory=Get-VRMInstallationInventory $gameRoot @($target,$config)
if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim started while taking baseline. No installation files changed.'};return }
# No existing backup path is reused or overwritten.
New-Item -ItemType Directory -Path $backup | Out-Null
[IO.File]::Copy($target,(Join-Path $backup 'previous-plugin.dll'),$false)
[IO.File]::Copy($config,(Join-Path $backup 'previous-config.cfg'),$false)
[IO.File]::WriteAllBytes((Join-Path $backup 'previous-plugin-install.json'),$oldManifestBytes)
[IO.File]::Copy((Join-Path $manifest.backup 'before.json'),(Join-Path $backup 'before.json'),$false)
[IO.File]::Copy((Join-Path $manifest.backup 'after.json'),(Join-Path $backup 'previous-after.json'),$false)
Write-NewUtf8File (Join-Path $backup 'inventory-before.json') ($beforeInventory | ConvertTo-Json -Depth 6)
if ((Get-VRMHash (Join-Path $backup 'previous-plugin.dll')) -ne $manifest.pluginHash -or (Get-VRMHash (Join-Path $backup 'previous-config.cfg')) -ne $manifest.configHash) { throw 'Private backup hash verification failed; installation unchanged.' }

$record=@{}
foreach ($property in $manifest.PSObject.Properties) { $record[$property.Name]=$property.Value }
$record.pluginHash=$sourceHash;$record.configHash=$manifest.configHash;$record.backup=$backup
$record.updatedAt=(Get-Date).ToUniversalTime().ToString('o');$record.pluginVersion=$sourceAssembly.Version.ToString();$record.previousPluginHash=$manifest.pluginHash
Write-NewUtf8File (Join-Path $backup 'after.json') ($record | ConvertTo-Json -Depth 6)
$recordBytes=(New-Object System.Text.UTF8Encoding($false)).GetBytes(($record | ConvertTo-Json -Depth 6))
$recordHash=$null
$dllReplaced=$false;$receiptReplaced=$false
$temporary=Join-Path (Split-Path $target -Parent) ('.vrm-update-'+[guid]::NewGuid().ToString('N')+'.tmp')
Assert-PlainDescendant $gameRoot $temporary
try {
    # Fresh second checks immediately before the atomic DLL replacement.
    if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim started before replacement. Only a private backup was created.'};return }
    if ((Get-VRMHash $target) -ne $manifest.pluginHash -or (Get-VRMHash $config) -ne $manifest.configHash -or (Get-VRMHash $manifestPath) -ne $oldManifestHash) { throw 'Owned files or receipt changed concurrently; preserving them.' }
    [IO.File]::Copy($source,$temporary,$false)
    if ((Get-VRMHash $temporary) -ne $sourceHash) { throw 'Staged replacement hash mismatch.' }
    if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim started while staging. Installed DLL and CFG unchanged.'};return }
    [IO.File]::Replace($temporary,$target,[System.Management.Automation.Language.NullString]::Value);$dllReplaced=$true
    if ((Get-VRMHash $target) -ne $sourceHash) { throw 'Installed replacement hash mismatch.' }
    if ((Get-VRMHash $config) -ne $manifest.configHash) { throw 'CFG changed concurrently; update cannot be accepted.' }
    $afterInventory=Get-VRMInstallationInventory $gameRoot @($target,$config)
    Write-NewUtf8File (Join-Path $backup 'inventory-after.json') ($afterInventory | ConvertTo-Json -Depth 6)
    $sameFiles=($beforeInventory | ConvertTo-Json -Depth 6 -Compress) -ceq ($afterInventory | ConvertTo-Json -Depth 6 -Compress)
    if (-not $sameFiles) { throw 'Non-owned installation inventory changed; reverting only our DLL and receipt.' }
    Write-VRMAtomicManifest $manifestPath $recordBytes $oldManifestHash;$receiptReplaced=$true
    $recordHash=Get-VRMHash $manifestPath
    $readback=Read-ValidatedInstallation $projectRoot $manifestPath
    if ($readback.pluginHash -ne (Get-VRMHash $target) -or $readback.configHash -ne (Get-VRMHash $config)) { throw 'Post-update independent receipt readback failed.' }
    $proof=[pscustomobject]@{status='UPDATED';pluginVersion=$sourceAssembly.Version.ToString();previousPluginHash=$manifest.pluginHash;pluginHash=$sourceHash;configPreserved=$true;receiptValidated=$true;nonOwnedInventoryIdentical=$true;nonOwnedFiles=$afterInventory.files.Count;nonOwnedDirectories=$afterInventory.directories.Count;backup=$backup;checkedAt=(Get-Date).ToUniversalTime().ToString('o')}
    Write-NewUtf8File (Join-Path $backup 'verification.json') ($proof | ConvertTo-Json -Depth 6)
    $proof
} catch {
    # Restore only an unchanged file written by this invocation; never overwrite concurrent edits.
    if ($dllReplaced -and (Get-VRMHash $target) -eq $sourceHash -and -not (Test-VRMGameRunning)) {
        $rollback=Join-Path (Split-Path $target -Parent) ('.vrm-rollback-'+[guid]::NewGuid().ToString('N')+'.tmp')
        Assert-PlainDescendant $gameRoot $rollback
        try { [IO.File]::Copy((Join-Path $backup 'previous-plugin.dll'),$rollback,$false);[IO.File]::Replace($rollback,$target,[System.Management.Automation.Language.NullString]::Value) }
        finally { if (Test-Path -LiteralPath $rollback) { Remove-Item -LiteralPath $rollback } }
        if ($receiptReplaced -and $recordHash -and (Get-VRMHash $manifestPath) -eq $recordHash) { Write-VRMAtomicManifest $manifestPath $oldManifestBytes $recordHash }
    }
    throw
} finally { if (Test-Path -LiteralPath $temporary) { Assert-PlainDescendant $gameRoot $temporary;Remove-Item -LiteralPath $temporary } }
