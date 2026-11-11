$ErrorActionPreference='Stop'
$text=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'enforce-managed-host.ps1') -Raw
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Enforcement script did not parse.' }
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ApprovedPayload'},$true)
if (!$definition) { throw 'Payload validator missing.' }
# Extract the real read-only validator; never execute the enforcement body.
. ([scriptblock]::Create($definition.Extent.Text))
$exe='test-exe'; $dll='test-dll'; $exeHash='ADF4C6313FB717FB62B6447A67CF5406207228945ABC2FB799E04E89210975BE'; $dllHash='B5E885348145403A7A5C10D130DCD45916129D7D9037DE1FDFAF5F831E81B6E7'
$script:exists=$true; $script:redirected=$false
$script:hashes=@{$exe=$exeHash;$dll=$dllHash}
function Test-Path {param($LiteralPath,$PathType) return $script:exists}
function Test-CloudComNoReparsePath {param($Path) return !$script:redirected}
function Get-FileHash {param($LiteralPath,$Algorithm) return [pscustomobject]@{Hash=$script:hashes[$LiteralPath]}}
function Assert-Payload([bool]$Expected,[string]$Label) {
    if ((Test-ApprovedPayload) -ne $Expected) { throw "Failed: $Label" }
}
Assert-Payload $true 'stable 68 remains accepted'
$script:hashes[$exe]='ADF4C6313FB717FB62B6447A67CF5406207228945ABC2FB799E04E89210975BE'
$script:hashes[$dll]='C148DA5134774B9572E2251DB8A8FB189A91E5DF118E18CC7B63F6426D88E60E'
Assert-Payload $true 'reviewed 69 pair is accepted'
$script:hashes[$exe]='unknown-exe'
Assert-Payload $false 'unapproved executable is rejected'
$script:hashes[$exe]=$exeHash; $script:hashes[$dll]='unknown'
Assert-Payload $false 'unknown library is rejected'
$script:hashes[$dll]=$dllHash; $script:redirected=$true
Assert-Payload $false 'redirected payload is rejected'
$script:redirected=$false; $script:exists=$false
Assert-Payload $false 'missing payload is rejected'
Write-Output '6 payload release checks passed.'
