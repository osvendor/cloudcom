$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'exchange-persistent.ps1'))
$bootstrap = @'
      Import-Module ExchangeOnlineManagement
      $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certificatePath, $config.privateKeyPath)
      Connect-ExchangeOnline -AppId $config.clientId -Certificate $certificate -Organization $config.exchangeOrganization -ShowBanner:$false
      $boundTenant = [string]$request.tenantId
'@
if (-not $source.Contains($bootstrap)) { throw 'Exchange bootstrap changed; review the test harness.' }
$source = $source.Replace($bootstrap, '      $boundTenant = [string]$request.tenantId')
$fake = @'
function Get-AcceptedDomain { param($Identity, $ErrorAction) [pscustomobject]@{ DomainName = 'example.test' } }
 $script:sharedCreated = $false
function Get-Recipient { param($Identity, $ErrorAction)
  if ($Identity -eq 'taken@example.test') { return [pscustomobject]@{
    ExternalDirectoryObjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; PrimarySmtpAddress = $Identity } }
  if ($script:sharedCreated -and $Identity -eq 'shared@example.test') { return [pscustomobject]@{
    ExternalDirectoryObjectId = '88888888-8888-4888-8888-888888888888'; PrimarySmtpAddress = $Identity } }
  return $null
}
function New-DistributionGroup { param($Name, $PrimarySmtpAddress, $ErrorAction)
  if ($Name -ne 'QA Distribution' -or $PrimarySmtpAddress -ne 'qa@example.test') { throw 'Wrong write target' }
  [pscustomobject]@{ Name = $Name }
}
$script:distributionRequiresAuth = $true
$script:distributionName = 'QA Distribution'
$script:distributionPrimary = 'qa@example.test'
$script:unifiedRequiresAuth = $false
$script:unifiedPrimary = 'unified@example.test'
function Get-DistributionGroup { param($Identity, $ErrorAction)
  if ($Identity -eq 'policy@example.test') { return [pscustomobject]@{
    ExternalDirectoryObjectId = 'abababab-abab-4bab-8bab-abababababab';
    RecipientTypeDetails = 'MailUniversalDistributionGroup'; PrimarySmtpAddress = $Identity;
    DisplayName = 'Policy list'; RequireSenderAuthenticationEnabled = $true;
    EmailAddressPolicyEnabled = $true; EmailAddresses = @('SMTP:policy@example.test') } }
  if ($Identity -notin @('qa@example.test','qa-new@example.test')) { throw 'Wrong distribution lookup' }
  [pscustomobject]@{ ExternalDirectoryObjectId = '55555555-5555-4555-8555-555555555555';
    RecipientTypeDetails = 'MailUniversalDistributionGroup'; PrimarySmtpAddress = $script:distributionPrimary;
    DisplayName = $script:distributionName; RequireSenderAuthenticationEnabled = $script:distributionRequiresAuth;
    EmailAddressPolicyEnabled = $false; EmailAddresses = @("SMTP:$script:distributionPrimary",'smtp:qa@example.test','smtp:qa-old@example.test','X500:/o=legacy') }
}
function Set-DistributionGroup { param($Identity, $RequireSenderAuthenticationEnabled, $DisplayName, $PrimarySmtpAddress, $ErrorAction)
  if ($Identity -ne 'qa@example.test') { throw 'Wrong distribution update' }
  if ($PSBoundParameters.ContainsKey('PrimarySmtpAddress')) {
    if ($PrimarySmtpAddress -ne 'qa-new@example.test') { throw 'Wrong distribution address' }
    $script:distributionPrimary = $PrimarySmtpAddress
  } elseif ($PSBoundParameters.ContainsKey('DisplayName')) {
    if ($DisplayName -ne 'QA Renamed') { throw 'Wrong distribution name' }
    $script:distributionName = $DisplayName
  } elseif ($RequireSenderAuthenticationEnabled -is [bool]) { $script:distributionRequiresAuth = $RequireSenderAuthenticationEnabled }
  else { throw 'Wrong distribution setting' }
}
function Get-UnifiedGroup { param($Identity, $ErrorAction)
  if ($Identity -notin @('unified@example.test','unified-new@example.test')) { throw 'Wrong unified group identity' }
  [pscustomobject]@{ ExternalDirectoryObjectId = '99999999-9999-4999-8999-999999999999';
    RecipientTypeDetails = 'GroupMailbox'; PrimarySmtpAddress = $script:unifiedPrimary;
    DisplayName = 'QA Unified'; RequireSenderAuthenticationEnabled = $script:unifiedRequiresAuth;
    EmailAddresses = @("SMTP:$script:unifiedPrimary",'smtp:unified@example.test','smtp:unified-old@example.test') }
}
function Set-UnifiedGroup { param($Identity, $RequireSenderAuthenticationEnabled, $PrimarySmtpAddress, $ErrorAction)
  if ($Identity -ne 'unified@example.test') { throw 'Wrong unified update' }
  if ($PSBoundParameters.ContainsKey('PrimarySmtpAddress')) {
    if ($PrimarySmtpAddress -ne 'unified-new@example.test') { throw 'Wrong unified address' }
    $script:unifiedPrimary = $PrimarySmtpAddress
  } elseif ($RequireSenderAuthenticationEnabled -is [bool]) { $script:unifiedRequiresAuth = $RequireSenderAuthenticationEnabled }
  else { throw 'Wrong unified setting' }
}
function New-Mailbox { param([switch]$Shared, $Name, $DisplayName, $PrimarySmtpAddress, $ErrorAction)
  if (-not $Shared -or $Name -ne 'QA Shared' -or $DisplayName -ne 'QA Shared' -or
    $PrimarySmtpAddress -ne 'shared@example.test') { throw 'Wrong mailbox creation target' }
  $script:sharedCreated = $true
  [pscustomobject]@{ Name = $Name }
}
$script:convertedToShared = $false
function Set-Mailbox { param($Identity, $Type, $ErrorAction)
  if ($Identity -ne 'convert@example.test' -or $Type -ne 'Shared') { throw 'Wrong conversion target' }
  $script:convertedToShared = $true
}
function Get-Mailbox { param($Identity, $ErrorAction)
  if ($Identity -eq 'synced@example.test') { return [pscustomobject]@{
    ExternalDirectoryObjectId = '12121212-1212-4212-8212-121212121212';
    RecipientTypeDetails = 'UserMailbox'; PrimarySmtpAddress = 'synced@example.test'; IsDirSynced = $true;
    ArchiveStatus = 'None'; LitigationHoldEnabled = $false; InPlaceHolds = @() } }
  if ($Identity -eq 'convert@example.test') { return [pscustomobject]@{
    ExternalDirectoryObjectId = '77777777-7777-4777-8777-777777777777';
    RecipientTypeDetails = $(if ($script:convertedToShared) { 'SharedMailbox' } else { 'UserMailbox' });
    PrimarySmtpAddress = 'convert@example.test'; IsDirSynced = $false } }
  [pscustomobject]@{ ExternalDirectoryObjectId = '88888888-8888-4888-8888-888888888888';
    RecipientTypeDetails = 'SharedMailbox'; PrimarySmtpAddress = 'shared@example.test';
    ArchiveStatus = 'None'; IsDirSynced = $false; LitigationHoldEnabled = $false; InPlaceHolds = @() }
}
function Get-EXOMailbox { param($ExternalDirectoryObjectId, $Properties, $ErrorAction)
  if ($ExternalDirectoryObjectId -eq '12121212-1212-4212-8212-121212121212') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId; RecipientTypeDetails = 'UserMailbox';
    PrimarySmtpAddress = 'synced@example.test' } }
  if ($ExternalDirectoryObjectId -eq '77777777-7777-4777-8777-777777777777') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId;
    RecipientTypeDetails = $(if ($script:convertedToShared) { 'SharedMailbox' } else { 'UserMailbox' });
    PrimarySmtpAddress = 'convert@example.test' } }
  [pscustomobject]@{ ExternalDirectoryObjectId = $ExternalDirectoryObjectId;
    RecipientTypeDetails = 'SharedMailbox'; PrimarySmtpAddress = 'shared@example.test' }
}
function Get-EXOMailboxStatistics { param($Identity, $ErrorAction)
  [pscustomobject]@{ TotalItemSize = '123' }
}
$script:memberPresent = $false
function Get-EXORecipient { param($ExternalDirectoryObjectId, $ErrorAction)
  if ($ExternalDirectoryObjectId -eq 'abababab-abab-4bab-8bab-abababababab') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId; RecipientTypeDetails = 'MailUniversalDistributionGroup';
    PrimarySmtpAddress = 'policy@example.test' } }
  if ($ExternalDirectoryObjectId -eq '99999999-9999-4999-8999-999999999999') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId; RecipientTypeDetails = 'GroupMailbox';
    PrimarySmtpAddress = 'unified@example.test' } }
  if ($ExternalDirectoryObjectId -eq '55555555-5555-4555-8555-555555555555') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId; RecipientTypeDetails = 'MailUniversalDistributionGroup';
    PrimarySmtpAddress = 'qa@example.test' } }
  if ($ExternalDirectoryObjectId -eq '88888888-8888-4888-8888-888888888888') { return [pscustomobject]@{
    ExternalDirectoryObjectId = $ExternalDirectoryObjectId; RecipientTypeDetails = 'SharedMailbox';
    PrimarySmtpAddress = 'shared@example.test' } }
  throw 'Unknown recipient'
}
function Get-DistributionGroupMember { param($Identity, $ResultSize, $ErrorAction)
  if ($Identity -ne 'qa@example.test') { throw 'Wrong group' }
  if ($script:memberPresent) { return [pscustomobject]@{ ExternalDirectoryObjectId = '88888888-8888-4888-8888-888888888888';
    DisplayName = 'QA Shared'; PrimarySmtpAddress = 'shared@example.test' } }
}
function Add-DistributionGroupMember { param($Identity, $Member, $ErrorAction)
  if ($Identity -ne 'qa@example.test' -or $Member -ne 'shared@example.test') { throw 'Wrong membership target' }
  $script:memberPresent = $true
}
function Remove-DistributionGroupMember { param($Identity, $Member, $Confirm, $ErrorAction)
  if ($Identity -ne 'qa@example.test' -or $Member -ne 'shared@example.test' -or $Confirm) { throw 'Wrong membership removal' }
  $script:memberPresent = $false
}
'@
$temp = Join-Path ([IO.Path]::GetTempPath()) ("exchange-distribution-test-{0}.ps1" -f [guid]::NewGuid())
$process = $null
try {
  [IO.File]::WriteAllText($temp, "$fake`n$source")
  $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
  foreach ($part in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $temp)) { $start.ArgumentList.Add($part) }
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['CLOUDCOM_EXCHANGE_CONFIG'] = '{}'
  $process = [Diagnostics.Process]::Start($start)
  $request = @{ requestId = '11111111-1111-4111-8111-111111111111'; tenantId = '33333333-3333-4333-8333-333333333333';
    operation = 'distribution.create'; parameters = @{ name = 'QA Distribution'; primarySmtpAddress = 'qa@example.test' } }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Distribution write timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or $result.data.primarySmtpAddress -ne 'qa@example.test' -or
    $result.data.id -ne '55555555-5555-4555-8555-555555555555') { throw "Distribution result invalid: $($read.Result)" }
  $request.requestId = '99999999-9999-4999-8999-999999999999'
  $request.operation = 'shared.create'
  $request.parameters.name = 'QA Shared'
  $request.parameters.primarySmtpAddress = 'shared@example.test'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Shared mailbox write timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or $result.data.primarySmtpAddress -ne 'shared@example.test' -or
    $result.data.id -ne '88888888-8888-4888-8888-888888888888') { throw "Shared mailbox result invalid: $($read.Result)" }
  $request.requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $request.operation = 'distribution.member.set'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555';
    memberId = '88888888-8888-4888-8888-888888888888'; enabled = $true }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Membership add timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.enabled -or -not $result.data.changed -or -not $result.data.verified) {
    throw "Membership add invalid: $($read.Result)" }
  $request.requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  $request.operation = 'distribution.members.get'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Membership read timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.complete -or $result.data.members.Count -ne 1 -or
    $result.data.members[0].primarySmtpAddress -ne 'shared@example.test') { throw "Membership read invalid: $($read.Result)" }
  $request.requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $request.operation = 'group.settings.get'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Group settings read timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or $result.data.kind -ne 'distribution' -or
    $result.data.primarySmtpAddress -ne 'qa@example.test' -or -not $result.data.requireSenderAuthenticationEnabled -or
    $result.data.emailAddressPolicyEnabled -or $result.data.aliases.Count -ne 1 -or
    $result.data.aliases[0] -ne 'qa-old@example.test') {
    throw "Group settings invalid: $($read.Result)" }
  $request.requestId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  $request.parameters.groupId = '99999999-9999-4999-8999-999999999999'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Unified group settings read timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or $result.data.kind -ne 'microsoft365' -or
    $result.data.primarySmtpAddress -ne 'unified@example.test' -or $result.data.requireSenderAuthenticationEnabled -or
    $null -ne $result.data.emailAddressPolicyEnabled -or $result.data.aliases.Count -ne 1 -or
    $result.data.aliases[0] -ne 'unified-old@example.test') {
    throw "Unified group settings invalid: $($read.Result)" }
  $request.requestId = '12121212-1212-4212-8212-121212121212'
  $request.operation = 'group.external.set'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555'; allowExternalSenders = $true }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Distribution sender update timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or -not $result.data.allowExternalSenders) {
    throw "Distribution sender update invalid: $($read.Result)" }
  $request.requestId = '13131313-1313-4313-8313-131313131313'
  $request.parameters = @{ groupId = '99999999-9999-4999-8999-999999999999'; allowExternalSenders = $false }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Unified sender update timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or $result.data.allowExternalSenders) {
    throw "Unified sender update invalid: $($read.Result)" }
  $request.requestId = '14141414-1414-4414-8414-141414141414'
  $request.operation = 'distribution.name.set'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555'; displayName = 'QA Renamed' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Distribution rename timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or
    $result.data.displayName -ne 'QA Renamed') { throw "Distribution rename invalid: $($read.Result)" }
  $request.requestId = '15151515-1515-4515-8515-151515151515'
  $request.parameters.groupId = '99999999-9999-4999-8999-999999999999'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Wrong-kind rename timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok) { throw 'Unified group reached distribution rename.' }
  $request.requestId = '16161616-1616-4616-8616-161616161616'
  $request.operation = 'group.primary.set'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555'; address = 'taken@example.test' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Collision check timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok -or $result.code -ne 'provider_rejected') { throw 'Assigned address reached the write.' }
  $request.requestId = '19191919-1919-4919-8919-191919191919'
  $request.parameters = @{ groupId = 'abababab-abab-4bab-8bab-abababababab'; address = 'policy-new@example.test' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Policy guard timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok -or $result.code -ne 'provider_rejected') { throw 'Policy-managed address reached the write.' }
  $request.requestId = '17171717-1717-4717-8717-171717171717'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555'; address = 'qa-new@example.test' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Group address change timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or
    $result.data.primarySmtpAddress -ne 'qa-new@example.test') { throw "Group address change invalid: $($read.Result)" }
  $request.requestId = '18181818-1818-4818-8818-181818181818'
  $request.parameters = @{ groupId = '99999999-9999-4999-8999-999999999999'; address = 'unified-new@example.test' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Unified address change timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or
    $result.data.primarySmtpAddress -ne 'unified-new@example.test') { throw "Unified address change invalid: $($read.Result)" }
  $request.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  $request.operation = 'distribution.member.set'
  $request.parameters = @{ groupId = '55555555-5555-4555-8555-555555555555'; memberId = '88888888-8888-4888-8888-888888888888'; enabled = $false }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Membership removal timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or $result.data.enabled -or -not $result.data.changed -or -not $result.data.verified) {
    throw "Membership removal invalid: $($read.Result)" }
  $request.requestId = '66666666-6666-4666-8666-666666666666'
  $request.operation = 'shared.create'
  $request.parameters = @{ name = 'QA Shared'; primarySmtpAddress = 'shared@example.test' }
  $request.parameters.command = 'Remove-DistributionGroup'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Injected request timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok) { throw 'Injected request was accepted.' }
  $request.requestId = '77777777-7777-4777-8777-777777777777'
  $request.parameters.Remove('command')
  $request.parameters.primarySmtpAddress = 'qa@foreign.test'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Foreign-domain request timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok -or $result.code -ne 'provider_rejected') { throw 'Foreign-domain request reached the write.' }
  $request.requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  $request.operation = 'mailbox.preservation.get'
  $request.parameters = @{ mailboxId = '88888888-8888-4888-8888-888888888888' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Preservation inspection timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.licenseRemovalEligible -or $result.data.mailboxBytes -ne 123 -or
    $result.data.inPlaceHolds.Count -ne 0) { throw "Preservation inspection invalid: $($read.Result)" }
  $request.requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  $request.operation = 'mailbox.convert.shared'
  $request.parameters = @{ mailboxId = '77777777-7777-4777-8777-777777777777'; command = 'Remove-Mailbox' }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Injected conversion request timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok) { throw 'Injected conversion request was accepted.' }
  $request.parameters.Remove('command')
  $request.requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Mailbox conversion timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or -not $result.data.changed -or
    $result.data.recipientType -ne 'SharedMailbox' -or $result.data.primarySmtpAddress -ne 'convert@example.test') {
    throw "Mailbox conversion invalid: $($read.Result)" }
  $request.requestId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Mailbox conversion retry timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or -not $result.data.verified -or $result.data.changed) { throw "Mailbox conversion retry invalid: $($read.Result)" }
  $request.requestId = '13131313-1313-4313-8313-131313131313'
  $request.parameters.mailboxId = '12121212-1212-4212-8212-121212121212'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Synced mailbox preflight timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if ($result.ok -or $result.code -ne 'provider_rejected') { throw 'Synced mailbox was not refused before write.' }
  $request.requestId = '14141414-1414-4414-8414-141414141414'
  $request.operation = 'mailbox.preservation.get'
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $read = $process.StandardOutput.ReadLineAsync()
  if (-not $read.Wait([TimeSpan]::FromSeconds(20))) { throw 'Synced mailbox inspection timed out.' }
  $result = $read.Result | ConvertFrom-Json
  if (-not $result.ok -or $result.data.directorySynced -ne $true -or $result.data.licenseRemovalEligible) {
    throw "Synced mailbox eligibility invalid: $($read.Result)" }
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Exchange process did not exit cleanly.' }
  Write-Output 'Exchange creation, distribution membership, preservation inspection, and conversion passed.'
} finally {
  if ($process) { if (-not $process.HasExited) { $process.Kill() }; $process.Dispose() }
  Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
}
