param(
    [string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\Valheim',
    [string]$PluginPath = (Join-Path $PSScriptRoot '..\..\plugin\bin\Release\netstandard2.1\ValheimResourceManager.dll')
)
$ErrorActionPreference = 'Stop'
$cecilPath = Join-Path $GameDirectory 'BepInEx\core\Mono.Cecil.dll'
Add-Type -LiteralPath $cecilPath
$module = [Mono.Cecil.ModuleDefinition]::ReadModule((Resolve-Path -LiteralPath $PluginPath).Path)
try {
    $calls = [System.Collections.Generic.List[string]]::new()
    $pendingTypes = [System.Collections.Generic.Queue[Mono.Cecil.TypeDefinition]]::new()
    foreach ($type in $module.Types) { $pendingTypes.Enqueue($type) }
    while ($pendingTypes.Count -gt 0) {
        $type = $pendingTypes.Dequeue()
        foreach ($nested in $type.NestedTypes) { $pendingTypes.Enqueue($nested) }
        foreach ($method in $type.Methods) {
            if (-not $method.HasBody) { continue }
            foreach ($instruction in $method.Body.Instructions) {
                if ($instruction.Operand -is [Mono.Cecil.MethodReference]) {
                    $calls.Add($instruction.Operand.FullName)
                }
            }
        }
    }
    $forbidden = @(
        '(?:^|\s)ZDO::(?:Set|Remove|Increase|Reset|Load|Deserialize)',
        'ZNetView::(?:ClaimOwnership|SetOwner|Destroy|InvokeRPC)',
        'ZDOMan::(?:DestroyZDO|CreateNewZDO|Load|LoadChunks|Save)',
        'Container::(?:Save|Load|Interact|RPC_|DropAllItems|AddDefaultItems)',
        'Inventory::(?:Add|Remove|Move|Stack|Load|Save)',
        '(?:System\.IO\.(?:File|Directory|FileStream))::(?:Write|Delete|Move|Create|Set|\.ctor)',
        '(?:Console|Terminal)::(?:TryRunCommand|InputText|RunCommand)'
    )
    $violations = @($calls | Where-Object { $candidate = $_; @($forbidden | Where-Object { $candidate -match $_ }).Count -gt 0 } | Sort-Object -Unique)
    if ($violations.Count -gt 0) { throw "Forbidden game or filesystem mutations found in compiled IL: $($violations -join ', ')" }
    if (-not ($calls | Where-Object { $_ -match 'System.Uri::get_IsLoopback' })) { throw 'Loopback endpoint guard missing from compiled IL.' }
    if (-not ($calls | Where-Object { $_ -match 'ItemDrop/ItemData::Load' })) { throw 'Native inventory item decoder missing from compiled IL.' }
    [pscustomobject]@{
        Result = 'PASS'
        Check = 'Compiled IL direct-call safety audit (not a running-game integration test)'
        MethodsReferenced = ($calls | Sort-Object -Unique).Count
        GameMutationCalls = $violations.Count
        PluginSHA256 = (Get-FileHash -LiteralPath $PluginPath -Algorithm SHA256).Hash
        References = @($module.AssemblyReferences | ForEach-Object { $_.FullName })
    } | ConvertTo-Json -Depth 4
}
finally { $module.Dispose() }
