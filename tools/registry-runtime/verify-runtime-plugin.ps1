param(
    [string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\Valheim',
    [string]$PluginPath = (Join-Path $PSScriptRoot '..\..\plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll')
)
$ErrorActionPreference = 'Stop'
# Reuse the baseline compiled-IL audit for inventory, ownership, save and filesystem writes.
& (Join-Path $PSScriptRoot '..\game-audit\verify-plugin.ps1') -GameDirectory $GameDirectory -PluginPath $PluginPath | Out-Null
if (-not ('Mono.Cecil.ModuleDefinition' -as [type])) { Add-Type -LiteralPath (Join-Path $GameDirectory 'BepInEx\core\Mono.Cecil.dll') }
$module = [Mono.Cecil.ModuleDefinition]::ReadModule((Resolve-Path -LiteralPath $PluginPath).Path)
try {
    $calls = [System.Collections.Generic.List[object]]::new()
    $mutations = [System.Collections.Generic.List[string]]::new()
    $pending = [System.Collections.Generic.Queue[Mono.Cecil.TypeDefinition]]::new()
    foreach ($type in $module.Types) { $pending.Enqueue($type) }
    while ($pending.Count -gt 0) {
        $type = $pending.Dequeue()
        foreach ($nested in $type.NestedTypes) { $pending.Enqueue($nested) }
        foreach ($method in $type.Methods) {
            if (-not $method.HasBody) { continue }
            foreach ($instruction in $method.Body.Instructions) {
                if ($instruction.Operand -is [Mono.Cecil.MethodReference]) {
                    $calls.Add([pscustomobject]@{ Owner=$method.FullName; Target=$instruction.Operand.FullName })
                }
                # Existing read-only inventory hooks subscribe/unsubscribe these Action fields.
                # They are the only permitted writes to game-owned fields.
                if ($instruction.OpCode.Code -in @('Stfld','Stsfld') -and $instruction.Operand -is [Mono.Cecil.FieldReference] -and $instruction.Operand.DeclaringType.Scope.Name -match '^assembly_(valheim|guiutils|utils)$' -and $instruction.Operand.FullName -notin @('System.Action`1<ZDO> ZDOMan::m_onZDODestroyed','System.Action Inventory::m_onChanged')) {
                    $mutations.Add($instruction.Operand.FullName)
                }
            }
        }
    }
    $forbidden = @(
        'Localization::(?:\.ctor|SetLanguage|SetupLanguage|LoadCSV)',
        'ObjectDB::(?:UpdateRegisters|CopyOtherDB)',
        'UnityEngine\.(?:Object::Instantiate|Sprite::OverrideGeometry|Texture::set_)',
        'System\.Reflection\.(?:FieldInfo|PropertyInfo)::SetValue'
    )
    # Exact method names inspected in the installed Valheim 1.0.20 assembly.
    # Even the native respawn resolver changes the profile/loading reference;
    # the host-bed exporter must only read the saved custom spawn point.
    $forbiddenHostBed = @(
        'PlayerProfile::(?:SetCustomSpawnPoint|ClearCustomSpawnPoint)\(',
        'Game::(?:FindSpawnPoint|RemoveCustomSpawnPoint|RequestRespawn|_RequestRespawn|SpawnPlayer)\(',
        'ZNet::SetReferencePosition\(',
        '(?:Player|Character)::TeleportTo\(',
        'Bed::(?:SetOwner|Interact|RPC_SetOwner)\('
    )
    $unsafe = @($calls | Where-Object { $candidate=$_.Target; @($forbidden | Where-Object { $candidate -match $_ }).Count -gt 0 })
    if ($unsafe.Count -gt 0 -or $mutations.Count -gt 0) { throw "Forbidden localization, prefab, reflection or game-field mutation found in compiled IL: $($unsafe.Target -join ', '); $($mutations -join ', ')" }
    $unsafeHostBed = @($calls | Where-Object { $candidate=$_.Target; @($forbiddenHostBed | Where-Object { $candidate -match $_ }).Count -gt 0 })
    if ($unsafeHostBed.Count -gt 0) { throw "Forbidden bed, respawn, loading-reference or teleport mutation found in compiled IL: $($unsafeHostBed.Target -join ', ')" }
    $hostBedGetterCalls = @()
    foreach ($required in @('Game::GetPlayerProfile(', 'PlayerProfile::HaveCustomSpawnPoint(', 'PlayerProfile::GetCustomSpawnPoint(')) {
        $getterCalls = @($calls | Where-Object { $_.Target -match [regex]::Escape($required) })
        if ($getterCalls.Count -ne 1 -or @($getterCalls | Where-Object { $_.Owner -ne 'System.Object ValheimResourceManager.Plugin::ReadHostBed()' }).Count -gt 0) {
            throw "Expected exactly one host-profile getter call inside ReadHostBed: $required"
        }
        $hostBedGetterCalls += $getterCalls
    }
    $hostBedReaderCalls = @($calls | Where-Object { $_.Target -eq 'System.Object ValheimResourceManager.Plugin::ReadHostBed()' })
    if ($hostBedReaderCalls.Count -ne 1 -or $hostBedReaderCalls[0].Owner -ne 'System.Void ValheimResourceManager.Plugin::PumpSender(System.Single)') {
        throw 'Host-bed reader must only be called once from immutable packet construction in PumpSender, outside the asynchronous HTTP worker.'
    }
    $textureWrites = @($calls | Where-Object { $_.Target -match 'UnityEngine\.(?:Texture2D::(?:ReadPixels|SetPixels32|Apply)|ImageConversion::EncodeToPNG|Object::Destroy|RenderTexture::set_active|Graphics::Blit)' })
    if (@($textureWrites | Where-Object { $_.Owner -notmatch 'Plugin::ExportSprite\(' }).Count -gt 0) { throw 'Texture/export mutation call outside the isolated ExportSprite method.' }
    $destroyCalls = @($textureWrites | Where-Object { $_.Target -match 'UnityEngine.Object::Destroy' })
    $newTextures = @($calls | Where-Object { $_.Owner -match 'Plugin::ExportSprite\(' -and $_.Target -match 'UnityEngine.Texture2D::\.ctor' })
    if ($destroyCalls.Count -ne 2 -or $newTextures.Count -ne 2) { throw 'Expected exactly two private temporary Texture2D allocations and destruction call sites.' }
    foreach ($required in @('UnityEngine.Sprite::get_vertices','UnityEngine.Sprite::get_uv','UnityEngine.Sprite::get_triangles','UnityEngine.RenderTexture::ReleaseTemporary','UnityEngine.ImageConversion::EncodeToPNG','System.Security.Cryptography.SHA256::Create')) {
        if (-not ($calls.Target | Where-Object { $_ -match [regex]::Escape($required) })) { throw "Required authentic-sprite exporter path missing: $required" }
    }
    [pscustomobject]@{
        Result='PASS'
        Check='Extended runtime-registry compiled IL audit; no running-game or GPU assertion'
        Version=$module.Assembly.Name.Version.ToString()
        NonCallbackGameFieldWrites=$mutations.Count
        ForbiddenRegistryCalls=$unsafe.Count
        ForbiddenHostBedMutationCalls=$unsafeHostBed.Count
        HostBedProfileGetterCallSites=$hostBedGetterCalls.Count
        HostBedReaderCallSites=$hostBedReaderCalls.Count
        IsolatedTextureWriteCallSites=$textureWrites.Count
        PrivateTemporaryTextureAllocationSites=$newTextures.Count
        PluginSHA256=(Get-FileHash -LiteralPath $PluginPath -Algorithm SHA256).Hash
        Limitation='Direct IL/source audit does not prove transitive behavior of Unity, Harmony, game code or other installed mods.'
    } | ConvertTo-Json -Depth 4
}
finally { $module.Dispose() }
