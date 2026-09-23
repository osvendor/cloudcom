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
function Send-Forwarding([string]$RequestId, $Data) {
  @{ requestId = $RequestId; ok = $true; data = $Data } | ConvertTo-Json -Depth 5 -Compress
  [Console]::Out.Flush()
}
function Trace-Date($Value) {
  if (-not $Value) { return $null }
  return ([DateTimeOffset]::Parse([string]$Value)).ToUniversalTime().ToString('o')
}
function Get-BoundMailbox([string]$MailboxId) {
  $candidate = Get-EXOMailbox -ExternalDirectoryObjectId $MailboxId -Properties ExternalDirectoryObjectId,PrimarySmtpAddress,RecipientTypeDetails -ErrorAction Stop
  if (-not $candidate -or [string]$candidate.ExternalDirectoryObjectId -ine $MailboxId -or [string]$candidate.RecipientTypeDetails -notin @('UserMailbox','SharedMailbox')) { throw 'mailbox identity mismatch' }
  $mailbox = Get-Mailbox -Identity ([string]$candidate.PrimarySmtpAddress) -ErrorAction Stop
  if (-not $mailbox -or [string]$mailbox.ExternalDirectoryObjectId -ine $MailboxId) { throw 'mailbox identity mismatch' }
  return $mailbox
}
function Forwarding-State([string]$MailboxId, $Mailbox) {
  $smtp = [string]$Mailbox.ForwardingSmtpAddress
  if ($smtp.StartsWith('smtp:', [StringComparison]::OrdinalIgnoreCase)) { $smtp = $smtp.Substring(5) }
  @{ mailboxId = $MailboxId; smtpAddress = $(if ($smtp) { $smtp } else { $null });
     keepCopy = [bool]$Mailbox.DeliverToMailboxAndForward;
     internalRecipient = $(if ($Mailbox.ForwardingAddress) { [string]$Mailbox.ForwardingAddress } else { $null }) }
}
function AutoReply-Date($Value) {
  if (-not $Value) { return $null }
  return ([DateTimeOffset]::Parse([string]$Value)).ToUniversalTime().ToString('o')
}
function AutoReply-State([string]$MailboxId, $Config) {
  @{ mailboxId = $MailboxId; state = [string]$Config.AutoReplyState;
     internalMessage = [string]$Config.InternalMessage; externalMessage = [string]$Config.ExternalMessage;
     externalAudience = [string]$Config.ExternalAudience;
     start = $(AutoReply-Date $Config.StartTime); end = $(AutoReply-Date $Config.EndTime) }
}
function Addresses-State([string]$MailboxId, $Mailbox) {
  $primary = [string]$Mailbox.PrimarySmtpAddress
  $aliases = [System.Collections.Generic.List[string]]::new()
  foreach ($proxy in $Mailbox.EmailAddresses) {
    $text = [string]$proxy
    if ($text -match '^smtp:(.+)$') {
      $address = [string]$Matches[1]
      if ($address -ine $primary -and -not $aliases.Contains($address)) { $aliases.Add($address) }
    }
  }
  @{ mailboxId = $MailboxId; primarySmtpAddress = $primary; aliases = @($aliases.ToArray());
     policyEnabled = [bool]$Mailbox.EmailAddressPolicyEnabled }
}
function Delegation-State([string]$MailboxId, [string]$DelegateId, $Mailbox, $Delegate) {
  $mailAddress = [string]$Mailbox.PrimarySmtpAddress
  $delegateAddress = [string]$Delegate.PrimarySmtpAddress
  $full = @(Get-MailboxPermission -Identity $mailAddress -User $delegateAddress -ErrorAction Stop |
    Where-Object { -not $_.Deny -and -not $_.IsInherited -and @($_.AccessRights) -contains 'FullAccess' }).Count -gt 0
  $sendAs = @(Get-RecipientPermission -Identity $mailAddress -Trustee $delegateAddress -AccessRights SendAs -ErrorAction Stop |
    Where-Object { -not $_.Deny -and @($_.AccessRights) -contains 'SendAs' }).Count -gt 0
  $recipient = Get-Recipient -Identity $delegateAddress -ErrorAction Stop
  if (-not $recipient -or [string]$recipient.ExternalDirectoryObjectId -ine $DelegateId -or -not $recipient.DistinguishedName) { throw 'delegate identity mismatch' }
  $delegateDn = [string]$recipient.DistinguishedName
  $behalf = $false
  foreach ($entry in @($Mailbox.GrantSendOnBehalfTo)) {
    if (-not $entry) { continue }
    if (-not $entry.DistinguishedName) { throw 'unresolved send-on-behalf entry' }
    if ([string]$entry.DistinguishedName -ieq $delegateDn) { $behalf = $true }
  }
  @{ mailboxId = $MailboxId; delegateId = $DelegateId; delegateAddress = $delegateAddress;
     fullAccess = [bool]$full; sendAs = [bool]$sendAs; sendOnBehalf = [bool]$behalf }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $requestId = '00000000-0000-4000-8000-000000000000'
  $writeDispatched = $false
  try {
    $request = $line | ConvertFrom-Json -AsHashtable
    $requestId = [string]$request.requestId
    if ($request.operation -notin @('mailbox.inventory','mailbox.forwarding.get','mailbox.forwarding.set','mailbox.autoreply.get','mailbox.autoreply.set',
      'mailbox.addresses.get','mailbox.primary.set','mailbox.alias.add','mailbox.alias.remove',
      'mailbox.delegation.get','mailbox.delegation.set','trace.search','trace.detail')) { throw 'invalid request' }
    if ($request.operation -eq 'mailbox.inventory') {
      if ($request.parameters.Keys.Count -ne 1 -or -not $request.parameters.ContainsKey('pageSize')) { throw 'invalid request' }
      $pageSize = [int]$request.parameters.pageSize
      if ($pageSize -lt 1 -or $pageSize -gt 200) { throw 'invalid request' }
    } elseif ($request.operation -notin @('trace.search','trace.detail')) {
      $mailboxId = [string]$request.parameters.mailboxId
      if ($mailboxId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'invalid request' }
      if ($request.operation -eq 'mailbox.forwarding.set' -and ($request.parameters.Keys.Count -ne 3 -or -not $request.parameters.ContainsKey('smtpAddress') -or -not $request.parameters.ContainsKey('keepCopy'))) { throw 'invalid request' }
      if ($request.operation -eq 'mailbox.autoreply.set' -and ($request.parameters.Keys.Count -ne 5 -or -not $request.parameters.ContainsKey('state') -or -not $request.parameters.ContainsKey('message') -or -not $request.parameters.ContainsKey('start') -or -not $request.parameters.ContainsKey('end'))) { throw 'invalid request' }
      if ($request.operation -in @('mailbox.primary.set','mailbox.alias.add','mailbox.alias.remove') -and ($request.parameters.Keys.Count -ne 2 -or -not $request.parameters.ContainsKey('address'))) { throw 'invalid request' }
      if ($request.operation -eq 'mailbox.delegation.get' -and ($request.parameters.Keys.Count -ne 2 -or -not $request.parameters.ContainsKey('delegateId'))) { throw 'invalid request' }
      if ($request.operation -eq 'mailbox.delegation.set' -and ($request.parameters.Keys.Count -ne 4 -or -not $request.parameters.ContainsKey('delegateId') -or -not $request.parameters.ContainsKey('right') -or -not $request.parameters.ContainsKey('enabled'))) { throw 'invalid request' }
    }
    if ($boundTenant -and $boundTenant -ne $request.tenantId) { Send-Failure $requestId 'connection_mismatch'; continue }
    if (-not $boundTenant) {
      Import-Module ExchangeOnlineManagement
      $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certificatePath, $config.privateKeyPath)
      Connect-ExchangeOnline -AppId $config.clientId -Certificate $certificate -Organization $config.exchangeOrganization -ShowBanner:$false
      $boundTenant = [string]$request.tenantId
    }
    if ($request.operation -eq 'trace.search') {
      $p = $request.parameters
      if ($p.Keys.Count -ne 6) { throw 'invalid trace request' }
      foreach ($key in @('start','end','sender','recipient','status','cursor')) { if (-not $p.ContainsKey($key)) { throw 'invalid trace request' } }
      $start = [DateTimeOffset]::Parse([string]$p.start).ToUniversalTime()
      $end = [DateTimeOffset]::Parse([string]$p.end).ToUniversalTime()
      $now = [DateTimeOffset]::UtcNow
      if ($start -lt $now.AddDays(-90) -or $end -gt $now.AddMinutes(5) -or $start -ge $end -or ($end - $start).TotalDays -gt 10) { throw 'invalid trace dates' }
      $options = @{ StartDate = $start.UtcDateTime; EndDate = $end.UtcDateTime; ResultSize = 1000; ErrorAction = 'Stop' }
      foreach ($field in @('sender','recipient')) {
        if ($p[$field]) {
          if ([string]$p[$field] -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$' -or ([string]$p[$field]).Length -gt 320) { throw 'invalid trace address' }
          $key = $(if ($field -eq 'sender') { 'SenderAddress' } else { 'RecipientAddress' })
          $options[$key] = [string]$p[$field]
        }
      }
      if ($p.status) {
        if ([string]$p.status -notin @('Delivered','Expanded','Failed','FilteredAsSpam','GettingStatus','Pending','Quarantined')) { throw 'invalid trace status' }
        $options.Status = [string]$p.status
      }
      if ($p.cursor) {
        if ($p.cursor.Keys.Count -ne 2 -or -not $p.cursor.ContainsKey('received') -or -not $p.cursor.ContainsKey('recipient')) { throw 'invalid trace cursor' }
        $cursorAt = [DateTimeOffset]::Parse([string]$p.cursor.received).ToUniversalTime()
        if ($cursorAt -lt $start -or $cursorAt -gt $end -or [string]$p.cursor.recipient -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'invalid trace cursor' }
        $options.EndDate = $cursorAt.UtcDateTime
        $options.StartingRecipientAddress = [string]$p.cursor.recipient
      }
      $raw = @(Get-MessageTraceV2 @options)
      $rows = @($raw | ForEach-Object {
        @{ messageTraceId = [string]$_.MessageTraceId; received = (Trace-Date $_.Received);
           sender = [string]$_.SenderAddress; recipient = [string]$_.RecipientAddress;
           subject = ([string]$_.Subject).Substring(0, [Math]::Min(([string]$_.Subject).Length, 1000)); status = [string]$_.Status }
      })
      $next = $null
      if ($raw.Count -ge 1000 -and $rows.Count -gt 0) {
        $last = $rows[-1]
        $next = @{ received = $last.received; recipient = $last.recipient }
      }
      Send-Forwarding $requestId @{ rows = $rows; next = $next; partial = [bool]($null -ne $next); checkedAt = [DateTimeOffset]::UtcNow.ToString('o') }
      continue
    }
    if ($request.operation -eq 'trace.detail') {
      $p = $request.parameters
      if ($p.Keys.Count -ne 2 -or -not $p.ContainsKey('messageTraceId') -or -not $p.ContainsKey('recipient') -or
        [string]$p.messageTraceId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or
        [string]$p.recipient -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'invalid detail request' }
      $raw = @(Get-MessageTraceDetailV2 -MessageTraceId ([guid]$p.messageTraceId) -RecipientAddress ([string]$p.recipient) -ErrorAction Stop)
      $events = @($raw | Select-Object -First 1000 | ForEach-Object {
        $description = $(if ($_.Detail) { [string]$_.Detail } else { [string]$_.Data })
        @{ date = (Trace-Date $_.Date); event = ([string]$_.Event).Substring(0, [Math]::Min(([string]$_.Event).Length, 120));
           detail = $description.Substring(0, [Math]::Min($description.Length, 4000)) }
      })
      Send-Forwarding $requestId @{ messageTraceId = ([string]([guid]$p.messageTraceId)).ToLowerInvariant(); recipient = [string]$p.recipient;
        events = $events; partial = [bool]($raw.Count -gt 1000) }
      continue
    }
    if ($request.operation -ne 'mailbox.inventory') {
      $mailbox = Get-BoundMailbox $mailboxId
      if ($request.operation -in @('mailbox.delegation.get','mailbox.delegation.set')) {
        $delegateId = [string]$request.parameters.delegateId
        if ($delegateId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or $delegateId -ieq $mailboxId) { throw 'invalid delegate' }
        $delegate = Get-BoundMailbox $delegateId
        $before = Delegation-State $mailboxId $delegateId $mailbox $delegate
        if ($request.operation -eq 'mailbox.delegation.get') { Send-Forwarding $requestId $before; continue }
        $right = [string]$request.parameters.right
        if ($right -notin @('FullAccess','SendAs','SendOnBehalf') -or $request.parameters.enabled -isnot [bool]) { throw 'invalid delegation' }
        $field = $(if ($right -eq 'FullAccess') { 'fullAccess' } elseif ($right -eq 'SendAs') { 'sendAs' } else { 'sendOnBehalf' })
        $enabled = [bool]$request.parameters.enabled
        if ($before[$field] -eq $enabled) { $before.accepted = $true; $before.verified = $true; Send-Forwarding $requestId $before; continue }
        $targetAddress = [string]$mailbox.PrimarySmtpAddress
        $delegateAddress = [string]$delegate.PrimarySmtpAddress
        $writeDispatched = $true
        if ($right -eq 'FullAccess') {
          if ($enabled) { Add-MailboxPermission -Identity $targetAddress -User $delegateAddress -AccessRights FullAccess -InheritanceType All -ErrorAction Stop | Out-Null }
          else { Remove-MailboxPermission -Identity $targetAddress -User $delegateAddress -AccessRights FullAccess -InheritanceType All -Confirm:$false -ErrorAction Stop | Out-Null }
        } elseif ($right -eq 'SendAs') {
          if ($enabled) { Add-RecipientPermission -Identity $targetAddress -Trustee $delegateAddress -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null }
          else { Remove-RecipientPermission -Identity $targetAddress -Trustee $delegateAddress -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null }
        } else {
          if ($enabled) { Set-Mailbox -Identity $targetAddress -GrantSendOnBehalfTo @{ Add = $delegateAddress } -ErrorAction Stop }
          else { Set-Mailbox -Identity $targetAddress -GrantSendOnBehalfTo @{ Remove = $delegateAddress } -ErrorAction Stop }
        }
        $after = Delegation-State $mailboxId $delegateId (Get-BoundMailbox $mailboxId) (Get-BoundMailbox $delegateId)
        $after.accepted = $true; $after.verified = ($after[$field] -eq $enabled)
        Send-Forwarding $requestId $after
        continue
      }
      if ($request.operation -in @('mailbox.addresses.get','mailbox.primary.set','mailbox.alias.add','mailbox.alias.remove')) {
        $before = Addresses-State $mailboxId $mailbox
        if ($request.operation -eq 'mailbox.addresses.get') { Send-Forwarding $requestId $before; continue }
        $address = [string]$request.parameters.address
        if ($address.Length -gt 320 -or $address -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'invalid address' }
        if ($request.operation -eq 'mailbox.primary.set' -and $before.policyEnabled) { throw 'primary address is controlled by policy' }
        if ($request.operation -eq 'mailbox.alias.remove' -and $address -ieq $before.primarySmtpAddress) { throw 'cannot remove primary address' }
        $present = @($before.aliases | Where-Object { $_ -ieq $address }).Count -gt 0
        $noChange = ($request.operation -eq 'mailbox.primary.set' -and $address -ieq $before.primarySmtpAddress) -or
          ($request.operation -eq 'mailbox.alias.add' -and ($present -or $address -ieq $before.primarySmtpAddress)) -or
          ($request.operation -eq 'mailbox.alias.remove' -and -not $present)
        if ($noChange) { $before.accepted = $true; $before.verified = $true; Send-Forwarding $requestId $before; continue }
        $writeDispatched = $true
        if ($request.operation -eq 'mailbox.primary.set') {
          Set-Mailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -WindowsEmailAddress $address -ErrorAction Stop
        } elseif ($request.operation -eq 'mailbox.alias.add') {
          Set-Mailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -EmailAddresses @{ Add = "smtp:$address" } -ErrorAction Stop
        } else {
          Set-Mailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -EmailAddresses @{ Remove = "smtp:$address" } -ErrorAction Stop
        }
        $after = Addresses-State $mailboxId (Get-BoundMailbox $mailboxId)
        $stillPresent = @($after.aliases | Where-Object { $_ -ieq $address }).Count -gt 0
        $after.accepted = $true
        $after.verified = $(if ($request.operation -eq 'mailbox.primary.set') { $after.primarySmtpAddress -ieq $address }
          elseif ($request.operation -eq 'mailbox.alias.add') { $stillPresent -and $after.primarySmtpAddress -ieq $before.primarySmtpAddress }
          else { -not $stillPresent -and $after.primarySmtpAddress -ieq $before.primarySmtpAddress })
        Send-Forwarding $requestId $after
        continue
      }
      if ($request.operation -in @('mailbox.autoreply.get','mailbox.autoreply.set')) {
        $before = AutoReply-State $mailboxId (Get-MailboxAutoReplyConfiguration -Identity ([string]$mailbox.PrimarySmtpAddress) -ErrorAction Stop)
        if ($request.operation -eq 'mailbox.autoreply.get') { Send-Forwarding $requestId $before; continue }
        $state = [string]$request.parameters.state
        $message = [string]$request.parameters.message
        if ($state -notin @('Disabled','Enabled','Scheduled') -or $message.Length -gt 8192) { throw 'invalid reply' }
        $start = $null; $end = $null
        if ($state -eq 'Scheduled') {
          $start = [DateTimeOffset]::Parse([string]$request.parameters.start).ToUniversalTime()
          $end = [DateTimeOffset]::Parse([string]$request.parameters.end).ToUniversalTime()
          if ($end -le $start) { throw 'invalid schedule' }
        } elseif ($null -ne $request.parameters.start -or $null -ne $request.parameters.end) { throw 'invalid schedule' }
        $sameSchedule = $state -ne 'Scheduled' -or ($before.start -eq $start.ToString('o') -and $before.end -eq $end.ToString('o'))
        if ($before.state -eq $state -and $before.internalMessage -ceq $message -and $before.externalMessage -ceq $message -and $before.externalAudience -eq 'All' -and $sameSchedule) {
          $before.accepted = $true; $before.verified = $true; Send-Forwarding $requestId $before; continue
        }
        $options = @{ Identity = [string]$mailbox.PrimarySmtpAddress; AutoReplyState = $state;
          InternalMessage = $message; ExternalMessage = $message; ExternalAudience = 'All'; ErrorAction = 'Stop' }
        if ($state -eq 'Scheduled') { $options.StartTime = $start.UtcDateTime; $options.EndTime = $end.UtcDateTime }
        $writeDispatched = $true
        Set-MailboxAutoReplyConfiguration @options
        $after = AutoReply-State $mailboxId (Get-MailboxAutoReplyConfiguration -Identity ([string]$mailbox.PrimarySmtpAddress) -ErrorAction Stop)
        $after.accepted = $true
        $after.verified = ($after.state -eq $state -and $after.internalMessage -ceq $message -and $after.externalMessage -ceq $message -and $after.externalAudience -eq 'All' -and
          ($state -ne 'Scheduled' -or ($after.start -eq $start.ToString('o') -and $after.end -eq $end.ToString('o'))))
        Send-Forwarding $requestId $after
        continue
      }
      $before = Forwarding-State $mailboxId $mailbox
      if ($request.operation -eq 'mailbox.forwarding.get') { Send-Forwarding $requestId $before; continue }
      if ($before.internalRecipient) { throw 'internal forwarding is managed separately' }
      $address = $request.parameters.smtpAddress
      if ($null -ne $address -and ([string]$address -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$' -or ([string]$address).Length -gt 320)) { throw 'invalid forwarding address' }
      if ($request.parameters.keepCopy -isnot [bool]) { throw 'invalid keepCopy' }
      $expected = $(if ($address) { ([string]$address).ToLowerInvariant() } else { $null })
      if ($before.smtpAddress -ieq $expected -and $before.keepCopy -eq [bool]$request.parameters.keepCopy) {
        $before.accepted = $true; $before.verified = $true; Send-Forwarding $requestId $before; continue
      }
      $writeDispatched = $true
      Set-Mailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -ForwardingSmtpAddress $address -DeliverToMailboxAndForward ([bool]$request.parameters.keepCopy) -ErrorAction Stop
      $after = Forwarding-State $mailboxId (Get-BoundMailbox $mailboxId)
      $after.accepted = $true
      $after.verified = ($after.smtpAddress -ieq $expected -and $after.keepCopy -eq [bool]$request.parameters.keepCopy -and -not $after.internalRecipient)
      Send-Forwarding $requestId $after
      continue
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
    Send-Failure $requestId $(if ($writeDispatched) { 'unknown_write_outcome' } else { 'provider_rejected' })
  }
}
