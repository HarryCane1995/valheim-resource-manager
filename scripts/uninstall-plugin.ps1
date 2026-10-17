$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'installation-guards.ps1')
$manifestPath = Join-Path $projectRoot 'data\plugin-install.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Output 'No installation manifest; nothing removed.'; return }
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
$manifest = Read-ValidatedInstallation $projectRoot $manifestPath
$gameRoot = $manifest.gameDirectory
$expectedPlugin = Join-Path $gameRoot 'BepInEx\plugins\ValheimResourceManager\ValheimResourceManager.dll'
$expectedConfig = Join-Path $gameRoot 'BepInEx\config\local.valheimresourcemanager.cfg'
$retained = $false
foreach ($entry in @(@{path=$expectedPlugin;hash=$manifest.pluginHash},@{path=$expectedConfig;hash=$manifest.configHash})) {
    Assert-PlainDescendant $gameRoot $entry.path
    if (Test-Path -LiteralPath $entry.path) {
        if (-not (Test-Path -LiteralPath $entry.path -PathType Leaf)) { throw 'Owned file path became a directory; refusing removal.' }
        if ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -eq $entry.hash) { Remove-Item -LiteralPath $entry.path; Write-Output ('Removed owned unchanged file: '+[IO.Path]::GetFileName($entry.path)) }
        else { $retained=$true; Write-Output ('Preserved modified file: '+[IO.Path]::GetFileName($entry.path)) }
    }
}
$ownedDirectory = Split-Path $expectedPlugin -Parent
Assert-PlainDescendant $gameRoot $ownedDirectory
if ((Test-Path -LiteralPath $ownedDirectory) -and @(Get-ChildItem -LiteralPath $ownedDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $ownedDirectory }
if (-not $retained) {
    Assert-PlainDescendant $projectRoot $manifestPath
    if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne $manifestHash) { throw 'Manifest changed during rollback; retained for review.' }
    Remove-Item -LiteralPath $manifestPath
}
Write-Output 'Game saves and other mods were not touched. A loaded plugin stops at the next normal game exit.'
