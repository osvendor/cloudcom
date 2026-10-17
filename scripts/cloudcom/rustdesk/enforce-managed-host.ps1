param(
    [ValidateSet('Probe','Repair')][string]$Mode='Probe',
    [Parameter(Mandatory)][guid]$ExpectedOrganizationId,
    [Parameter(Mandatory)][uri]$InstallerUrl,
    [Parameter(Mandatory)][string]$RendezvousServer,
    [Parameter(Mandatory)][string]$RelayServer,
    [Parameter(Mandatory)][string]$ServerPublicKey
)
# Bundle common.ps1 immediately after this parameter block for a saved Breeze script.
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $env:COMPUTERNAME
if (![Environment]::Is64BitProcess) { throw 'The managed host requires 64-bit PowerShell.' }
if ($InstallerUrl.Scheme -ne 'https' -or $InstallerUrl.UserInfo -or $InstallerUrl.Query) { throw 'A canonical HTTPS installer URL is required.' }
$yaml=Get-Content -LiteralPath (Join-Path $env:ProgramData 'Breeze\agent.yaml') -Raw
if ($yaml -notmatch ('(?m)^org_id:\s*'+[regex]::Escape($ExpectedOrganizationId.ToString())+'\s*$')) { throw 'Breeze organization guard refused execution.' }
$exe=Join-Path $env:ProgramFiles 'RustDesk\RustDesk.exe'
$dll=Join-Path (Split-Path $exe) 'librustdesk.dll'
$msiHash='727E175A37585CBB98232C188F46D221EAD9B0B05B69EFB6D2012969ECFB9E85'
$exeHash='ADF4C6313FB717FB62B6447A67CF5406207228945ABC2FB799E04E89210975BE'
$dllHash='B5E885348145403A7A5C10D130DCD45916129D7D9037DE1FDFAF5F831E81B6E7'
$enrollment=Join-Path $env:ProgramData 'Breeze\data\rustdesk\native-admission.dpapi'
$configPath=Join-Path $env:WINDIR 'ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml'
function Test-ApprovedPayload {
    foreach ($entry in @(@{Path=$exe;Hash=$exeHash},@{Path=$dll;Hash=$dllHash})) {
        if (!(Test-Path -LiteralPath $entry.Path -PathType Leaf) -or !(Test-CloudComNoReparsePath $entry.Path)) { return $false }
        if ((Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash -ne $entry.Hash) { return $false }
    }
    return $true
}
function Test-PrivateRouting {
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { return $false }
    $text=Get-Content -LiteralPath $configPath -Raw
    foreach ($pair in @(@('custom-rendezvous-server',$RendezvousServer),@('relay-server',$RelayServer),@('key',$ServerPublicKey))) {
        $pattern='(?m)^\s*'+[regex]::Escape($pair[0])+'\s*=\s*[''\"]'+[regex]::Escape($pair[1])+'[''\"]\s*$'
        if ($text -notmatch $pattern) { return $false }
    }
    return $true
}
function Get-ManagedIssues {
    $issues=New-Object 'Collections.Generic.List[string]'
    $svc=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if (!$svc) { $issues.Add('host_missing') }
    elseif (!(Test-CloudComRustDeskServicePath $svc.PathName $exe)) { $issues.Add('existing_host_requires_review') }
    else {
        if ($svc.State -ne 'Running') { $issues.Add('service_stopped') }
        if ($svc.StartMode -ne 'Auto') { $issues.Add('service_not_automatic') }
    }
    if (!(Test-ApprovedPayload)) { $issues.Add('approved_payload_missing_or_changed') }
    if (!(Test-PrivateRouting)) { $issues.Add('private_routing_missing_or_changed') }
    if (!(Test-Path -LiteralPath $enrollment -PathType Leaf) -or !(Test-CloudComNoReparsePath $enrollment)) { $issues.Add('native_enrollment_pending') }
    if (!(Test-CloudComRustDeskFirewall $exe)) { $issues.Add('direct_firewall_missing') }
    return $issues.ToArray()
}
if ($Mode -eq 'Probe') {
    $issues=@(Get-ManagedIssues)
    $state=if ($issues.Count) {'breach'} else {'ok'}
    $detail=if ($issues.Count) {$issues -join ', '} else {'Breeze-only managed host installed, enrolled and running.'}
    Write-Output ('::breeze:monitor:: '+(@{state=$state;detail=$detail}|ConvertTo-Json -Compress))
    exit 0
}
$mutex=New-Object Threading.Mutex($false,'Global\CloudComRustDeskDesiredState')
$locked=$false
try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (!$locked) { throw 'Another managed-host repair is in progress.' }
    $issues=@(Get-ManagedIssues)
    if (!$issues.Count) { Write-Output 'Managed host already healthy; no changes.'; exit 0 }
    $svc=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    # Never replace stock, unknown, damaged, or newer managed installations automatically.
    if ($svc -and (!(Test-CloudComRustDeskServicePath $svc.PathName $exe) -or !(Test-ApprovedPayload))) { throw 'Existing RustDesk requires reviewed adoption; no changes made.' }
    if (!$svc -and (Test-Path -LiteralPath (Split-Path $exe))) { throw 'Existing RustDesk files require review; no changes made.' }
    $stage=Join-Path $env:ProgramData 'CloudCom\ManagedHostEnforcement'
    Set-CloudComPrivateDirectory $stage
    $statePath=Join-Path $stage 'attempts.json'
    $attempt=@{count=0;lastUtc='2000-01-01T00:00:00Z'}
    if (Test-Path -LiteralPath $statePath) {
        if (!(Test-CloudComPrivatePath $statePath)) { throw 'Repair state is not protected.' }
        $saved=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $attempt=@{count=[int]$saved.count;lastUtc=[string]$saved.lastUtc}
    }
    if ($attempt.count -ge 3) { throw 'Three repair attempts exhausted; review is required.' }
    if (([datetime]::UtcNow-[datetime]::Parse($attempt.lastUtc).ToUniversalTime()).TotalMinutes -lt 15) { throw 'Repair cooldown active; retry after 15 minutes.' }
    $attempt.count++; $attempt.lastUtc=[datetime]::UtcNow.ToString('o')
    $attempt | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding UTF8
    if (!$svc) {
        Start-Sleep -Seconds (Get-Random -Minimum 1 -Maximum 31)
        $msi=Join-Path $stage 'managed-host.msi'
        [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $InstallerUrl.AbsoluteUri -OutFile $msi -TimeoutSec 180
        if (!(Test-CloudComNoReparsePath $msi) -or (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne $msiHash) { throw 'Managed host MSI checksum mismatch; installation refused.' }
        $arguments='/i "'+$msi+'" /qn /norestart INSTALLPRINTER=N CREATEDESKTOPSHORTCUTS=N CREATESTARTMENUSHORTCUTS=N CREATESTARTUPSHORTCUTS=N LAUNCH_TRAY_APP=N /L*v "'+(Join-Path $stage 'install.log')+'"'
        $p=Start-Process msiexec.exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        if ($p.ExitCode -notin @(0,3010)) { throw "MSI failed with exit $($p.ExitCode); inspect protected install.log." }
        if (!(Test-ApprovedPayload)) { throw 'Installed payload does not match the approved managed host.' }
        Write-Output "Managed host MSI installed (exit $($p.ExitCode)); no reboot requested."
    }
    if (!(Test-PrivateRouting)) {
        $json=@{host=$RendezvousServer;relay=$RelayServer;key=$ServerPublicKey;api=''}|ConvertTo-Json -Compress
        $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_').ToCharArray()
        [array]::Reverse($encoded)
        $p=Start-Process $exe -ArgumentList @('--config',(-join $encoded)) -WindowStyle Hidden -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw 'Private routing configuration failed.' }
        Restart-Service RustDesk
    }
    Set-Service RustDesk -StartupType Automatic
    Start-Service RustDesk
    if (!(Test-CloudComRustDeskFirewall $exe)) {
        # App-bound rules survive DHCP changes; native admission still gates every session.
        foreach ($protocol in @('TCP','UDP')) {
            $name='CloudCom Managed Host '+$protocol
            if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $name }
            New-NetFirewallRule -Name $name -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile Any -Program $exe -Protocol $protocol | Out-Null
        }
    }
    # Agent reconciliation runs every ten minutes. Do not restart Breeze or copy identities.
    $deadline=[datetime]::UtcNow.AddSeconds(660)
    do {
        $issues=@(Get-ManagedIssues)
        if (!$issues.Count) { break }
        if (@($issues | Where-Object {$_ -ne 'native_enrollment_pending'}).Count) { throw ('Managed host verification failed: '+($issues -join ', ')) }
        Start-Sleep -Seconds 15
    } while ([datetime]::UtcNow -lt $deadline)
    if ($issues.Count) { throw 'Host installed but Breeze enrollment is pending; inspect agent enrollment logs.' }
    @{count=0;lastUtc='2000-01-01T00:00:00Z'}|ConvertTo-Json -Compress|Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-Output 'SUCCESS: approved managed host running with private routing, native Breeze enrollment and direct-access firewall.'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
