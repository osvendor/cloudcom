$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'exchange-persistent.ps1'))
$start = $source.IndexOf("    if (`$request.operation -in @('group.alias.add','group.alias.remove')) {")
$end = $source.IndexOf("    if (`$request.operation -eq 'group.primary.set') {", $start)
if ($start -lt 0 -or $end -lt 0) { throw 'Alias handler missing' }
$handler = [scriptblock]::Create('foreach ($iteration in @(1)) {' + $source.Substring($start, $end-$start) + '}')
$groupId = '44444444-4444-4444-8444-444444444444'
$script:primary = 'primary@example.test'
function Get-EXORecipient { param($ExternalDirectoryObjectId, $ErrorAction) return Get-UnifiedGroup }
function Get-UnifiedGroup { param($Identity, $ErrorAction)
  [pscustomobject]@{ExternalDirectoryObjectId=$groupId; PrimarySmtpAddress=$script:primary; RecipientTypeDetails=$script:kind; IsDirSynced=$script:synced; EmailAddressPolicyEnabled=$script:policy; EmailAddresses=$script:addresses}
}
function Get-DistributionGroup { param($Identity, $ErrorAction) Get-UnifiedGroup }
function Get-Recipient { param($Identity, $ErrorAction) return $null }
function Get-AcceptedDomain { param($Identity, $ErrorAction) [pscustomobject]@{DomainName='example.test'} }
function Set-UnifiedGroup { param($Identity, $EmailAddresses, $ErrorAction)
  $script:writes++
  if ($EmailAddresses.ContainsKey('Add')) { $script:addresses += $EmailAddresses.Add }
  else { $script:addresses = @($script:addresses | Where-Object {$_ -ine $EmailAddresses.Remove}) }
}
function Set-DistributionGroup { param($Identity, $EmailAddresses, $ErrorAction) Set-UnifiedGroup -Identity $Identity -EmailAddresses $EmailAddresses }
function Send-Forwarding { param($id,$data) $script:result = $data }
foreach ($kind in @('GroupMailbox','MailUniversalDistributionGroup')) {
  $script:kind=$kind; $script:synced=$false; $script:policy=$false; $script:writes=0
  $script:addresses=@('SMTP:primary@example.test','smtp:existing@example.test','X500:/legacy')
  $request=@{operation='group.alias.add';parameters=@{groupId=$groupId;address='new@example.test'}}
  & $handler
  if ($script:writes -ne 1 -or -not $script:result.verified -or 'X500:/legacy' -notin $script:addresses) { throw 'Add failed or lost unrelated address' }
  & $handler
  if ($script:writes -ne 1) { throw 'Idempotent add wrote again' }
  $request.operation='group.alias.remove'; & $handler
  if ($script:writes -ne 2 -or 'smtp:new@example.test' -in $script:addresses -or 'smtp:existing@example.test' -notin $script:addresses) { throw 'Remove changed wrong aliases' }
  & $handler
  if ($script:writes -ne 2) { throw 'Idempotent removal wrote again' }
  foreach ($address in @('primary@example.test','routing@tenant.onmicrosoft.com')) {
    $request.parameters.address=$address; $rejected=$false
    try { & $handler } catch { $rejected=$true }
    if (-not $rejected -or $script:writes -ne 2) { throw 'Protected address mutation allowed' }
  }
  $request.parameters.address='existing@example.test'; $script:synced=$true; $rejected=$false
  try { & $handler } catch { $rejected=$true }
  if (-not $rejected -or $script:writes -ne 2) { throw 'Synced group mutation allowed' }
  if ($kind -eq 'MailUniversalDistributionGroup') {
    $script:synced=$false; $script:policy=$true; $rejected=$false
    try { & $handler } catch { $rejected=$true }
    if (-not $rejected -or $script:writes -ne 2) { throw 'Policy group mutation allowed' }
  }
}
Write-Output 'PASS: alias add/remove, idempotency, preserved addresses, primary/routing/synced/policy guards for both group types.'
