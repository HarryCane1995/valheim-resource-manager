param([string]$AuditedAssemblyPath='C:\Program Files (x86)\Steam\steamapps\common\Valheim\valheim_Data\Managed\assembly_valheim.dll')
$ErrorActionPreference='Stop'
$projectSource=Split-Path $PSScriptRoot -Parent
$pluginSource=Join-Path $projectSource 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
if (-not (Test-Path -LiteralPath $pluginSource -PathType Leaf)) { throw 'Build the real plugin first.' }
if ((Get-FileHash -LiteralPath $AuditedAssemblyPath -Algorithm SHA256).Hash -ne '94998885B103D6E5F5480123EAEE0A093E82AF2DDEEEE37536C15BF555F24F3A') { throw 'Read-only audited reference required.' }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('vrm-update-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:passed=0;$script:failed=0
function Assert-True($Value,[string]$Label) { if (-not $Value) { throw $Label } }
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Write-TestFile([string]$Path,[string]$Value) {
    if (-not [IO.Path]::GetFullPath($Path).StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test path escaped exact temporary root.' }
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($Path,$Value)
}
function New-Fixture {
    $folder=Join-Path $testRoot ([guid]::NewGuid().ToString('N'));$project=Join-Path $folder 'project';$game=Join-Path $folder 'mock-game'
    foreach ($path in @((Join-Path $project 'scripts'),(Join-Path $project 'plugin\bin\Release\netstandard2.1'),(Join-Path $project 'data'),(Join-Path $game 'valheim_Data\Managed'))) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    foreach ($name in @('install-plugin.ps1','uninstall-plugin.ps1','installation-guards.ps1','update-plugin.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $project ('scripts\'+$name)) }
    $source=Join-Path $project 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
    Write-TestFile $source 'HARMLESS PREVIOUS DLL MOCK - NEVER EXECUTED'
    Write-TestFile (Join-Path $project 'data\ingest-token.txt') ('a'*64)
    Copy-Item -LiteralPath $AuditedAssemblyPath -Destination (Join-Path $game 'valheim_Data\Managed\assembly_valheim.dll')
    Write-TestFile (Join-Path $game 'BepInEx\core\BepInEx.dll') 'HARMLESS LOADER MOCK - NEVER EXECUTED'
    Write-TestFile (Join-Path $game 'BepInEx\plugins\Unrelated\foreign.dll') 'preserve unrelated mock mod'
    Write-TestFile (Join-Path $game 'save-sentinel\world.db') 'immutable fake save sentinel'
    & (Join-Path $project 'scripts\install-plugin.ps1') -GameDirectory $game | Out-Null
    Copy-Item -LiteralPath $pluginSource -Destination $source
    return @{project=$project;game=$game;source=$source;manifest=(Join-Path $project 'data\plugin-install.json');plugin=(Join-Path $game 'BepInEx\plugins\ValheimResourceManager\ValheimResourceManager.dll');config=(Join-Path $game 'BepInEx\config\local.valheimresourcemanager.cfg')}
}
function Update($Fixture) { return & (Join-Path $Fixture.project 'scripts\update-plugin.ps1') }
function Reject([scriptblock]$Action) { $rejected=$false;try { & $Action | Out-Null } catch { $rejected=$true };Assert-True $rejected 'Expected guard rejection.' }
function Case([string]$Name,[scriptblock]$Action) { try { & $Action;$script:passed++;Write-Output ('PASS '+$Name) } catch { $script:failed++;Write-Output ('FAIL '+$Name+': '+$_.Exception.Message) } }
try {
    Case 'update keeps CFG bytes and timestamp; all other files and directories identical' {
        $f=New-Fixture;$cfgHash=Hash $f.config;$cfgTime=(Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks;$oldPlugin=Hash $f.plugin
        $result=Update $f
        Assert-True ($result.status -eq 'UPDATED') 'No update status'
        Assert-True ((Hash $f.plugin) -eq (Hash $f.source)) 'Replacement DLL mismatch'
        Assert-True ((Hash $f.config) -eq $cfgHash -and (Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks -eq $cfgTime) 'CFG was rewritten'
        Assert-True $result.nonOwnedInventoryIdentical 'Foreign inventory mismatch'
        Assert-True ((Hash (Join-Path $result.backup 'previous-plugin.dll')) -eq $oldPlugin) 'Previous DLL backup mismatch'
        Assert-True ((Hash (Join-Path $result.backup 'previous-config.cfg')) -eq $cfgHash) 'Private CFG backup mismatch'
        . (Join-Path $f.project 'scripts\installation-guards.ps1')
        $receipt=Read-ValidatedInstallation $f.project $f.manifest
        Assert-True ($receipt.backup -eq $result.backup -and $receipt.pluginHash -eq (Hash $f.plugin)) 'Independent receipt validation failed'
        & (Join-Path $f.project 'scripts\uninstall-plugin.ps1') | Out-Null
        Assert-True (-not (Test-Path -LiteralPath $f.plugin) -and -not (Test-Path -LiteralPath $f.config)) 'Updated receipt is incompatible with uninstall'
        Assert-True (Test-Path -LiteralPath (Join-Path $f.game 'save-sentinel\world.db')) 'Uninstall removed fake save'
        Assert-True (Test-Path -LiteralPath (Join-Path $f.game 'BepInEx\plugins\Unrelated\foreign.dll')) 'Uninstall removed unrelated mock mod'
    }
    Case 'repeat update is idempotent and does not change receipt or CFG' {
        $f=New-Fixture;$first=Update $f;$receiptHash=Hash $f.manifest;$cfgHash=Hash $f.config
        $result=Update $f
        Assert-True ($result.status -eq 'UNCHANGED' -and (Hash $f.manifest) -eq $receiptHash -and (Hash $f.config) -eq $cfgHash) 'Idempotence failed'
    }
    Case 'modified installed DLL is preserved and receipt remains unchanged' {
        $f=New-Fixture;Write-TestFile $f.plugin 'concurrent custom edit';$dll=Hash $f.plugin;$receipt=Hash $f.manifest
        Reject { Update $f };Assert-True ((Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt) 'Modified DLL or receipt overwritten'
    }
    Case 'modified CFG prevents DLL replacement and is preserved' {
        $f=New-Fixture;Write-TestFile $f.config 'modified config sentinel';$cfg=Hash $f.config;$dll=Hash $f.plugin
        Reject { Update $f };Assert-True ((Hash $f.plugin) -eq $dll -and (Hash $f.config) -eq $cfg) 'Modified CFG or existing DLL overwritten'
    }
    Case 'tampered receipt cannot redirect the update' {
        $f=New-Fixture;$dll=Hash $f.plugin;$receipt=Get-Content -LiteralPath $f.manifest -Raw | ConvertFrom-Json
        $receipt.plugin=Join-Path $f.game 'BepInEx\plugins\Unrelated\foreign.dll';Write-TestFile $f.manifest ($receipt | ConvertTo-Json)
        Reject { Update $f };Assert-True ((Hash $f.plugin) -eq $dll) 'DLL changed after invalid receipt'
    }
    Case 'running game is deferred before any installation or receipt writes' {
        $f=New-Fixture;$dll=Hash $f.plugin;$receipt=Hash $f.manifest;$cfg=Hash $f.config
        function Get-Process { [CmdletBinding()]param([string]$Name) return [pscustomobject]@{ProcessName='valheim';Id=12345} }
        try { $result=Update $f } finally { Remove-Item -LiteralPath Function:\Get-Process }
        Assert-True ($result.status -eq 'DEFERRED') 'Active process was not deferred'
        Assert-True ((Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt -and (Hash $f.config) -eq $cfg) 'Running game fixture was mutated'
    }
    Case 'unsupported game assembly prevents all replacement' {
        $f=New-Fixture;$dll=Hash $f.plugin;Write-TestFile (Join-Path $f.game 'valheim_Data\Managed\assembly_valheim.dll') 'unsupported fake build'
        Reject { Update $f };Assert-True ((Hash $f.plugin) -eq $dll) 'Updated unsupported game fixture'
    }
    Case 'non-plugin replacement assembly is rejected' {
        $f=New-Fixture;$dll=Hash $f.plugin;Write-TestFile $f.source 'invalid replacement data'
        Reject { Update $f };Assert-True ((Hash $f.plugin) -eq $dll) 'Invalid replacement reached installed DLL'
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot);$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith($tempBase+'\vrm-update-tests-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe exact test cleanup root.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ("Plugin update tests: {0} passed, {1} failed. Real game files were read only; replacement/defer scenarios used temporary mocks." -f $script:passed,$script:failed)
if ($script:failed) { exit 1 }
