param(
    [Parameter(Mandatory)][string]$AllowedComputerName,
    [Parameter(Mandatory)][guid]$ExpectedOrganizationId,
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallerSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NewExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NewLibrarySha256,
    [Parameter(Mandatory)][string]$RollbackInstallerPath,
    [ValidateRange(60,1800)][int]$InstallerTimeoutSeconds=900
)
# Explicit one-device 68 -> 69 MSI release, not desired-state repair or adoption.
# Bundle common.ps1 after this parameter block when saving as a Breeze script.
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $AllowedComputerName
if (![Environment]::Is64BitProcess) { throw '64-bit SYSTEM PowerShell required.' }
$oldMsiHash='727E175A37585CBB98232C188F46D221EAD9B0B05B69EFB6D2012969ECFB9E85'
$oldExeHash='ADF4C6313FB717FB62B6447A67CF5406207228945ABC2FB799E04E89210975BE'
$oldDllHash='B5E885348145403A7A5C10D130DCD45916129D7D9037DE1FDFAF5F831E81B6E7'
$exe=Join-Path $env:ProgramFiles 'RustDesk\RustDesk.exe'
$dll=Join-Path (Split-Path $exe) 'librustdesk.dll'
$enrollment=Join-Path $env:ProgramData 'Breeze\data\rustdesk\native-admission.dpapi'
$configRoot=Join-Path $env:WINDIR 'ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config'
$configPath=Join-Path $configRoot 'RustDesk2.toml'

function Assert-UpgradeOrganization([string]$Yaml,[guid]$OrganizationId) {
    if ($Yaml -notmatch ('(?m)^org_id:\s*'+[regex]::Escape($OrganizationId.ToString())+'\s*$')) {
        throw 'Breeze organization guard refused execution.'
    }
}
function Assert-UpgradePayload([string]$ExeHash,[string]$DllHash,[string]$ExpectedExe,[string]$ExpectedDll) {
    if ($ExeHash -ine $ExpectedExe -or $DllHash -ine $ExpectedDll) { throw 'Unapproved or mixed managed payload; no adoption permitted.' }
}
function Assert-UpgradeMsiMetadata($Metadata,[string]$Version) {
    if ($Metadata.ProductName -cne 'OS Consultants - Remote Access Agent' -or
        $Metadata.Manufacturer -cne 'OS Consultants' -or $Metadata.ProductVersion -cne $Version -or
        $Metadata.UpgradeCode.Trim('{}') -ine 'd3dc41e3-3c37-5d52-bb47-f6673705c01b' -or
        $Metadata.ProductCode -notmatch '^\{[0-9a-fA-F-]{36}\}$') { throw 'MSI product identity does not match the approved managed host release.' }
}
function Read-UpgradeMsiMetadata([string]$Path) {
    $installer=$null; $database=$null; $view=$null
    try {
        $installer=New-Object -ComObject WindowsInstaller.Installer
        $database=$installer.OpenDatabase($Path,0)
        $view=$database.OpenView('SELECT `Property`,`Value` FROM `Property`'); [void]$view.Execute()
        $result=@{}
        while ($record=$view.Fetch()) {
            try { $result[$record.StringData(1)]=$record.StringData(2) }
            finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
        return [pscustomobject]$result
    } finally {
        if ($view) { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($view) }
        if ($database) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($database) }
        if ($installer) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }
    }
}
function Assert-UpgradeMsiOwned([string]$ProductCode) {
    $installer=$null
    try {
        $installer=New-Object -ComObject WindowsInstaller.Installer
        if ($installer.ProductState($ProductCode) -ne 5) { throw 'Approved 68 must already be installed and owned by Windows Installer.' }
    } finally { if ($installer) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer) } }
}
function Read-UpgradeNativeValue([string]$Argument) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$exe; $info.Arguments=$Argument; $info.UseShellExecute=$false
    $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process; $process.StartInfo=$info
    try {
        [void]$process.Start(); $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'Bounded native identity probe timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Native identity probe failed.' }
        return $stdout.Result.Trim()
    } finally { $process.Dispose() }
}
function Get-UpgradeIdentity {
    $protocol=Read-UpgradeNativeValue '--cloudcom-managed-protocol'
    $peer=Read-UpgradeNativeValue '--get-id'
    $key=Read-UpgradeNativeValue '--cloudcom-managed-public-key'
    if ($protocol -ne '2' -or $peer -notmatch '^\d{1,32}$' -or !$key) { throw 'An existing managed protocol 2 identity is required.' }
    return @{Protocol=$protocol;Peer=$peer;Key=$key}
}
function Assert-UpgradeIdentity($Before,$After) {
    if ($Before.Protocol -cne $After.Protocol -or $Before.Peer -cne $After.Peer -or $Before.Key -cne $After.Key) {
        throw 'Managed target identity changed; refusing identity rotation.'
    }
}
function Get-UpgradePrivateRoutingFingerprint([string]$Text) {
    $values=New-Object 'Collections.Generic.List[string]'
    foreach ($name in @('custom-rendezvous-server','relay-server','key')) {
        $declarations=[regex]::Matches($Text,'(?m)^\s*'+[regex]::Escape($name)+'\s*=.*$')
        if ($declarations.Count -ne 1) { throw 'Private routing must contain exactly one value per managed key.' }
        $match=[regex]::Match($declarations[0].Value,'^\s*'+[regex]::Escape($name)+'\s*=\s*["'']([^"''\r\n]+)["'']\s*$')
        if (!$match.Success) { throw 'Private routing requires nonempty quoted managed values.' }
        $values.Add($name); $values.Add($match.Groups[1].Value)
    }
    $canonical=ConvertTo-Json -InputObject ($values.ToArray()) -Compress
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-','') }
    finally { $sha.Dispose() }
}
function Wait-UpgradeServiceState([ValidateSet('Running','Stopped')][string]$State,[switch]$RequestChange) {
    Add-Type -AssemblyName System.ServiceProcess
    $controller=Get-Service -Name RustDesk -ErrorAction Stop
    try {
        $target=[ServiceProcess.ServiceControllerStatus]::$State
        if ($RequestChange -and $controller.Status -ne $target) {
            if ($State -eq 'Stopped') { $controller.Stop() } else { $controller.Start() }
        }
        $controller.WaitForStatus($target,[timespan]::FromSeconds(30))
    } finally { $controller.Dispose() }
}
function Assert-UpgradeProtectedEnrollment {
    if (!(Test-CloudComNoReparsePath $enrollment) -or !(Test-Path -LiteralPath $enrollment -PathType Leaf)) { throw 'Protected enrollment missing.' }
    $current=$enrollment
    $writes=[Security.AccessControl.FileSystemRights]'Write,Delete,ChangePermissions,TakeOwnership'
    while ($current -and $current -ine $env:ProgramData) {
        $acl=Get-Acl -LiteralPath $current
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Untrusted enrollment owner.' }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -eq 'Allow' -and
                $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544') -and
                ($rule.FileSystemRights -band $writes)) { throw 'Untrusted enrollment write permission.' }
        }
        $current=Split-Path -Parent $current
    }
}
function Invoke-UpgradeMsi([string]$Msi,[string]$Log,[bool]$Rollback=$false) {
    $arguments='/i "'+$Msi+'" /qn /norestart INSTALLPRINTER=N CREATEDESKTOPSHORTCUTS=N CREATESTARTMENUSHORTCUTS=N CREATESTARTUPSHORTCUTS=N LAUNCH_TRAY_APP=N /l*v "'+$Log+'"'
    if ($Rollback) { $arguments+=' REINSTALLMODE=amus' }
    $process=Start-Process msiexec.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $script:installerStarted=$true
    try {
        if (!$process.WaitForExit($InstallerTimeoutSeconds*1000)) {
            $script:installerUnsettled=$true
            @{State='installer_unsettled';Pid=$process.Id;Utc=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $journal -Encoding UTF8
            throw 'MSI exceeded its deadline; it was not killed. No rollback or second installer is allowed; manual review required.'
        }
        $process.Refresh()
        if ($process.ExitCode -eq 1618) {
            $script:installerUnsettled=$true
            @{State='windows_installer_busy';Utc=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $journal -Encoding UTF8
            throw 'Windows Installer is busy; no rollback or second installer will be attempted.'
        }
        if ($process.ExitCode -notin @(0,3010)) { throw "MSI failed with exit $($process.ExitCode); inspect protected log." }
        return $process.ExitCode
    } finally { $process.Dispose() }
}
function Assert-UpgradePostflight([string]$ExpectedExe,[string]$ExpectedDll,$Identity,[string]$EnrollmentHash,[string]$EnrollmentAcl,[string]$RoutingHash) {
    Wait-UpgradeServiceState -State Running
    foreach ($path in @($exe,$dll)) { if (!(Test-CloudComNoReparsePath $path)) { throw 'Installed managed payload is redirected.' } }
    Assert-UpgradePayload (Get-FileHash -LiteralPath $exe).Hash (Get-FileHash -LiteralPath $dll).Hash $ExpectedExe $ExpectedDll
    $service=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if (!$service -or !(Test-CloudComRustDeskServicePath $service.PathName $exe) -or $service.State -ne 'Running' -or $service.StartMode -ne 'Auto') { throw 'Expected managed MSI service is not running automatically.' }
    if (!(Test-CloudComRustDeskFirewall $exe)) { throw 'Managed direct-access firewall verification failed.' }
    Assert-UpgradeIdentity $Identity (Get-UpgradeIdentity)
    Assert-UpgradeProtectedEnrollment
    if ((Get-FileHash -LiteralPath $enrollment).Hash -ine $EnrollmentHash -or (Get-Acl -LiteralPath $enrollment).Sddl -cne $EnrollmentAcl) { throw 'Protected enrollment bytes or ACL changed.' }
    if (!(Test-CloudComNoReparsePath $configPath) -or (Get-UpgradePrivateRoutingFingerprint (Get-Content -LiteralPath $configPath -Raw)) -ine $RoutingHash) { throw 'Private routing configuration changed.' }
}

$mutex=New-Object Threading.Mutex($false,'Global\CloudComRustDeskDesiredState')
$locked=$false; $script:installerStarted=$false; $script:installerUnsettled=$false; $backup=$null
try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (!$locked) { throw 'Another managed-host repair or upgrade is in progress.' }
    $stage=Join-Path $env:ProgramData 'CloudCom\ManagedHostUpgrade69'
    Set-CloudComPrivateDirectory $stage
    $journal=Join-Path $stage 'manual-review.json'
    if (Test-Path -LiteralPath $journal) { throw 'Previous MSI upgrade requires manual review; no installer started.' }
    $yamlPath=Join-Path $env:ProgramData 'Breeze\agent.yaml'
    if (!(Test-CloudComNoReparsePath $yamlPath)) { throw 'Untrusted Breeze organization file.' }
    Assert-UpgradeOrganization (Get-Content -LiteralPath $yamlPath -Raw) $ExpectedOrganizationId
    foreach ($path in @($InstallerPath,$RollbackInstallerPath,$exe,$dll,$configPath)) {
        if (![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]' -or !(Test-Path -LiteralPath $path -PathType Leaf) -or !(Test-CloudComNoReparsePath $path)) { throw 'Missing or redirected upgrade input.' }
    }
    Assert-UpgradePayload (Get-FileHash -LiteralPath $exe).Hash (Get-FileHash -LiteralPath $dll).Hash $oldExeHash $oldDllHash
    if ((Get-FileHash -LiteralPath $InstallerPath).Hash -ine $InstallerSha256 -or (Get-FileHash -LiteralPath $RollbackInstallerPath).Hash -ine $oldMsiHash) { throw 'Unapproved upgrade or rollback MSI.' }
    $newMetadata=Read-UpgradeMsiMetadata $InstallerPath; Assert-UpgradeMsiMetadata $newMetadata '1.5.0.69'
    $oldMetadata=Read-UpgradeMsiMetadata $RollbackInstallerPath; Assert-UpgradeMsiMetadata $oldMetadata '1.5.0.68'
    Assert-UpgradeMsiOwned $oldMetadata.ProductCode
    if ($newMetadata.ProductCode -ieq $oldMetadata.ProductCode) { throw 'A distinct managed upgrade ProductCode is required.' }
    $service=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if (!$service -or !(Test-CloudComRustDeskServicePath $service.PathName $exe)) { throw 'Only the existing approved Program Files managed host may be upgraded.' }
    Assert-UpgradeProtectedEnrollment
    $identity=Get-UpgradeIdentity
    $enrollmentHash=(Get-FileHash -LiteralPath $enrollment).Hash; $enrollmentAcl=(Get-Acl -LiteralPath $enrollment).Sddl
    $routingHash=Get-UpgradePrivateRoutingFingerprint (Get-Content -LiteralPath $configPath -Raw)
    $backup=Join-Path $stage ([guid]::NewGuid().ToString('N')); Set-CloudComPrivateDirectory $backup
    foreach ($item in Get-ChildItem -LiteralPath $configRoot -Recurse -Force) { if (!(Test-CloudComNoReparsePath $item.FullName)) { throw 'Redirected service configuration cannot be backed up.' } }
    Copy-Item -LiteralPath $configRoot -Destination (Join-Path $backup 'config') -Recurse
    Copy-Item -LiteralPath $enrollment -Destination (Join-Path $backup 'native-admission.dpapi')
    $installer=Join-Path $backup 'approved-69.msi'; $rollback=Join-Path $backup 'approved-68.msi'
    Copy-Item -LiteralPath $InstallerPath -Destination $installer; Copy-Item -LiteralPath $RollbackInstallerPath -Destination $rollback
    if ((Get-FileHash $installer).Hash -ine $InstallerSha256 -or (Get-FileHash $rollback).Hash -ine $oldMsiHash) { throw 'Protected staged MSI checksum mismatch.' }
    $exitCode=Invoke-UpgradeMsi $installer (Join-Path $backup 'upgrade.log')
    Assert-UpgradePostflight $NewExecutableSha256 $NewLibrarySha256 $identity $enrollmentHash $enrollmentAcl $routingHash
    @{State='upgraded';Version='1.5.0.69';IdentityPreserved=$true;RebootRequired=($exitCode -eq 3010)} | ConvertTo-Json -Compress
} catch {
    $failure=$_
    if ($script:installerStarted -and !$script:installerUnsettled -and $backup) {
        try {
            # Installer has exited. Restore only the exact approved 68 MSI,
            # never a stock binary or a newly generated target identity.
            [void](Invoke-UpgradeMsi $rollback (Join-Path $backup 'rollback.log') $true)
            Wait-UpgradeServiceState -State Stopped -RequestChange
            Copy-Item -LiteralPath (Join-Path $backup 'native-admission.dpapi') -Destination $enrollment -Force
            $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetSecurityDescriptorSddlForm($enrollmentAcl); Set-Acl -LiteralPath $enrollment -AclObject $acl
            Copy-Item -Path (Join-Path $backup 'config\*') -Destination $configRoot -Recurse -Force
            Wait-UpgradeServiceState -State Running -RequestChange
            Assert-UpgradePostflight $oldExeHash $oldDllHash $identity $enrollmentHash $enrollmentAcl $routingHash
            Write-Output 'Upgrade failed; verified approved 68 rollback completed with the existing identity.'
        } catch {
            @{State='rollback_requires_review';Utc=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $journal -Encoding UTF8
            throw 'Upgrade failed and rollback requires manual review; inspect protected logs. No further installer will start automatically.'
        }
    }
    throw $failure
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
