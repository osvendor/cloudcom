param(
    [Parameter(Mandatory=$true)][string]$AllowedComputerName,
    [Parameter(Mandatory=$true)][string]$ConfigurationPath,
    [Parameter(Mandatory=$true)][string]$RendezvousServer,
    [Parameter(Mandatory=$true)][string]$RelayServer,
    [Parameter(Mandatory=$true)][string]$PublicKey,
    [Parameter(Mandatory=$true)][uri]$InstallerUrl,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallerSha256,
    [string]$PinnedVersion = '1.4.9',
    [string]$RecoveryPublicXml,
    [switch]$AdoptExistingInstallation,
    [ValidateRange(1,10)][int]$MaxAttempts = 3
)
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $AllowedComputerName
if ($InstallerUrl.Scheme -ne 'https' -or $InstallerUrl.UserInfo) { throw 'An approved HTTPS installer URL is required.' }
foreach ($value in @($RendezvousServer,$RelayServer,$PublicKey)) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n\x00]') { throw 'Invalid server configuration.' }
}
$mutex = New-Object Threading.Mutex($false, 'Global\CloudComRustDeskDesiredState')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another RustDesk repair is in progress.' }
    $state = Get-CloudComRustDeskState $ConfigurationPath $RendezvousServer $RelayServer $PublicKey $PinnedVersion
    if ($state.Healthy) { Write-CloudComRustDeskId $state.Exe; Write-Output 'RustDesk already compliant; no changes.'; return }
    $pinned = Get-CloudComVersion $PinnedVersion
    if ($state.Issues -contains 'provisioning_requires_review') { throw 'Previous provisioning was interrupted; manual credential recovery required.' }
    if ($state.Issues -contains 'version_unknown' -or ($state.Version -and $state.Version -ne $pinned)) { throw 'Existing version differs from approved version; manual review required.' }
    if ($state.Issues -contains 'service_path_unexpected') { throw 'Unexpected service binary; manual review required.' }
    $installed = Test-Path -LiteralPath $state.Exe
    if ($installed -and $state.Issues -contains 'service_missing') { throw 'Installed binary has no service; manual review required.' }
    $managed = Test-CloudComPrivatePath $state.Credential
    if ($installed -and !$managed -and !$AdoptExistingInstallation) { throw 'Unmanaged installation requires explicit adoption.' }
    # Existing credentials must never be silently replaced after loss of DPAPI access or unsafe ACLs.
    if ((Test-Path -LiteralPath $state.Credential) -and ($state.Issues -contains 'credential_unreadable' -or !$managed)) { throw 'Existing credential requires manual recovery.' }
    Set-CloudComPrivateDirectory $state.Directory
    $attemptFile = Join-Path $state.Directory 'repair-attempts.json'
    if (Test-Path -LiteralPath $attemptFile) {
        if (!(Test-CloudComPrivatePath $attemptFile)) { throw 'Unsafe repair journal.' }
        $journal = Get-Content -LiteralPath $attemptFile -Raw | ConvertFrom-Json
        if ([int]$journal.attempts -ge $MaxAttempts) { throw 'Repair attempt limit reached; review and reset journal manually.' }
        if ([datetime]::Parse($journal.lastAttempt).ToUniversalTime() -gt [datetime]::UtcNow.AddMinutes(-15)) { throw 'Repair cooldown active.' }
        $attempt = [int]$journal.attempts + 1
    } else { $attempt = 1 }
    @{attempts=$attempt;lastAttempt=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $attemptFile
    $changed = $false
    $provisioningMarker = Join-Path $state.Directory 'provisioning-incomplete'
    $provisioning = !$installed -or !(Test-Path -LiteralPath $state.Credential)
    if ($provisioning) { 'Manual review required if this transaction does not complete.' | Set-Content -LiteralPath $provisioningMarker }
    if (!$installed) {
        $download = Join-Path $state.Directory 'approved-installer.exe'
        if (Test-Path -LiteralPath $download) { throw 'Staged installer already exists; review previous attempt.' }
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $InstallerUrl.AbsoluteUri -OutFile $download -UseBasicParsing
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ine $InstallerSha256) { throw 'Installer checksum mismatch.' }
            Invoke-CloudComRustDesk $download @('--silent-install')
            $deadline = [datetime]::UtcNow.AddSeconds(40)
            do {
                $installedService=Get-Service -Name RustDesk -ErrorAction SilentlyContinue
                if ($installedService -and (Test-Path -LiteralPath $state.Exe)) { break }
                Start-Sleep -Seconds 2
            } while ([datetime]::UtcNow -lt $deadline)
            if (!$installedService) { throw 'Installed service did not appear.' }
            if (!(Test-Path -LiteralPath $state.Exe)) { throw 'Installation did not produce expected executable.' }
            if ((Get-CloudComVersion (Get-Item -LiteralPath $state.Exe).VersionInfo.ProductVersion) -ne $pinned) { throw 'Installed version mismatch.' }
            $changed = $true
        } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force } }
    }
    if ($state.Issues -contains 'configuration_drift' -or !$installed) {
        $json = @{host=$RendezvousServer;relay=$RelayServer;key=$PublicKey;api=''} | ConvertTo-Json -Compress
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_').ToCharArray()
        [array]::Reverse($encoded)
        Invoke-CloudComRustDesk $state.Exe @('--config',(-join $encoded))
        $changed = $true
    }
    if (!(Test-Path -LiteralPath $state.Credential)) {
        # Never rotate/reapply a previously stored password during routine remediation.
        $bytes = New-Object byte[] 24
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $password = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        # Stage the credential before setting it; ambiguous command failures require manual recovery.
        $pending = Join-Path $state.Directory 'credential-pending.dpapi'
        if (Test-Path -LiteralPath $pending) { throw 'Pending credential transaction requires manual recovery.' }
        $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $pending
        try {
            Invoke-CloudComRustDesk $state.Exe @('--password',$password)
            Move-Item -LiteralPath $pending -Destination $state.Credential
            if ($RecoveryPublicXml) {
                $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider(2048)
                try {
                    $rsa.FromXmlString($RecoveryPublicXml)
                    $envelope = [Convert]::ToBase64String($rsa.Encrypt([Text.Encoding]::UTF8.GetBytes($password),$true))
                    Write-Output ('RD_CREDENTIAL_ENVELOPE=' + $envelope)
                } finally { $rsa.Dispose() }
            }
        } finally { $password=$null; $secure=$null; [array]::Clear($bytes,0,$bytes.Length) }
        $changed = $true
    }
    elseif (!$installed) {
        # Reinstallation loses RustDesk's own password state; restore the SAME protected secret once.
        $secure = (Get-Content -LiteralPath $state.Credential -Raw).Trim() | ConvertTo-SecureString
        $password = (New-Object Net.NetworkCredential('', $secure)).Password
        try { Invoke-CloudComRustDesk $state.Exe @('--password',$password) }
        finally { $password=$null; $secure=$null }
    }
    Set-Service -Name RustDesk -StartupType Automatic
    if ($changed) { Restart-Service -Name RustDesk -Force }
    elseif ((Get-Service -Name RustDesk).Status -ne 'Running') { Start-Service -Name RustDesk }
    Start-Sleep -Seconds 3
    $after = Get-CloudComRustDeskState $ConfigurationPath $RendezvousServer $RelayServer $PublicKey $PinnedVersion
    $remainingIssues = @($after.Issues | Where-Object { !($provisioning -and $_ -eq 'provisioning_requires_review') })
    if ($remainingIssues.Count -gt 0) { throw 'RustDesk remains noncompliant; see read-only probe for details.' }
    Write-CloudComRustDeskId $state.Exe
    if ($provisioning) { Remove-Item -LiteralPath $provisioningMarker -Force }
    Remove-Item -LiteralPath $attemptFile -Force
    Write-Output 'RustDesk desired state restored.'
} catch {
    # Avoid accidental credential/command-line disclosure through nested native exceptions.
    Write-Output 'RustDesk repair stopped safely. Check the probe and protected local repair journal; do not automatically reset the attempt counter.'
    throw 'RustDesk desired-state repair failed.'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
