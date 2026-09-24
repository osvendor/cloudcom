param(
    [Parameter(Mandatory=$true)][string]$AllowedComputerName,
    [Parameter(Mandatory=$true)][string]$ConfigurationPath,
    [Parameter(Mandatory=$true)][string]$RendezvousServer,
    [Parameter(Mandatory=$true)][string]$RelayServer,
    [Parameter(Mandatory=$true)][string]$PublicKey,
    [string]$PinnedVersion = '1.4.9'
)
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $AllowedComputerName
try {
    $state = Get-CloudComRustDeskState $ConfigurationPath $RendezvousServer $RelayServer $PublicKey $PinnedVersion
    $verdict = if ($state.Healthy) { 'ok' } else { 'breach' }
    $detail = if ($state.Healthy) { 'RustDesk desired state verified.' } else { $state.Issues -join ', ' }
    Write-Output ('::breeze:monitor:: ' + (@{state=$verdict;detail=$detail} | ConvertTo-Json -Compress))
} catch { throw 'RustDesk probe could not evaluate desired state.' }
# A completed probe with an explicit marker represents drift; execution failures remain failures.
exit 0
