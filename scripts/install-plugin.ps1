param([string]$GameDirectory='C:\Program Files (x86)\Steam\steamapps\common\Valheim')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'installation-guards.ps1')
$GameDirectory = (Resolve-Path -LiteralPath $GameDirectory).Path
$source = Join-Path $projectRoot 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
$ownedDirectory = Join-Path $GameDirectory 'BepInEx\plugins\ValheimResourceManager'
$target = Join-Path $ownedDirectory 'ValheimResourceManager.dll'
$config = Join-Path $GameDirectory 'BepInEx\config\local.valheimresourcemanager.cfg'
$tokenPath = Join-Path $projectRoot 'data\ingest-token.txt'
$manifestPath = Join-Path $projectRoot 'data\plugin-install.json'
$gameAssembly = Join-Path $GameDirectory 'valheim_Data\Managed\assembly_valheim.dll'
Assert-PlainDescendant $GameDirectory $GameDirectory
foreach ($path in @($gameAssembly,(Join-Path $GameDirectory 'BepInEx\core\BepInEx.dll'),$target,$config)) { Assert-PlainDescendant $GameDirectory $path }
Assert-PlainDescendant $projectRoot $manifestPath
if (-not (Test-Path -LiteralPath $gameAssembly -PathType Leaf)) { throw 'Audited Valheim managed assembly not found.' }
if ((Get-FileHash -LiteralPath $gameAssembly -Algorithm SHA256).Hash -ne $script:AuditedValheimAssemblyHash) { throw 'Game assembly differs from audited Valheim 1.0.20; refusing incompatible integration.' }
if (-not (Test-Path -LiteralPath (Join-Path $GameDirectory 'BepInEx\core\BepInEx.dll') -PathType Leaf)) { throw 'Existing BepInEx required; installer never replaces the loader.' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Build plugin first: powershell -File plugin/build.ps1' }
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw 'Start Resource Manager first to generate its private token.' }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid local token.' }
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Read-ValidatedInstallation $projectRoot $manifestPath
    if (-not [string]::Equals($manifest.gameDirectory,$GameDirectory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Existing manifest belongs to another game directory.' }
    if ($manifest.pluginHash -ne $sourceHash) { throw 'A different plugin build is recorded. Use reviewed rollback first.' }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or -not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Installation is partial; use reviewed rollback before retrying.' }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $manifest.pluginHash) { throw 'Installed plugin was modified; preserving it.' }
    if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $manifest.configHash) { throw 'Configuration was modified; preserving it. Use reviewed rollback if needed.' }
    Write-Output 'Already installed; validated DLL, configuration and receipt. No files changed.'
    return
}
if (Test-Path -LiteralPath $target) { throw 'Plugin target already exists; refusing to overwrite.' }
if (Test-Path -LiteralPath $config) { throw 'Config already exists; refusing to overwrite.' }
if (Test-Path -LiteralPath $ownedDirectory) { throw 'Target directory already exists; refusing to claim foreign files.' }
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$backup = Join-Path $projectRoot ('data\integration-backup\'+$stamp)
Assert-PlainDescendant $projectRoot $backup
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$baseline = @{gameDirectory=$GameDirectory;pluginExisted=$false;configExisted=$false;createdAt=(Get-Date).ToUniversalTime().ToString('o')}
Write-NewUtf8File (Join-Path $backup 'before.json') ($baseline | ConvertTo-Json)
$sourceId = [guid]::NewGuid().ToString('N')
$cfg = "[Connection]`r`nEndpoint = http://127.0.0.1:37841/api/ingest`r`nToken = $token`r`nSourceId = $sourceId`r`n`r`n[Indexing]`r`nEnabled = true`r`nScanHostPersistedZdos = true`r`n"
$pluginCreated = $false; $configCreated = $false; $directoryCreated = $false
try {
    New-Item -ItemType Directory -Path $ownedDirectory | Out-Null
    $directoryCreated = $true
    [IO.File]::Copy($source,$target,$false)
    $pluginCreated = $true
    $configDirectory = Split-Path $config -Parent
    if (-not (Test-Path -LiteralPath $configDirectory)) { New-Item -ItemType Directory -Path $configDirectory | Out-Null }
    Assert-PlainDescendant $GameDirectory $config
    Write-NewUtf8File $config $cfg
    $configCreated = $true
    $installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($installedHash -ne $sourceHash) { throw 'Installed DLL hash mismatch.' }
    $record = @{version=1;gameDirectory=$GameDirectory;gameAssemblyHash=$script:AuditedValheimAssemblyHash;plugin=$target;pluginHash=$installedHash;config=$config;configHash=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash;backup=$backup;installedAt=(Get-Date).ToUniversalTime().ToString('o')}
    Write-NewUtf8File (Join-Path $backup 'after.json') ($record | ConvertTo-Json)
    Write-NewUtf8File $manifestPath ($record | ConvertTo-Json)
} catch {
    # Roll back only files this invocation created, only within the verified game root.
    foreach ($entry in @(@{path=$target;created=$pluginCreated;hash=$sourceHash},@{path=$config;created=$configCreated;hash=$null})) {
        if ($entry.created -and (Test-Path -LiteralPath $entry.path -PathType Leaf)) {
            Assert-PlainDescendant $GameDirectory $entry.path
            $matches = if ($entry.hash) { (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -eq $entry.hash } else { [IO.File]::ReadAllText($entry.path) -eq $cfg }
            if ($matches) { Remove-Item -LiteralPath $entry.path }
        }
    }
    if ($directoryCreated -and (Test-Path -LiteralPath $ownedDirectory) -and @(Get-ChildItem -LiteralPath $ownedDirectory -Force).Count -eq 0) { Assert-PlainDescendant $GameDirectory $ownedDirectory; Remove-Item -LiteralPath $ownedDirectory }
    throw
}
Write-Output 'Added own DLL and config with a verified absence baseline. No existing files replaced. Integration loads at the next normal game startup; the current session continues.'
