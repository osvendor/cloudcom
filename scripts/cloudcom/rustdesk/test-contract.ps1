# Pure/local checks only. Does not execute the probe or remediator on this computer.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"
foreach ($name in @('common.ps1','probe.ps1','repair.ps1')) {
    $tokens=$null; $errors=$null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw "Parse failed: $name" }
}
if ((Get-CloudComVersion '1.4.9+67') -ne [version]'1.4.9') { throw 'Build metadata handling failed.' }
if ((Get-CloudComVersion '1.4.10') -le (Get-CloudComVersion '1.4.9')) { throw 'Numeric version ordering failed.' }
$rejected=$false
try { $null=Get-CloudComVersion 'not-a-version' } catch { $rejected=$true }
if (!$rejected) { throw 'Unknown version was accepted.' }
$rejected=$false
try { Assert-CloudComTarget ('deliberately-not-' + $env:COMPUTERNAME) } catch { $rejected=$true }
if (!$rejected) { throw 'Device scope guard failed.' }
Write-Output 'PASS: PowerShell parsing, version ordering/build metadata, unknown-version refusal, device guard.'
