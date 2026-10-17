param([string]$AuditedAssemblyPath='C:\Program Files (x86)\Steam\steamapps\common\Valheim\valheim_Data\Managed\assembly_valheim.dll')
$ErrorActionPreference = 'Stop'
# The real assembly is READ ONLY and copied into the temporary mock game. Neither
# installation script ever receives the actual game directory during these tests.
$projectSource = Split-Path $PSScriptRoot -Parent
$pluginSource = Join-Path $projectSource 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll'
if (-not (Test-Path -LiteralPath $pluginSource -PathType Leaf)) { throw 'Build the plugin before running isolated installation tests.' }
if ((Get-FileHash -LiteralPath $AuditedAssemblyPath -Algorithm SHA256).Hash -ne '94998885B103D6E5F5480123EAEE0A093E82AF2DDEEEE37536C15BF555F24F3A') { throw 'Tests need a read-only copy of the audited game assembly.' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('vrm-install-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$testRoot = (Resolve-Path -LiteralPath $testRoot).Path
$script:passed=0; $script:failed=0

function Assert-True($Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual,$Expected,[string]$Message) { if ($Actual -ne $Expected) { throw "$Message (actual=$Actual expected=$Expected)" } }
function Assert-TempPath([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test mutation escaped temporary root.' }
}
function Write-TestFile([string]$Path,[string]$Text) {
    Assert-TempPath $Path
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($Path,$Text)
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function New-Fixture {
    $folder=Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    $project=Join-Path $folder 'project';$game=Join-Path $folder 'mock-game'
    foreach ($path in @((Join-Path $project 'scripts'),(Join-Path $project 'plugin\bin\Release\netstandard2.1'),(Join-Path $project 'data'),(Join-Path $game 'valheim_Data\Managed'))) { Assert-TempPath $path; New-Item -ItemType Directory -Path $path -Force | Out-Null }
    foreach ($name in @('install-plugin.ps1','uninstall-plugin.ps1','installation-guards.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $project ('scripts\'+$name)) }
    Copy-Item -LiteralPath $pluginSource -Destination (Join-Path $project 'plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll')
    Copy-Item -LiteralPath $AuditedAssemblyPath -Destination (Join-Path $game 'valheim_Data\Managed\assembly_valheim.dll')
    Write-TestFile (Join-Path $project 'data\ingest-token.txt') ('a'*64)
    Write-TestFile (Join-Path $game 'BepInEx\core\BepInEx.dll') 'HARMLESS DUMMY LOADER - NEVER EXECUTED'
    Write-TestFile (Join-Path $game 'BepInEx\plugins\Unrelated\foreign.dll') 'foreign mod must remain unchanged'
    Write-TestFile (Join-Path $game 'save-sentinel\world.db') 'not a real save; immutable sentinel'
    return @{project=$project;game=$game;folder=$folder;manifest=(Join-Path $project 'data\plugin-install.json');plugin=(Join-Path $game 'BepInEx\plugins\ValheimResourceManager\ValheimResourceManager.dll');config=(Join-Path $game 'BepInEx\config\local.valheimresourcemanager.cfg');loader=(Join-Path $game 'BepInEx\core\BepInEx.dll');sentinel=(Join-Path $game 'save-sentinel\world.db')}
}
function Install($Fixture) { Assert-TempPath $Fixture.game; & (Join-Path $Fixture.project 'scripts\install-plugin.ps1') -GameDirectory $Fixture.game | Out-Null }
function Uninstall($Fixture) { & (Join-Path $Fixture.project 'scripts\uninstall-plugin.ps1') | Out-Null }
function Expect-Failure([scriptblock]$Action) { $didFail=$false;try { & $Action } catch { $didFail=$true };Assert-True $didFail 'Expected guarded script rejection.' }
function Save-Manifest($Fixture,$Value) { Write-TestFile $Fixture.manifest ($Value|ConvertTo-Json -Depth 10) }
function Case([string]$Name,[scriptblock]$Action) {
    try { & $Action; $script:passed++;Write-Output "PASS $Name" } catch { $script:failed++;Write-Output "FAIL $Name`: $($_.Exception.Message)" }
}

try {
    Case 'additive install records absence and preserves loader, unrelated mods and save sentinel' {
        $f=New-Fixture;$loader=Hash $f.loader;$sentinel=Hash $f.sentinel;$foreign=Hash (Join-Path $f.game 'BepInEx\plugins\Unrelated\foreign.dll')
        Install $f
        Assert-True (Test-Path -LiteralPath $f.plugin -PathType Leaf) 'Plugin missing'
        Assert-True (Test-Path -LiteralPath $f.config -PathType Leaf) 'Config missing'
        Assert-Equal (Hash $f.loader) $loader 'Loader changed'
        Assert-Equal (Hash $f.sentinel) $sentinel 'Save sentinel changed'
        Assert-Equal (Hash (Join-Path $f.game 'BepInEx\plugins\Unrelated\foreign.dll')) $foreign 'Other mod changed'
        $m=Get-Content -LiteralPath $f.manifest -Raw|ConvertFrom-Json
        $before=Get-Content -LiteralPath (Join-Path $m.backup 'before.json') -Raw|ConvertFrom-Json
        Assert-Equal $before.pluginExisted $false 'Absence baseline wrong'
        Assert-Equal $before.configExisted $false 'Absence baseline wrong'
        Assert-True (Test-Path -LiteralPath (Join-Path $m.backup 'after.json')) 'Independent receipt missing'
    }
    Case 'repeated install is idempotent and does not rewrite configuration or receipt' {
        $f=New-Fixture;Install $f;$before=@(Hash $f.plugin;Hash $f.config;Hash $f.manifest);$mtime=(Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks
        Install $f
        Assert-Equal ((@(Hash $f.plugin;Hash $f.config;Hash $f.manifest))-join ',') ($before-join ',') 'Repeated install rewrote files'
        Assert-Equal (Get-Item -LiteralPath $f.config).LastWriteTimeUtc.Ticks $mtime 'Config timestamp changed'
    }
    Case 'uninstall restores owned file absence and retains audit receipt and unrelated files' {
        $f=New-Fixture;Install $f;$m=Get-Content -LiteralPath $f.manifest -Raw|ConvertFrom-Json;Uninstall $f
        Assert-True (-not (Test-Path -LiteralPath $f.plugin)) 'Plugin retained'
        Assert-True (-not (Test-Path -LiteralPath $f.config)) 'Config retained'
        Assert-True (-not (Test-Path -LiteralPath $f.manifest)) 'Manifest retained'
        Assert-True (Test-Path -LiteralPath (Join-Path $m.backup 'before.json')) 'Audit baseline removed'
        Assert-True (Test-Path -LiteralPath $f.sentinel) 'Save sentinel removed'
        Assert-True (Test-Path -LiteralPath (Join-Path $f.game 'BepInEx\plugins\Unrelated\foreign.dll')) 'Other mod removed'
        Uninstall $f
    }
    Case 'existing foreign DLL and existing config are never overwritten' {
        foreach ($kind in @('plugin','config')) {
            $f=New-Fixture;Write-TestFile $f[$kind] 'foreign content';$old=Hash $f[$kind]
            Expect-Failure { Install $f };Assert-Equal (Hash $f[$kind]) $old 'Foreign content changed'
            Assert-True (-not (Test-Path -LiteralPath $f.manifest)) 'Manifest claimed foreign file'
        }
    }
    Case 'modified configuration survives repeat rejection and rollback; unmodified DLL is removed' {
        $f=New-Fixture;Install $f;$original=[IO.File]::ReadAllText($f.config);Write-TestFile $f.config ($original+"`r`n# user modification")
        $changed=Hash $f.config;Expect-Failure { Install $f };Uninstall $f
        Assert-Equal (Hash $f.config) $changed 'Modified config was deleted or changed'
        Assert-True (-not (Test-Path -LiteralPath $f.plugin)) 'Unmodified own DLL retained'
        Assert-True (Test-Path -LiteralPath $f.manifest) 'Recovery manifest lost'
        Write-TestFile $f.config $original;Uninstall $f;Assert-True (-not (Test-Path -LiteralPath $f.manifest)) 'Restored config could not complete rollback'
    }
    Case 'modified DLL and foreign files inside owned directory survive rollback' {
        $f=New-Fixture;Install $f;Write-TestFile $f.plugin 'modified DLL - do not delete'
        $foreign=Join-Path (Split-Path $f.plugin -Parent) 'foreign.txt';Write-TestFile $foreign 'preserve';$changed=Hash $f.plugin
        Uninstall $f;Assert-Equal (Hash $f.plugin) $changed 'Modified DLL changed';Assert-True (Test-Path -LiteralPath $foreign) 'Foreign file removed'
    }
    Case 'tampered manifest path cannot delete any owned or outside file' {
        $f=New-Fixture;Install $f;$outside=Join-Path $f.folder 'outside.txt';Write-TestFile $outside 'immutable outside sentinel'
        $m=Get-Content -LiteralPath $f.manifest -Raw|ConvertFrom-Json;$m.plugin=$outside;$m.pluginHash=Hash $outside;Save-Manifest $f $m
        Expect-Failure { Uninstall $f };Assert-True (Test-Path -LiteralPath $f.plugin) 'Owned plugin removed after manifest rejection';Assert-True (Test-Path -LiteralPath $f.config) 'Owned config removed after manifest rejection';Assert-Equal ([IO.File]::ReadAllText($outside)) 'immutable outside sentinel' 'Outside sentinel changed'
    }
    Case 'tampered game root is rejected against independent before/after receipt' {
        $f=New-Fixture;Install $f;$other=New-Fixture
        $m=Get-Content -LiteralPath $f.manifest -Raw|ConvertFrom-Json;$m.gameDirectory=$other.game;$m.plugin=$other.plugin;$m.config=$other.config;Save-Manifest $f $m
        Expect-Failure { Uninstall $f };Assert-True (Test-Path -LiteralPath $f.plugin) 'Original plugin removed after changed root';Assert-True (Test-Path -LiteralPath $f.config) 'Original config removed after changed root'
    }
    Case 'tampered manifest hashes are rejected before removals and repeat install' {
        $f=New-Fixture;Install $f;$m=Get-Content -LiteralPath $f.manifest -Raw|ConvertFrom-Json;$m.configHash='b'*64;Save-Manifest $f $m
        Expect-Failure { Uninstall $f };Expect-Failure { Install $f };Assert-True (Test-Path -LiteralPath $f.plugin) 'Plugin removed for tampered hashes';Assert-True (Test-Path -LiteralPath $f.config) 'Config removed for tampered hashes'
    }
    Case 'different game build is rejected before any integration writes' {
        $f=New-Fixture;Write-TestFile (Join-Path $f.game 'valheim_Data\Managed\assembly_valheim.dll') 'unsupported harmless assembly'
        Expect-Failure { Install $f };Assert-True (-not (Test-Path -LiteralPath $f.plugin)) 'Plugin installed into unsupported build';Assert-True (-not (Test-Path -LiteralPath $f.manifest)) 'Unsupported build manifest created'
    }
    Case 'junction ancestor cannot redirect installation outside its game root' {
        $f=New-Fixture;$junction=Join-Path $f.game 'BepInEx\config';$outside=Join-Path $f.folder 'outside-config';Assert-TempPath $junction;Assert-TempPath $outside
        New-Item -ItemType Directory -Path $outside | Out-Null
        New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
        try { Expect-Failure { Install $f };Assert-True (-not (Test-Path -LiteralPath (Join-Path $outside 'local.valheimresourcemanager.cfg'))) 'Config escaped through junction';Assert-True (-not (Test-Path -LiteralPath $f.plugin)) 'Partial plugin created despite junction' }
        finally { Remove-Item -LiteralPath $junction }
    }
} finally {
    # Recursive cleanup is constrained to the exact temporary root created here.
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith($tempBase+'\vrm-install-tests-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup root.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ("Installation tests: {0} passed, {1} failed. Real game files were read only; all mutations used temporary mocks." -f $script:passed,$script:failed)
if ($script:failed) { exit 1 }
