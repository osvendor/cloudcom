$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'exchange-persistent.ps1'))
$start=$source.IndexOf("    if (`$request.operation -in @('quarantine.lookup','quarantine.release.set')) {")
$end=$source.IndexOf("    if (`$request.operation -eq 'trace.search') {",$start)
$handler=[scriptblock]::Create('foreach ($iteration in @(1)) {'+$source.Substring($start,$end-$start)+'}')
$traceId='55555555-5555-4555-8555-555555555555'
$identity='66666666-6666-4666-8666-666666666666\77777777-7777-4777-8777-777777777777'
$at=[DateTime]::UtcNow.AddMinutes(-20).ToString('o')
$recipient='qa@example.test'
function Get-MessageTraceV2 { param($MessageTraceId,$RecipientAddress,$StartDate,$EndDate,$ResultSize,$ErrorAction)
 [pscustomobject]@{MessageTraceId=$traceId;RecipientAddress=$recipient;Received=$at;MessageId='<test@example.test>'}
}
function Get-QuarantineMessage { param($MessageId,$RecipientAddress,$PageSize,$Identity,$ErrorAction)
 $row=[pscustomobject]@{Identity=$script:identity;MessageId='<test@example.test>';RecipientAddress=@($script:itemRecipient);ReleasedUser=$script:released;Subject='QA';SenderAddress='sender@example.test'}
 if ($script:duplicate -and -not $Identity) {return @($row,$row)}
 return $row
}
function Release-QuarantineMessage { param($Identity,$User,$Confirm,$ErrorAction)
 if ($User -ne $recipient -or $Identity -ne $script:identity) {throw 'wrong release recipient or identity'}
 $script:writes++;$script:released=@($User)
}
function Send-Forwarding {param($id,$data) $script:result=$data}
function Send-Failure {param($id,$code) $script:failure=$code}
$script:itemRecipient=$recipient;$script:released=@();$script:writes=0;$script:duplicate=$false
$request=@{operation='quarantine.lookup';parameters=@{messageTraceId=$traceId;recipient=$recipient;received=$at}}
$request = $request | ConvertTo-Json -Depth 5 | ConvertFrom-Json -AsHashtable
& $handler
if ($script:result.received -notmatch '^\d{4}-\d{2}-\d{2}T' -or [DateTimeOffset]::Parse($script:result.received) -ne [DateTimeOffset]::Parse($at)) { throw 'JSON timestamp failed ISO roundtrip' }
if (-not $script:result.match -or $script:result.match.released -or $script:writes) {throw 'lookup failed'}
$request.operation='quarantine.release.set';$request.parameters.identity=$identity
& $handler
if (-not $script:result.verified -or $script:writes -ne 1) {throw 'release/readback failed'}
& $handler
if ($script:writes -ne 1) {throw 'already released message replayed'}
$script:released=@();$script:duplicate=$true;$failed=$false
try { & $handler } catch {$failed=$true}
if (-not $failed -or $script:writes -ne 1) {throw 'ambiguous identity released'}
$script:duplicate=$false;$script:itemRecipient='other@example.test';$failed=$false
try { & $handler } catch {$failed=$true}
if (-not $failed -or $script:writes -ne 1) {throw 'foreign recipient released'}
$script:itemRecipient=$recipient;$request.parameters.identity=$traceId;$failed=$false
try { & $handler } catch {$failed=$true}
if (-not $failed -or $script:writes -ne 1) {throw 'trace GUID accepted as quarantine identity'}
Write-Output 'PASS: quarantine exact binding, specific-recipient release, readback, no replay, ambiguous/foreign identity guards.'
