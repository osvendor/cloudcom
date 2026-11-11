$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'exchange-persistent.ps1'))
$start = $source.IndexOf('function Delegation-List(')
$end = $source.IndexOf("`nwhile (", $start)
if ($start -lt 0 -or $end -lt 0) { throw 'Delegation helper moved; review this test.' }
Invoke-Expression $source.Substring($start, $end - $start)
function Get-MailboxPermission {
  param($Identity, $ErrorAction)
  if ($Identity -ne 'owner@example.test') { throw 'wrong mailbox' }
  @(
    [pscustomobject]@{ User = 'delegate@example.test'; AccessRights = @('FullAccess'); Deny = $false; IsInherited = $false },
    [pscustomobject]@{ User = 'inherited@example.test'; AccessRights = @('FullAccess'); Deny = $false; IsInherited = $true },
    [pscustomobject]@{ User = 'NT AUTHORITY\SELF'; AccessRights = @('FullAccess'); Deny = $false; IsInherited = $false }
  )
}
function Get-RecipientPermission {
  param($Identity, $ErrorAction)
  if ($Identity -ne 'owner@example.test') { throw 'wrong mailbox' }
  @([pscustomobject]@{ Trustee = 'delegate@example.test'; AccessRights = @('SendAs'); Deny = $false; IsInherited = $false })
}
function Get-Recipient {
  param($Identity, $ErrorAction)
  if ($Identity -eq 'delegate@example.test' -or $Identity -eq 'CN=Delegate') {
    return [pscustomobject]@{ PrimarySmtpAddress = 'delegate@example.test' }
  }
  throw 'unresolved'
}
$mailbox = [pscustomobject]@{ PrimarySmtpAddress = 'owner@example.test'; GrantSendOnBehalfTo = @([pscustomobject]@{ DistinguishedName = 'CN=Delegate' }) }
$result = Delegation-List '11111111-1111-4111-8111-111111111111' $mailbox
if ($result.partial -or $result.entries.Count -ne 1 -or $result.entries[0].delegateAddress -ne 'delegate@example.test' -or
  -not $result.entries[0].fullAccess -or -not $result.entries[0].sendAs -or -not $result.entries[0].sendOnBehalf) {
  throw 'Current direct delegation inventory was incorrect.'
}
Write-Output 'Direct delegation inventory passed.'
