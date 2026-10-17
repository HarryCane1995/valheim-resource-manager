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
function Update($Fixture,[switch]$Running) {
    # Every process scenario is explicit; a real running game must not affect temporary fixtures.
    function Get-Process { [CmdletBinding()]param([string]$Name) if ($Running) { return [pscustomobject]@{ProcessName='valheim';Id=12345} } }
    return & (Join-Path $Fixture.project 'scripts\update-plugin.ps1')
}
function Reject([scriptblock]$Action,[string]$MessagePattern) {
    $rejected=$false;$message=''
    try { & $Action | Out-Null } catch { $rejected=$true;$message=$_.Exception.Message }
    Assert-True $rejected 'Expected guard rejection.'
    if ($MessagePattern) { Assert-True ($message -match $MessagePattern) 'Guard rejection did not identify the missing component.' }
}
function Case([string]$Name,[scriptblock]$Action) { try { & $Action;$script:passed++;Write-Output ('PASS '+$Name) } catch { $script:failed++;Write-Output ('FAIL '+$Name+': '+$_.Exception.Message) } }
function Remove-TestPath([string]$Path,[switch]$Recurse) {
    $full=[IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing removal outside exact temporary fixture root.' }
    Remove-Item -LiteralPath $full -Recurse:$Recurse -Force
}
function Other-GameFiles($Fixture) {
    return @((Get-ChildItem -LiteralPath $Fixture.game -File -Recurse -Force | Where-Object { $_.FullName -notin @($Fixture.plugin,$Fixture.config) } | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{path=$_.FullName.Substring($Fixture.game.Length+1);hash=(Hash $_.FullName)}
    }) | ConvertTo-Json -Compress)
}
function Format-OnlyConfig($Fixture) {
    $text=[IO.File]::ReadAllText($Fixture.config)
    $text='# BepInEx generated comment; no setting values changed.'+"`r`n`r`n"+$text.Replace('[Connection]',"[Connection]`r`n## Connection settings and generated descriptions").Replace('Endpoint = ','Endpoint=').Replace('[Indexing]',"`r`n[Indexing]`r`n# Indexing descriptions")
    Write-TestFile $Fixture.config $text
    [IO.File]::SetLastWriteTimeUtc($Fixture.config,[datetime]'2024-01-02T03:04:05Z')
}
function Inject-ReplacementFault($Fixture,[string]$Destination,[ValidateSet('before','after','missing-destination')][string]$Mode) {
    $path=Join-Path $Fixture.project 'scripts\update-plugin.ps1'
    $text=[IO.File]::ReadAllText($path)
    $pattern='function\s+Invoke-VRMFileReplacement\b'
    Assert-True ([regex]::Matches($text,$pattern).Count -eq 1) 'Replacement fault seam was not uniquely defined.'
    $text=[regex]::Replace($text,$pattern,'function Invoke-VRMOriginalFileReplacement')
    $quotedDestination=$Destination.Replace("'","''")
    $marker=Join-Path $Fixture.project 'data\replacement-fault-triggered.txt';$quotedMarker=$marker.Replace("'","''")
    $faultBody=switch ($Mode) {
        'before' { "throw 'INJECTED replacement failure before mutation.'" }
        'after' { "Invoke-VRMOriginalFileReplacement `$Source `$Destination `$Backup;throw 'INJECTED replacement failure after commit.'" }
        'missing-destination' { "[IO.File]::Move(`$Destination,`$Backup);throw 'INJECTED replacement failure after destination moved to backup.'" }
    }
    $prefix=@"
`$script:vrmReplacementFaultTriggered=`$false
function Invoke-VRMFileReplacement([string]`$Source,[string]`$Destination,[string]`$Backup) {
    if ([string]::IsNullOrWhiteSpace(`$Backup) -or (Test-Path -LiteralPath `$Backup)) { throw 'Replacement backup must be explicit, unique and absent.' }
    if (-not `$script:vrmReplacementFaultTriggered -and `$Destination -eq '$quotedDestination') {
        `$script:vrmReplacementFaultTriggered=`$true
        [IO.File]::WriteAllText('$quotedMarker','$Mode')
        $faultBody
    }
    Invoke-VRMOriginalFileReplacement `$Source `$Destination `$Backup
}

"@
    Write-TestFile $path ($prefix+$text)
    return $marker
}
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
        $result=Update $f -Running
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
    Case 'missing owned DLL is repaired while foreign sibling files and CFG remain identical' {
        $f=New-Fixture
        Write-TestFile (Join-Path (Split-Path $f.plugin -Parent) 'foreign-sibling.txt') 'unrelated file inside owned directory must survive'
        Remove-TestPath $f.plugin
        $cfg=Hash $f.config;$cfgTime=(Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks;$other=Other-GameFiles $f
        $result=Update $f
        Assert-True ($result.status -eq 'REPAIRED' -and $result.repairedMissingPlugin) 'Missing DLL was not explicitly reported as repaired'
        Assert-True ((Hash $f.plugin) -eq (Hash $f.source)) 'Repaired DLL differs from validated current build'
        Assert-True ((Hash $f.config) -eq $cfg -and (Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks -eq $cfgTime) 'Repair changed CFG bytes or timestamp'
        Assert-True ((Other-GameFiles $f) -ceq $other -and $result.nonOwnedInventoryIdentical) 'Repair changed foreign fixture files'
        . (Join-Path $f.project 'scripts\installation-guards.ps1')
        $receipt=Read-ValidatedInstallation $f.project $f.manifest
        Assert-True ($receipt.pluginHash -eq (Hash $f.source) -and $receipt.configHash -eq $cfg) 'Repaired receipt does not independently validate'
    }
    Case 'missing complete owned directory is recreated without changing other game files' {
        $f=New-Fixture;Remove-TestPath (Split-Path $f.plugin -Parent) -Recurse
        $other=Other-GameFiles $f;$cfg=Hash $f.config
        $result=Update $f
        Assert-True ($result.status -eq 'REPAIRED' -and $result.repairedMissingPlugin) 'Missing directory was not repaired'
        Assert-True ((Hash $f.plugin) -eq (Hash $f.source) -and (Hash $f.config) -eq $cfg) 'Owned directory repair has wrong DLL or changed CFG'
        Assert-True ((Other-GameFiles $f) -ceq $other -and $result.nonOwnedInventoryIdentical) 'Directory repair changed unrelated mock files'
    }
    Case 'missing DLL is repaired even when current source hash already equals the recorded build' {
        $f=New-Fixture;Update $f | Out-Null;Remove-TestPath $f.plugin
        $cfg=Hash $f.config;$other=Other-GameFiles $f
        $result=Update $f
        Assert-True ($result.status -eq 'REPAIRED' -and $result.repairedMissingPlugin -and (Hash $f.plugin) -eq (Hash $f.source)) 'Identical recorded source incorrectly skipped missing-DLL recovery'
        Assert-True ((Hash $f.config) -eq $cfg -and (Other-GameFiles $f) -ceq $other) 'Same-build repair changed CFG or other files'
    }
    Case 'missing CFG is diagnosed without restoring DLL or changing receipt' {
        $f=New-Fixture;Remove-TestPath $f.plugin;Remove-TestPath $f.config
        $receipt=Hash $f.manifest;$other=Other-GameFiles $f
        Reject { Update $f } 'CFG.*missing'
        Assert-True (-not (Test-Path -LiteralPath $f.plugin) -and -not (Test-Path -LiteralPath $f.config)) 'Missing CFG rejection created owned files'
        Assert-True ((Hash $f.manifest) -eq $receipt -and (Other-GameFiles $f) -ceq $other) 'Missing CFG rejection changed receipt or other files'
    }
    Case 'missing audited game assembly is diagnosed without changing owned files or receipt' {
        $f=New-Fixture;Remove-TestPath (Join-Path $f.game 'valheim_Data\Managed\assembly_valheim.dll')
        $dll=Hash $f.plugin;$cfg=Hash $f.config;$receipt=Hash $f.manifest;$other=Other-GameFiles $f
        Reject { Update $f } 'assembly.*missing'
        Assert-True ((Hash $f.plugin) -eq $dll -and (Hash $f.config) -eq $cfg -and (Hash $f.manifest) -eq $receipt -and (Other-GameFiles $f) -ceq $other) 'Missing game assembly rejection changed fixture files'
    }
    Case 'BepInEx format-only CFG changes preserve exact bytes and time while refreshing trusted receipt' {
        $f=New-Fixture;$first=Update $f
        $oldReceipt=Get-Content -LiteralPath $f.manifest -Raw | ConvertFrom-Json
        Assert-True ((Hash (Join-Path $first.backup 'previous-config.cfg')) -eq $oldReceipt.configHash) 'Fixture lacks SHA-trusted historical CFG'
        Format-OnlyConfig $f
        $cfg=Hash $f.config;$cfgTime=(Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks;$dll=Hash $f.plugin;$other=Other-GameFiles $f
        Assert-True ($cfg -ne $oldReceipt.configHash) 'Format-only fixture did not change CFG bytes'
        $result=Update $f
        Assert-True ($result.configReceiptRefreshed -and $result.configPreserved) 'Format-only CFG was not explicitly adopted'
        Assert-True ((Hash $f.config) -eq $cfg -and (Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks -eq $cfgTime) 'Format-only CFG was rewritten'
        Assert-True ((Hash $f.plugin) -eq $dll -and (Other-GameFiles $f) -ceq $other) 'Format-only receipt refresh changed other files'
        . (Join-Path $f.project 'scripts\installation-guards.ps1')
        $receipt=Read-ValidatedInstallation $f.project $f.manifest
        Assert-True ($receipt.configHash -eq $cfg) 'Refreshed receipt does not contain current CFG hash'
        $receiptHash=Hash $f.manifest;$again=Update $f
        Assert-True ($again.status -eq 'UNCHANGED' -and (Hash $f.manifest) -eq $receiptHash) 'Format-only adoption was not idempotent'
    }
    Case 'format-only CFG without a SHA-trusted original backup is rejected' {
        $f=New-Fixture;$first=Update $f
        Write-TestFile (Join-Path $first.backup 'previous-config.cfg') 'untrusted replacement backup'
        Format-OnlyConfig $f
        $cfg=Hash $f.config;$dll=Hash $f.plugin;$receipt=Hash $f.manifest
        Reject { Update $f }
        Assert-True ((Hash $f.config) -eq $cfg -and (Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt) 'Untrusted CFG baseline was accepted or files changed'
    }
    Case 'meaningful CFG value change is rejected even with a trusted previous CFG' {
        $f=New-Fixture;Update $f | Out-Null
        Write-TestFile $f.config ([IO.File]::ReadAllText($f.config).Replace('Enabled = true','Enabled = false'))
        $cfg=Hash $f.config;$dll=Hash $f.plugin;$receipt=Hash $f.manifest
        Reject { Update $f }
        Assert-True ((Hash $f.config) -eq $cfg -and (Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt) 'Meaningfully changed CFG was accepted or overwritten'
    }
    foreach ($variant in @('new','duplicate','malformed')) {
        Case ($variant+' CFG key is rejected without changing owned files or receipt') {
            $f=New-Fixture;Update $f | Out-Null
            $extra=switch ($variant) { 'new' { 'UnrecognizedSetting = true' }; 'duplicate' { 'Enabled = true' }; 'malformed' { 'Enabled without an equals sign' } }
            Write-TestFile $f.config ([IO.File]::ReadAllText($f.config)+"`r`n"+$extra+"`r`n")
            $cfg=Hash $f.config;$dll=Hash $f.plugin;$receipt=Hash $f.manifest
            Reject { Update $f }
            Assert-True ((Hash $f.config) -eq $cfg -and (Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt) 'Unsupported or duplicate CFG key was accepted or overwritten'
        }
    }
    Case 'missing DLL remains absent while a running game defers recovery' {
        $f=New-Fixture;Remove-TestPath (Split-Path $f.plugin -Parent) -Recurse
        $receipt=Hash $f.manifest;$cfg=Hash $f.config;$other=Other-GameFiles $f
        $result=Update $f -Running
        Assert-True ($result.status -eq 'DEFERRED') 'Active game did not defer missing-DLL recovery'
        Assert-True (-not (Test-Path -LiteralPath (Split-Path $f.plugin -Parent)) -and (Hash $f.manifest) -eq $receipt -and (Hash $f.config) -eq $cfg -and (Other-GameFiles $f) -ceq $other) 'Deferred recovery created files or changed receipt'
    }
    foreach ($destinationKind in @('DLL','receipt')) {
        foreach ($mode in @('before','after','missing-destination')) {
            Case ($destinationKind+' replacement '+$mode+' failure restores owned state and preserves foreign files') {
                $f=New-Fixture;$dll=Hash $f.plugin;$cfg=Hash $f.config;$cfgTime=(Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks;$receipt=Hash $f.manifest;$other=Other-GameFiles $f
                $destination=if ($destinationKind -eq 'DLL') { $f.plugin } else { $f.manifest }
                $faultMarker=Inject-ReplacementFault $f $destination $mode
                Reject { Update $f }
                Assert-True ((Test-Path -LiteralPath $faultMarker) -and [IO.File]::ReadAllText($faultMarker) -eq $mode) 'Expected replacement failure was not injected'
                Assert-True ((Hash $f.plugin) -eq $dll -and (Hash $f.manifest) -eq $receipt) 'Replacement failure left a changed or missing DLL/receipt'
                Assert-True ((Hash $f.config) -eq $cfg -and (Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks -eq $cfgTime -and (Other-GameFiles $f) -ceq $other) 'Replacement failure changed CFG or foreign fixture files'
                . (Join-Path $f.project 'scripts\installation-guards.ps1')
                $validated=Read-ValidatedInstallation $f.project $f.manifest
                Assert-True ($validated.pluginHash -eq $dll -and $validated.configHash -eq $cfg) 'Recovered receipt does not validate'
            }
        }
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot);$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith($tempBase+'\vrm-update-tests-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe exact test cleanup root.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ("Plugin update tests: {0} passed, {1} failed. Real game files were read only; replacement/defer scenarios used temporary mocks." -f $script:passed,$script:failed)
if ($script:failed) { exit 1 }
