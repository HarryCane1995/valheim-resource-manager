$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'installation-guards.ps1')

function Test-VRMGameRunning { return @(Get-Process -Name valheim -ErrorAction SilentlyContinue).Count -gt 0 }
function Get-VRMHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Get-VRMBytesHash([byte[]]$Bytes) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','') } finally { $algorithm.Dispose() }
}
# Kept as a small wrapper for fault injection in temporary test fixtures.
function Invoke-VRMFileReplacement([string]$Source,[string]$Destination,[string]$Backup) {
    if (-not $Backup -or (Test-Path -LiteralPath $Backup)) { throw 'Replacement requires a new explicit backup path.' }
    if (-not [string]::Equals([IO.Path]::GetPathRoot($Destination),[IO.Path]::GetPathRoot($Backup),[StringComparison]::OrdinalIgnoreCase)) { throw 'Replacement backup must be on the destination volume.' }
    [IO.File]::Replace($Source,$Destination,$Backup)
}
function Get-VRMInstallationInventory([string]$Root,[string[]]$Excluded) {
    $files=[System.Collections.Generic.List[object]]::new();$directories=[System.Collections.Generic.List[string]]::new()
    $pending=[System.Collections.Generic.Queue[string]]::new();$pending.Enqueue($Root)
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
function Get-VRMCfgSemanticHash([string]$Path,[string]$ExpectedHash) {
    # BepInEx rewrites comments and spacing. Only the complete known schema may be accepted.
    # Values never appear in diagnostics or in this function's return value.
    $allowed=@('Connection.Endpoint','Connection.Token','Connection.SourceId','Indexing.Enabled','Indexing.ScanHostPersistedZdos')
    $values=[System.Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $sections=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $bytes=[IO.File]::ReadAllBytes($Path)
    if ((Get-VRMBytesHash $bytes) -ne $ExpectedHash) { throw 'CFG or trusted baseline changed during verification; preserving installation.' }
    try { $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($bytes).TrimStart([char]0xfeff) }
    catch { throw 'CFG is not valid UTF-8; preserving it.' }
    $section=$null
    foreach ($raw in ($text -split '\r?\n')) {
        if ($raw -match '[\x00-\x08\x0b\x0c\x0e-\x1f]') { throw 'CFG contains invalid control characters; preserving it.' }
        $line=$raw.Trim()
        if (-not $line -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
        if ($line -match '^\[([^\[\]]+)\]$') {
            $section=$Matches[1].Trim()
            if ($section -cnotin @('Connection','Indexing') -or -not $sections.Add($section)) { throw 'CFG has an unknown or duplicate section; preserving it.' }
            continue
        }
        if (-not $section -or $line -notmatch '^([^=]+)=(.*)$') { throw 'CFG syntax is invalid; preserving it.' }
        $key=$section+'.'+$Matches[1].Trim();$value=$Matches[2].Trim()
        if ($key -cnotin $allowed -or $values.ContainsKey($key)) { throw 'CFG has an unknown or duplicate key; preserving it.' }
        $values.Add($key,$value)
    }
    if ($values.Count -ne $allowed.Count) { throw 'CFG is missing required keys; preserving it.' }
    $canonical=[ordered]@{}
    foreach ($key in $allowed) { $canonical[$key]=$values[$key] }
    return Get-VRMBytesHash ((New-Object Text.UTF8Encoding($false)).GetBytes(($canonical | ConvertTo-Json -Compress)))
}
function Find-VRMTrustedConfig([object]$Receipt) {
    $visited=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$node=$Receipt
    for ($depth=0;$depth -lt 16;$depth++) {
        if (-not $visited.Add($node.backup)) { throw 'Installation backup chain contains a cycle; preserving CFG.' }
        $candidate=Join-Path $node.backup 'previous-config.cfg'
        Assert-PlainDescendant (Join-Path $projectRoot 'data\integration-backup') $candidate
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Get-VRMHash $candidate) -eq $Receipt.configHash) { return $candidate }
        $previous=Join-Path $node.backup 'previous-plugin-install.json'
        if (-not (Test-Path -LiteralPath $previous -PathType Leaf)) { break }
        $prior=Read-ValidatedInstallation $projectRoot $previous
        foreach ($key in @('gameDirectory','plugin','config','installedAt')) {
            if ($prior.$key -cne $Receipt.$key) { throw 'Installation backup chain identity differs; preserving CFG.' }
        }
        if ($node.previousPluginHash -and $node.previousPluginHash -ne $prior.pluginHash) { throw 'Installation backup chain hashes differ; preserving CFG.' }
        $node=$prior
    }
    throw 'CFG bytes differ and no hash-verified original CFG is available; preserving installation.'
}
function Write-VRMAtomicManifest([string]$Path,[byte[]]$Bytes,[string]$ExpectedHash,[string]$Backup) {
    Assert-PlainDescendant $projectRoot $Path;Assert-PlainDescendant $projectRoot $Backup
    if ((Get-VRMHash $Path) -ne $ExpectedHash) { throw 'Installation receipt changed concurrently; refusing to overwrite it.' }
    $temporary=$Path+'.update-'+[guid]::NewGuid().ToString('N')+'.tmp';Assert-PlainDescendant $projectRoot $temporary
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() }
    if ((Get-VRMHash $Path) -ne $ExpectedHash) { throw 'Installation receipt changed during update; staged evidence retained.' }
    # A failing ReplaceFile may already have changed destination. Retain evidence on failure.
    Invoke-VRMFileReplacement $temporary $Path $Backup
}
function Remove-VRMVerifiedTemporary([string]$Root,[string]$Path,[string]$ExpectedHash) {
    if (Test-Path -LiteralPath $Path) {
        Assert-PlainDescendant $Root $Path
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-VRMHash $Path) -ne $ExpectedHash) { throw 'Transaction evidence changed; it has been preserved.' }
        Remove-Item -LiteralPath $Path
    }
}

# Defer before reading credentials or touching installation files.
if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim is running. No installation files changed.'};return }
$manifestPath=Join-Path $projectRoot 'data\plugin-install.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'No installation receipt. Use the additive installer for a first installation.' }
$oldManifestBytes=[IO.File]::ReadAllBytes($manifestPath);$oldManifestHash=Get-VRMHash $manifestPath
$manifest=Read-ValidatedInstallation $projectRoot $manifestPath
$gameRoot=$manifest.gameDirectory;$target=$manifest.plugin;$config=$manifest.config
$ownedDirectory=Split-Path $target -Parent;$pluginParent=Split-Path $ownedDirectory -Parent
$assembly=Join-Path $gameRoot 'valheim_Data\Managed\assembly_valheim.dll'
$source=Join-Path $projectRoot 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
foreach ($path in @($target,$config,$assembly,$ownedDirectory,$pluginParent)) { Assert-PlainDescendant $gameRoot $path }
if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { throw 'Valheim managed assembly is missing; nothing updated.' }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Resource Manager CFG is missing; automatic CFG recovery is disabled to preserve connection settings.' }
if (-not (Test-Path -LiteralPath $pluginParent -PathType Container)) { throw 'BepInEx plugins directory is missing; nothing updated.' }
if ((Test-Path -LiteralPath $ownedDirectory) -and -not (Test-Path -LiteralPath $ownedDirectory -PathType Container)) { throw 'Owned plugin directory became a file; preserving it.' }
if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Owned DLL path became a directory; preserving it.' }
$pluginExisted=Test-Path -LiteralPath $target -PathType Leaf;$directoryExisted=Test-Path -LiteralPath $ownedDirectory -PathType Container
Assert-PlainDescendant $projectRoot $source
if ((Get-VRMHash $assembly) -ne $script:AuditedValheimAssemblyHash) { throw 'Valheim assembly differs from the audited build; nothing updated.' }
if ($pluginExisted -and (Get-VRMHash $target) -ne $manifest.pluginHash) { throw 'Installed DLL differs from receipt; preserving it.' }
$configHash=Get-VRMHash $config;$configTime=(Get-Item -LiteralPath $config).LastWriteTimeUtc.Ticks
$configReceiptRefreshed=$configHash -ne $manifest.configHash
if ($configReceiptRefreshed) {
    $trusted=Find-VRMTrustedConfig $manifest
    if ((Get-VRMCfgSemanticHash $config $configHash) -ne (Get-VRMCfgSemanticHash $trusted $manifest.configHash)) { throw 'CFG settings differ from the verified backup; preserving installation.' }
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Build the plugin before updating it.' }
$sourceAssembly=[Reflection.AssemblyName]::GetAssemblyName($source)
if ($sourceAssembly.Name -ne 'ValheimResourceManager') { throw 'Unexpected replacement assembly identity.' }
$sourceHash=Get-VRMHash $source;$pluginNeedsWrite=(-not $pluginExisted) -or $sourceHash -ne $manifest.pluginHash
if (-not $pluginNeedsWrite -and -not $configReceiptRefreshed) { [pscustomobject]@{status='UNCHANGED';pluginHash=$sourceHash;configPreserved=$true;configReceiptRefreshed=$false;repairedMissingPlugin=$false;receiptValidated=$true};return }

$stamp=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-update-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$backup=Join-Path $projectRoot ('data\integration-backup\'+$stamp);Assert-PlainDescendant $projectRoot $backup
$beforeInventory=Get-VRMInstallationInventory $gameRoot @($target,$config)
if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim started while taking baseline. No installation files changed.'};return }
New-Item -ItemType Directory -Path $backup | Out-Null
if ($pluginExisted) { [IO.File]::Copy($target,(Join-Path $backup 'previous-plugin.dll'),$false) }
[IO.File]::Copy($config,(Join-Path $backup 'previous-config.cfg'),$false)
[IO.File]::WriteAllBytes((Join-Path $backup 'previous-plugin-install.json'),$oldManifestBytes)
[IO.File]::Copy((Join-Path $manifest.backup 'before.json'),(Join-Path $backup 'before.json'),$false)
[IO.File]::Copy((Join-Path $manifest.backup 'after.json'),(Join-Path $backup 'previous-after.json'),$false)
Write-NewUtf8File (Join-Path $backup 'inventory-before.json') ($beforeInventory | ConvertTo-Json -Depth 6)
if (($pluginExisted -and (Get-VRMHash (Join-Path $backup 'previous-plugin.dll')) -ne $manifest.pluginHash) -or (Get-VRMHash (Join-Path $backup 'previous-config.cfg')) -ne $configHash -or (Get-VRMHash (Join-Path $backup 'previous-plugin-install.json')) -ne $oldManifestHash) { throw 'Private backup hash verification failed; installation unchanged.' }
$record=@{};foreach ($property in $manifest.PSObject.Properties) { $record[$property.Name]=$property.Value }
$record.pluginHash=$sourceHash;$record.configHash=$configHash;$record.backup=$backup
$record.updatedAt=(Get-Date).ToUniversalTime().ToString('o');$record.pluginVersion=$sourceAssembly.Version.ToString();$record.previousPluginHash=$manifest.pluginHash
$record.previousConfigHash=$manifest.configHash;$record.repairedMissingPlugin=-not $pluginExisted
Write-NewUtf8File (Join-Path $backup 'after.json') ($record | ConvertTo-Json -Depth 6)
$recordBytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($record | ConvertTo-Json -Depth 6));$recordHash=Get-VRMBytesHash $recordBytes
$transaction=[guid]::NewGuid().ToString('N')
$temporary=Join-Path $ownedDirectory ('.vrm-update-'+$transaction+'.tmp')
$dllReplacementBackup=Join-Path $ownedDirectory ('.vrm-replaced-'+$transaction+'.bak')
$receiptReplacementBackup=$manifestPath+'.replaced-'+$transaction+'.bak'
$dllMutationAttempted=$false;$receiptMutationAttempted=$false;$directoryCreated=$false
foreach ($path in @($temporary,$dllReplacementBackup)) { Assert-PlainDescendant $gameRoot $path }
Assert-PlainDescendant $projectRoot $receiptReplacementBackup
try {
    if (Test-VRMGameRunning) { [pscustomobject]@{status='DEFERRED';reason='Valheim started before replacement. Only a private backup was created.'};return }
    $present=Test-Path -LiteralPath $target -PathType Leaf
    if ($present -ne $pluginExisted -or ($present -and (Get-VRMHash $target) -ne $manifest.pluginHash) -or (Get-VRMHash $config) -ne $configHash -or (Get-Item -LiteralPath $config).LastWriteTimeUtc.Ticks -ne $configTime -or (Get-VRMHash $manifestPath) -ne $oldManifestHash) { throw 'Owned files or receipt changed concurrently; preserving them.' }
    if ($pluginNeedsWrite) {
        if (-not $directoryExisted) { New-Item -ItemType Directory -Path $ownedDirectory | Out-Null;$directoryCreated=$true }
        Assert-PlainDescendant $gameRoot $ownedDirectory
        [IO.File]::Copy($source,$temporary,$false)
        if ((Get-VRMHash $temporary) -ne $sourceHash) { throw 'Staged replacement hash mismatch.' }
        if (Test-VRMGameRunning) { throw 'Valheim started while staging; replacement deferred and private evidence retained.' }
        if ((Test-Path -LiteralPath $target) -ne $pluginExisted -or ($pluginExisted -and (Get-VRMHash $target) -ne $manifest.pluginHash)) { throw 'DLL changed while staging; preserving it.' }
        $dllMutationAttempted=$true
        if ($pluginExisted) { Invoke-VRMFileReplacement $temporary $target $dllReplacementBackup } else { [IO.File]::Move($temporary,$target) }
        if ((Get-VRMHash $target) -ne $sourceHash) { throw 'Installed replacement hash mismatch.' }
        Remove-VRMVerifiedTemporary $gameRoot $dllReplacementBackup $manifest.pluginHash
    }
    if ((Get-VRMHash $config) -ne $configHash -or (Get-Item -LiteralPath $config).LastWriteTimeUtc.Ticks -ne $configTime) { throw 'CFG changed concurrently; update cannot be accepted.' }
    $afterInventory=Get-VRMInstallationInventory $gameRoot @($target,$config)
    Write-NewUtf8File (Join-Path $backup 'inventory-after.json') ($afterInventory | ConvertTo-Json -Depth 6)
    $expectedDirectories=@($beforeInventory.directories)
    if ($directoryCreated) { $expectedDirectories+=($ownedDirectory.Substring($gameRoot.TrimEnd('\').Length+1)) }
    $expectedInventory=[pscustomobject]@{directories=@($expectedDirectories | Sort-Object);files=$beforeInventory.files}
    if (($expectedInventory | ConvertTo-Json -Depth 6 -Compress) -cne ($afterInventory | ConvertTo-Json -Depth 6 -Compress)) { throw 'Non-owned installation inventory changed; reverting only our DLL and receipt.' }
    $receiptMutationAttempted=$true
    Write-VRMAtomicManifest $manifestPath $recordBytes $oldManifestHash $receiptReplacementBackup
    $readback=Read-ValidatedInstallation $projectRoot $manifestPath
    if ((Get-VRMHash $manifestPath) -ne $recordHash -or $readback.pluginHash -ne (Get-VRMHash $target) -or $readback.configHash -ne (Get-VRMHash $config)) { throw 'Post-update independent receipt readback failed.' }
    Remove-VRMVerifiedTemporary $projectRoot $receiptReplacementBackup $oldManifestHash
    $status=if ($pluginExisted) { 'UPDATED' } else { 'REPAIRED' }
    $proof=[pscustomobject]@{status=$status;pluginVersion=$sourceAssembly.Version.ToString();previousPluginHash=$manifest.pluginHash;pluginHash=$sourceHash;configPreserved=$true;configReceiptRefreshed=$configReceiptRefreshed;repairedMissingPlugin=(-not $pluginExisted);receiptValidated=$true;nonOwnedInventoryIdentical=$true;nonOwnedFiles=$afterInventory.files.Count;nonOwnedDirectories=$afterInventory.directories.Count;backup=$backup;checkedAt=(Get-Date).ToUniversalTime().ToString('o')}
    Write-NewUtf8File (Join-Path $backup 'verification.json') ($proof | ConvertTo-Json -Depth 6)
    $proof
} catch {
    $failure=$_;$issues=[System.Collections.Generic.List[string]]::new()
    # A failed native replacement may have changed the destination. Recover by observed hashes.
    try {
        if ($dllMutationAttempted) {
            if (Test-VRMGameRunning) { throw 'Game is running; DLL recovery deferred.' }
            Assert-PlainDescendant $gameRoot $target
            if ($pluginExisted) {
                $previousDll=Join-Path $backup 'previous-plugin.dll'
                if ((Get-VRMHash $previousDll) -ne $manifest.pluginHash) { throw 'Previous DLL backup changed.' }
                if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'DLL path changed type.' }
                $currentHash=if (Test-Path -LiteralPath $target -PathType Leaf) { Get-VRMHash $target } else { $null }
                if ($currentHash -ne $manifest.pluginHash) {
                    if ($currentHash -and $currentHash -ne $sourceHash) { throw 'DLL changed concurrently; preserved.' }
                    $rollback=Join-Path $ownedDirectory ('.vrm-rollback-'+[guid]::NewGuid().ToString('N')+'.tmp');Assert-PlainDescendant $gameRoot $rollback
                    [IO.File]::Copy($previousDll,$rollback,$false)
                    if ((Get-VRMHash $rollback) -ne $manifest.pluginHash -or (Test-VRMGameRunning)) { throw 'DLL recovery preconditions changed.' }
                    if ($currentHash) {
                        if ((Get-VRMHash $target) -ne $sourceHash) { throw 'DLL changed during recovery; preserved.' }
                        $rollbackBackup=Join-Path $ownedDirectory ('.vrm-rollback-'+[guid]::NewGuid().ToString('N')+'.bak');Assert-PlainDescendant $gameRoot $rollbackBackup
                        Invoke-VRMFileReplacement $rollback $target $rollbackBackup
                        Remove-VRMVerifiedTemporary $gameRoot $rollbackBackup $sourceHash
                    } else { [IO.File]::Move($rollback,$target) }
                }
                if ((Get-VRMHash $target) -ne $manifest.pluginHash) { throw 'DLL recovery verification failed.' }
            } else {
                if (Test-Path -LiteralPath $target) { Remove-VRMVerifiedTemporary $gameRoot $target $sourceHash }
            }
        }
    } catch { $issues.Add('DLL recovery requires review; installation evidence was retained.') }
    try {
        if ($receiptMutationAttempted) {
            if ($issues.Count) { throw 'DLL state is unresolved; receipt retained for review.' }
            Assert-PlainDescendant $projectRoot $manifestPath
            if ((Test-Path -LiteralPath $manifestPath) -and -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Receipt path changed type.' }
            $currentReceiptHash=if (Test-Path -LiteralPath $manifestPath -PathType Leaf) { Get-VRMHash $manifestPath } else { $null }
            if ($currentReceiptHash -ne $oldManifestHash) {
                if ($currentReceiptHash -and $currentReceiptHash -ne $recordHash) { throw 'Receipt changed concurrently; preserved.' }
                $previousReceipt=Join-Path $backup 'previous-plugin-install.json'
                if ((Get-VRMHash $previousReceipt) -ne $oldManifestHash) { throw 'Previous receipt backup changed.' }
                if ($currentReceiptHash) {
                    $receiptRollbackBackup=$manifestPath+'.rollback-'+[guid]::NewGuid().ToString('N')+'.bak'
                    Write-VRMAtomicManifest $manifestPath $oldManifestBytes $recordHash $receiptRollbackBackup
                    Remove-VRMVerifiedTemporary $projectRoot $receiptRollbackBackup $recordHash
                } else {
                    $receiptRestore=$manifestPath+'.restore-'+[guid]::NewGuid().ToString('N')+'.tmp';Assert-PlainDescendant $projectRoot $receiptRestore
                    [IO.File]::Copy($previousReceipt,$receiptRestore,$false)
                    if ((Get-VRMHash $receiptRestore) -ne $oldManifestHash) { throw 'Receipt recovery staging failed.' }
                    [IO.File]::Move($receiptRestore,$manifestPath)
                }
            }
            if ((Get-VRMHash $manifestPath) -ne $oldManifestHash) { throw 'Receipt recovery verification failed.' }
        }
    } catch { $issues.Add('Receipt recovery requires review; installation evidence was retained.') }
    if (-not $issues.Count) {
        try {
            Remove-VRMVerifiedTemporary $gameRoot $temporary $sourceHash
            Remove-VRMVerifiedTemporary $gameRoot $dllReplacementBackup $manifest.pluginHash
            Remove-VRMVerifiedTemporary $projectRoot $receiptReplacementBackup $oldManifestHash
            if ($directoryCreated -and (Test-Path -LiteralPath $ownedDirectory -PathType Container) -and @(Get-ChildItem -LiteralPath $ownedDirectory -Force).Count -eq 0) { Assert-PlainDescendant $gameRoot $ownedDirectory;Remove-Item -LiteralPath $ownedDirectory }
        } catch { $issues.Add('Changed transaction evidence was retained for review.') }
    }
    if ($issues.Count) {
        Write-NewUtf8File (Join-Path $backup 'recovery-required.json') (([pscustomobject]@{status='RECOVERY_REQUIRED';issues=@($issues);checkedAt=(Get-Date).ToUniversalTime().ToString('o')}) | ConvertTo-Json -Depth 4)
        throw 'Update failed; automatic recovery could not safely complete. Private backups and staged evidence were retained; review data/integration-backup.'
    }
    throw $failure
}
