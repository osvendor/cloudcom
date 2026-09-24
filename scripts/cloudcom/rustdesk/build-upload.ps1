param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$common = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'common.ps1') -Raw
foreach ($name in @('probe','repair')) {
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "$name.ps1") -Raw
    $source = $source.Replace('. "$PSScriptRoot\common.ps1"', $common)
    $destination = Join-Path $OutputDirectory "$name-standalone.ps1"
    [IO.File]::WriteAllText($destination,$source,(New-Object Text.UTF8Encoding($false)))
    Write-Output $destination
}
