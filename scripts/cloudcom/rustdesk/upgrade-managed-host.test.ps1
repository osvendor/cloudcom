# OS-TEST only. Extract guard functions, never execute the installer script body.
$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upgrade-managed-host.ps1') -Raw
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Assert-UpgradeOrganization','Assert-UpgradePayload','Assert-UpgradeMsiMetadata','Assert-UpgradeIdentity','Get-UpgradePrivateRoutingFingerprint','Wait-UpgradeServiceState','Invoke-UpgradeMsi')) {
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if (!$function) { throw "Missing guard $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$script:checks=0
function Assert-Check([bool]$Value,[string]$Message) { if (!$Value) { throw $Message }; $script:checks++ }
function Assert-Throws([scriptblock]$Operation,[string]$Message) {
    $threw=$false; try { & $Operation } catch { $threw=$true }
    Assert-Check $threw $Message
}
$org=[guid]'11111111-1111-4111-8111-111111111111'
Assert-UpgradeOrganization "org_id: $org`nsite_id: ignored" $org; $script:checks++
Assert-Throws { Assert-UpgradeOrganization 'org_id: 22222222-2222-4222-8222-222222222222' $org } 'Cross-organization execution accepted.'
Assert-Throws { Assert-UpgradeOrganization "other_org_id: $org" $org } 'Noncanonical organization key accepted.'
Assert-UpgradePayload 'known-exe' 'known-dll' 'known-exe' 'known-dll'; $script:checks++
Assert-Throws { Assert-UpgradePayload 'known-exe' 'unknown-dll' 'known-exe' 'known-dll' } 'Mixed payload accepted.'
Assert-Throws { Assert-UpgradePayload 'stock-exe' 'known-dll' 'known-exe' 'known-dll' } 'Unknown executable accepted.'
$metadata=@{ProductName='OS Consultants - Remote Access Agent';Manufacturer='OS Consultants';ProductVersion='1.5.0.69';UpgradeCode='{d3dc41e3-3c37-5d52-bb47-f6673705c01b}';ProductCode='{22222222-2222-4222-8222-222222222222}'}
Assert-UpgradeMsiMetadata ([pscustomobject]$metadata) '1.5.0.69'; $script:checks++
foreach ($bad in @(@{ProductName='RustDesk'},@{Manufacturer='Unknown'},@{ProductVersion='1.5.0.68'},@{UpgradeCode='{33333333-3333-4333-8333-333333333333}'},@{ProductCode='not-an-msi-product'})) {
    $changed=$metadata.Clone(); foreach ($key in $bad.Keys) { $changed[$key]=$bad[$key] }
    Assert-Throws { Assert-UpgradeMsiMetadata ([pscustomobject]$changed) '1.5.0.69' } 'Wrong MSI identity accepted.'
}
$identity=@{Protocol='2';Peer='123456789';Key='synthetic-public-key'}
Assert-UpgradeIdentity $identity $identity; $script:checks++
foreach ($bad in @(@{Protocol='1';Peer='123456789';Key='synthetic-public-key'},@{Protocol='2';Peer='987654321';Key='synthetic-public-key'},@{Protocol='2';Peer='123456789';Key='different-key'})) {
    Assert-Throws { Assert-UpgradeIdentity $identity $bad } 'Identity rotation accepted.'
}
$routing="custom-rendezvous-server = 'rd.example'`nrelay-server = 'relay.example'`nkey = 'synthetic-key'`n"
$fingerprint=Get-UpgradePrivateRoutingFingerprint $routing
Assert-Check ($fingerprint -eq (Get-UpgradePrivateRoutingFingerprint ($routing+"nat_type = 1`nserial = 2`n"))) 'Unrelated native NAT changes altered routing fingerprint.'
Assert-Check ($fingerprint -eq (Get-UpgradePrivateRoutingFingerprint "key = 'synthetic-key'`nrelay-server = 'relay.example'`ncustom-rendezvous-server = 'rd.example'`n")) 'Managed routing order affected fingerprint.'
Assert-Check ($fingerprint -ne (Get-UpgradePrivateRoutingFingerprint ($routing.Replace('rd.example','different.example')))) 'Changed private server escaped detection.'
Assert-Throws { Get-UpgradePrivateRoutingFingerprint ($routing+"key = 'duplicate-key'`n") } 'Duplicate private routing accepted.'
Assert-Throws { Get-UpgradePrivateRoutingFingerprint ($routing.Replace("key = 'synthetic-key'",'')) } 'Missing private routing key accepted.'
Assert-Throws { Get-UpgradePrivateRoutingFingerprint ($routing.Replace("key = 'synthetic-key'","key = ''")) } 'Empty private routing value accepted.'
$script:serviceCalls=New-Object 'Collections.Generic.List[string]'
function Get-Service {
    param($Name,$ErrorAction)
    if ($Name -ne 'RustDesk') {throw 'Wrong service target'}
    $controller=[pscustomobject]@{Status=[ServiceProcess.ServiceControllerStatus]::Running}
    $controller | Add-Member ScriptMethod Stop {$script:serviceCalls.Add('stop')}
    $controller | Add-Member ScriptMethod Start {$script:serviceCalls.Add('start')}
    $controller | Add-Member ScriptMethod WaitForStatus {param($Status,$Timeout) if($Timeout.TotalSeconds -ne 30){throw 'Unbounded service wait'}; $script:serviceCalls.Add('wait-'+$Status)}
    $controller | Add-Member ScriptMethod Dispose {$script:serviceCalls.Add('dispose')}
    return $controller
}
Wait-UpgradeServiceState -State Stopped -RequestChange
Assert-Check (($script:serviceCalls -join ',') -eq 'stop,wait-Stopped,dispose') 'Configuration could restore before bounded stop completion.'
$script:serviceCalls.Clear(); Wait-UpgradeServiceState -State Running
Assert-Check (($script:serviceCalls -join ',') -eq 'wait-Running,dispose') 'Postflight must wait for MSI service without starting a stopped service itself.'
$testRoot=Join-Path $env:TEMP ('CloudComUpgradeGuards-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:journal=Join-Path $testRoot 'journal.json'; $script:InstallerTimeoutSeconds=60
$script:starts=0; $script:waitOk=$true; $script:exitCode=0; $script:lastArguments=''
function Start-Process {
    param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
    if ($FilePath -ne 'msiexec.exe' -or $WindowStyle -ne 'Hidden') { throw 'Unexpected native test dispatch.' }
    $script:starts++; $script:lastArguments=$ArgumentList
    $fake=[pscustomobject]@{ExitCode=$script:exitCode;Id=12345}
    $fake | Add-Member ScriptMethod WaitForExit {param($Milliseconds) if ($Milliseconds -ne 60000) {throw 'Unbounded timeout'}; return $script:waitOk}
    $fake | Add-Member ScriptMethod Refresh {}
    $fake | Add-Member ScriptMethod Dispose {}
    # Deliberately no Kill(): timed-out Windows Installer must remain untouched.
    return $fake
}
Assert-Check ((Invoke-UpgradeMsi 'C:\QA\69.msi' 'C:\QA\69.log') -eq 0) 'Successful MSI rejected.'
Assert-Check ($script:lastArguments -notmatch 'CLOUDCOM_ADOPT_EXISTING') 'MSI adoption override enabled.'
$script:exitCode=3010
Assert-Check ((Invoke-UpgradeMsi 'C:\QA\69.msi' 'C:\QA\69.log') -eq 3010) 'Reboot-required success rejected.'
$script:waitOk=$false; $script:installerUnsettled=$false; $before=$script:starts
Assert-Throws { Invoke-UpgradeMsi 'C:\QA\69.msi' 'C:\QA\69.log' } 'MSI timeout accepted.'
Assert-Check ($script:installerUnsettled -and $script:starts -eq $before+1 -and (Test-Path -LiteralPath $script:journal)) 'Timeout did not hold further installer work.'
$script:waitOk=$true; $script:exitCode=1618; $script:installerUnsettled=$false
Assert-Throws { Invoke-UpgradeMsi 'C:\QA\69.msi' 'C:\QA\69.log' } 'Concurrent Windows Installer accepted.'
Assert-Check $script:installerUnsettled 'Busy Windows Installer did not block rollback.'
$script:exitCode=1603; $script:installerUnsettled=$false
Assert-Throws { Invoke-UpgradeMsi 'C:\QA\69.msi' 'C:\QA\69.log' } 'Installer error accepted.'
Assert-Check (!$script:installerUnsettled) 'Exited installer incorrectly marked unsettled.'
Assert-Check ($source.Contains('!$script:installerUnsettled') -and $source.Contains('Assert-UpgradeMsiOwned $oldMetadata.ProductCode')) 'Main-path rollback fence or MSI ownership gate missing.'
"PASS: $script:checks managed-host upgrade guard checks; no real installer, service, identity or configuration was mutated. Evidence: $testRoot"
