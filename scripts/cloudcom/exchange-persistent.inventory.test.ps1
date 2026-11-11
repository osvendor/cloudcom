$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'exchange-persistent.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$bootstrap = @'
      Import-Module ExchangeOnlineManagement
      $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certificatePath, $config.privateKeyPath)
      Connect-ExchangeOnline -AppId $config.clientId -Certificate $certificate -Organization $config.exchangeOrganization -ShowBanner:$false
      $boundTenant = [string]$request.tenantId
'@
if (-not $source.Contains($bootstrap)) { throw 'Exchange bootstrap changed; review the test harness.' }
$source = $source.Replace($bootstrap, '      $boundTenant = [string]$request.tenantId')
$fakeExchange = @'
$script:sampleRows = @(1..201 | ForEach-Object {
  $suffix = '{0:x12}' -f $_
  [pscustomobject]@{
    ExternalDirectoryObjectId = "00000000-0000-4000-8000-$suffix"
    PrimarySmtpAddress = "account$_@example.test"
    RecipientTypeDetails = $(if ($_ -eq 201) { 'SharedMailbox' } else { 'UserMailbox' })
    ArchiveStatus = 'None'
  }
})
function Get-EXOMailbox {
  param([int]$ResultSize, $Properties, $RecipientTypeDetails)
  if (@($RecipientTypeDetails) -join ',' -ne 'UserMailbox,SharedMailbox') { throw 'Unexpected mailbox type filter.' }
  return @($script:sampleRows | Select-Object -First $ResultSize)
}
'@
$tempScript = Join-Path ([IO.Path]::GetTempPath()) ("exchange-inventory-test-{0}.ps1" -f [guid]::NewGuid())
$process = $null
try {
  [IO.File]::WriteAllText($tempScript, "$fakeExchange`n$source")
  $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
  $start.ArgumentList.Add('-NoLogo')
  $start.ArgumentList.Add('-NoProfile')
  $start.ArgumentList.Add('-NonInteractive')
  $start.ArgumentList.Add('-File')
  $start.ArgumentList.Add($tempScript)
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['CLOUDCOM_EXCHANGE_CONFIG'] = '{}'
  $process = [Diagnostics.Process]::Start($start)
  $request = @{
    requestId = '11111111-1111-4111-8111-111111111111'
    organizationId = '22222222-2222-4222-8222-222222222222'
    tenantId = '33333333-3333-4333-8333-333333333333'
    clientId = '44444444-4444-4444-8444-444444444444'
    credentialVersion = 'test'
    connectionGeneration = 1
    operation = 'mailbox.inventory'
    parameters = @{ pageSize = 200 }
  }
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $firstRead = $process.StandardOutput.ReadLineAsync()
  if (-not $firstRead.Wait([TimeSpan]::FromSeconds(20))) { throw 'First inventory page timed out.' }
  $first = $firstRead.Result | ConvertFrom-Json
  if (-not $first.ok -or $first.data.records.Count -ne 200 -or -not $first.data.partial -or -not $first.data.next) { throw 'First inventory page was invalid.' }
  $request.requestId = '55555555-5555-4555-8555-555555555555'
  $request.parameters.cursor = [string]$first.data.next
  $request.connectionGeneration = 2
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $deniedRead = $process.StandardOutput.ReadLineAsync()
  if (-not $deniedRead.Wait([TimeSpan]::FromSeconds(20))) { throw 'Stale-generation rejection timed out.' }
  $denied = $deniedRead.Result | ConvertFrom-Json
  if ($denied.ok -or $denied.code -ne 'provider_rejected') { throw 'Snapshot crossed connection generations.' }
  $request.connectionGeneration = 1
  $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 5 -Compress))
  $secondRead = $process.StandardOutput.ReadLineAsync()
  if (-not $secondRead.Wait([TimeSpan]::FromSeconds(20))) { throw 'Second inventory page timed out.' }
  $second = $secondRead.Result | ConvertFrom-Json
  if (-not $second.ok -or $second.data.records.Count -ne 1 -or $second.data.records[0].recipientType -ne 'SharedMailbox' -or
    $second.data.partial -or $second.data.next -or $second.data.collectedAt -ne $first.data.collectedAt) { throw 'Continuation page was invalid.' }
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Exchange worker did not exit cleanly.' }
  Write-Output 'Exchange inventory continuation passed: 201 mailboxes, stable snapshot, shared mailbox on page two.'
} finally {
  if ($process) {
    if (-not $process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
  Remove-Item -LiteralPath $tempScript -ErrorAction SilentlyContinue
}
