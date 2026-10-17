$script:AuditedValheimAssemblyHash = '94998885B103D6E5F5480123EAEE0A093E82AF2DDEEEE37536C15BF555F24F3A'

function Assert-PlainDescendant([string]$Root,[string]$Path) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not [string]::Equals($rootFull,$pathFull,[StringComparison]::OrdinalIgnoreCase) -and -not $pathFull.StartsWith($rootFull+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the intended installation root.' }
    $current = $pathFull
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point or junction in installation path; refusing file operations.' }
        }
        $parent = Split-Path $current -Parent
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Write-NewUtf8File([string]$Path,[string]$Text) {
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}

function Read-ValidatedInstallation([string]$ProjectRoot,[string]$ManifestPath) {
    Assert-PlainDescendant $ProjectRoot $ManifestPath
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $manifest.gameAssemblyHash -ne $script:AuditedValheimAssemblyHash) { throw 'Installation manifest version or audited assembly validation failed.' }
    if (-not $manifest.gameDirectory -or -not [IO.Path]::IsPathRooted($manifest.gameDirectory)) { throw 'Manifest game directory must be absolute.' }
    $gameRoot = (Resolve-Path -LiteralPath $manifest.gameDirectory).Path
    Assert-PlainDescendant $gameRoot $gameRoot
    $expectedPlugin = Join-Path $gameRoot 'BepInEx\plugins\ValheimResourceManager\ValheimResourceManager.dll'
    $expectedConfig = Join-Path $gameRoot 'BepInEx\config\local.valheimresourcemanager.cfg'
    if (-not [string]::Equals($manifest.gameDirectory,$gameRoot,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($manifest.plugin,$expectedPlugin,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($manifest.config,$expectedConfig,[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest target validation failed.' }
    foreach ($path in @($expectedPlugin,$expectedConfig)) { Assert-PlainDescendant $gameRoot $path }
    if ($manifest.pluginHash -notmatch '^[a-fA-F0-9]{64}$' -or $manifest.configHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Manifest file hashes are invalid.' }
    $backupRoot = Join-Path $ProjectRoot 'data\integration-backup'
    if (-not $manifest.backup -or -not [IO.Path]::IsPathRooted($manifest.backup)) { throw 'Invalid baseline receipt path.' }
    Assert-PlainDescendant $backupRoot $manifest.backup
    if ([string]::Equals([IO.Path]::GetFullPath($manifest.backup),[IO.Path]::GetFullPath($backupRoot),[StringComparison]::OrdinalIgnoreCase)) { throw 'Baseline receipt must have its own directory.' }
    $beforePath=Join-Path $manifest.backup 'before.json'; $afterPath=Join-Path $manifest.backup 'after.json'
    foreach ($path in @($beforePath,$afterPath)) { Assert-PlainDescendant $backupRoot $path }
    $before=Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
    $after=Get-Content -LiteralPath $afterPath -Raw | ConvertFrom-Json
    if ($before.pluginExisted -isnot [bool] -or $before.configExisted -isnot [bool] -or $before.pluginExisted -or $before.configExisted -or -not [string]::Equals($before.gameDirectory,$gameRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Original absence baseline validation failed.' }
    foreach ($key in @('version','gameDirectory','gameAssemblyHash','plugin','pluginHash','config','configHash','backup','installedAt')) { if ($manifest.$key -ne $after.$key) { throw 'Manifest differs from independent installation receipt.' } }
    $manifest.gameDirectory=$gameRoot
    return $manifest
}
