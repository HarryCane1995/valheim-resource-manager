param([string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\Valheim')
$ErrorActionPreference = 'Stop'
$projectPath = Join-Path $PSScriptRoot 'ValheimResourceManager.csproj'
$assemblyPath = Join-Path $GameDirectory 'valheim_Data\Managed\assembly_valheim.dll'
if (-not (Test-Path -LiteralPath $assemblyPath)) { throw "Game reference missing: $assemblyPath" }
& dotnet build $projectPath -c Release "-p:GameDirectory=$GameDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed' }
$outputPath = Join-Path $PSScriptRoot 'bin\Release\netstandard2.1\ValheimResourceManager.dll'
Get-FileHash -LiteralPath $outputPath -Algorithm SHA256
Write-Output "Built only: $outputPath. Game installation has not been modified."
