$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$config = $env:CLOUDCOM_EXCHANGE_CONFIG | ConvertFrom-Json -AsHashtable
$boundTenant = $null

function Send-Failure([string]$RequestId, [string]$Code) {
  @{ requestId = $RequestId; ok = $false; code = $Code } | ConvertTo-Json -Compress
  [Console]::Out.Flush()
}
function Send-Result([string]$RequestId, $Records) {
  @{ requestId = $RequestId; ok = $true; data = @{ records = @($Records); partial = $true; collectedAt = [DateTime]::UtcNow.ToString('o') } } | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $requestId = '00000000-0000-4000-8000-000000000000'
  try {
    $request = $line | ConvertFrom-Json -AsHashtable
    $requestId = [string]$request.requestId
    if ($request.operation -ne 'mailbox.inventory' -or $request.parameters.Keys.Count -ne 1 -or -not $request.parameters.ContainsKey('pageSize')) { throw 'invalid request' }
    $pageSize = [int]$request.parameters.pageSize
    if ($pageSize -lt 1 -or $pageSize -gt 200) { throw 'invalid request' }
    if ($boundTenant -and $boundTenant -ne $request.tenantId) { Send-Failure $requestId 'connection_mismatch'; continue }
    if (-not $boundTenant) {
      Import-Module ExchangeOnlineManagement
      $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certificatePath, $config.privateKeyPath)
      Connect-ExchangeOnline -AppId $config.clientId -Certificate $certificate -Organization $config.exchangeOrganization -ShowBanner:$false
      $boundTenant = [string]$request.tenantId
    }
    $records = @(Get-EXOMailbox -ResultSize $pageSize -Properties ArchiveStatus,ExternalDirectoryObjectId,PrimarySmtpAddress,RecipientTypeDetails |
      Where-Object { $_.RecipientTypeDetails -in @('UserMailbox','SharedMailbox') } |
      ForEach-Object {
        $mailbox = $_; $size = $null; $archiveSize = $null; $statisticsUnavailable = $false
        try { $size = [int64](Get-EXOMailboxStatistics -Identity $mailbox.ExternalDirectoryObjectId -ErrorAction Stop).TotalItemSize.Value.ToBytes() } catch { $statisticsUnavailable = $true }
        if ([string]$mailbox.ArchiveStatus -eq 'Active') { try { $archiveSize = [int64](Get-EXOMailboxStatistics -Identity $mailbox.ExternalDirectoryObjectId -Archive -ErrorAction Stop).TotalItemSize.Value.ToBytes() } catch { $statisticsUnavailable = $true } }
        @{ id = [string]$mailbox.ExternalDirectoryObjectId; primarySmtpAddress = [string]$mailbox.PrimarySmtpAddress; recipientType = [string]$mailbox.RecipientTypeDetails; archiveEnabled = ([string]$mailbox.ArchiveStatus -eq 'Active'); mailboxBytes = $size; archiveBytes = $archiveSize; collectedAt = [DateTime]::UtcNow.ToString('o'); statisticsUnavailable = $statisticsUnavailable }
      })
    Send-Result $requestId $records
  } catch {
    # Do not return Exchange, filesystem, certificate, or PowerShell errors to an API caller.
    Send-Failure $requestId 'provider_rejected'
  }
}
