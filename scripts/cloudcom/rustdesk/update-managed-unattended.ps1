param(
    [Parameter(Mandatory)][string]$AllowedComputerName,
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallerSha256,
    [Parameter(Mandatory)][string]$ExpectedServiceExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedServiceSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedLibrarySha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NewExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NewLibrarySha256,
    [Parameter(Mandatory)][string]$LogPath
)
# One-time migration of an existing enrolled bundle target into MSI ownership.
# Never a second service or a stock-client fallback; later MSI upgrades are a separate release step.
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $AllowedComputerName
$ErrorActionPreference='Stop'
$mutex=New-Object Threading.Mutex($false,'Global\CloudComRustDeskDesiredState')
$locked=$false
$installationStarted=$false
$oldPath=$null
$configPath=Join-Path $env:WINDIR 'ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml'
foreach($path in @($InstallerPath,$ExpectedServiceExecutable,$LogPath)) {
    if(![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]'){throw 'Absolute unquoted update paths required.'}
}
function Test-ManagedEnrollmentProtection([string]$Path) {
    if(!(Test-Path -LiteralPath $Path -PathType Leaf) -or !(Test-CloudComNoReparsePath $Path)){return $false}
    $current=$Path; $depth=0
    $writes=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    while($current -and $current -ine $env:ProgramData) {
        $acl=Get-Acl -LiteralPath $current
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){return $false}
        foreach($rule in $acl.Access) {
            if($rule.AccessControlType -ne 'Allow'){continue}
            $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if($sid -notin @('S-1-5-18','S-1-5-32-544') -and ($depth -lt 2 -or ($rule.FileSystemRights -band $writes))){return $false}
        }
        $current=Split-Path -Parent $current; $depth++
    }
    return $true
}
function Read-NativeValue([string]$Executable,[string]$Argument) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$Executable; $info.Arguments=$Argument; $info.UseShellExecute=$false
    $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$info
    try {
        $null=$process.Start(); $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(15000)){ $process.Kill(); throw 'Native identity probe timed out.' }
        if($process.ExitCode -ne 0){throw 'Native identity probe failed.'}
        $stdout.Result.Trim()
    } finally {$process.Dispose()}
}
try {
    try {$locked=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$locked=$true}
    if(!$locked){throw 'Another RustDesk repair is running.'}
    foreach($file in @($InstallerPath,$ExpectedServiceExecutable)) {
        if(!(Test-Path -LiteralPath $file -PathType Leaf) -or !(Test-CloudComNoReparsePath $file)){throw 'Missing or redirected update input.'}
    }
    if((Get-FileHash -LiteralPath $InstallerPath).Hash -ne $InstallerSha256){throw 'Unapproved MSI.'}
    if((Get-FileHash -LiteralPath $ExpectedServiceExecutable).Hash -ne $ExpectedServiceSha256){throw 'Existing target changed; review before upgrading.'}
    $oldLibrary=Join-Path (Split-Path $ExpectedServiceExecutable) 'librustdesk.dll'
    if(!(Test-CloudComNoReparsePath $oldLibrary) -or (Get-FileHash -LiteralPath $oldLibrary).Hash -ne $ExpectedLibrarySha256){throw 'Existing native library changed; review before upgrading.'}
    $service=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if(!$service -or !(Test-CloudComRustDeskServicePath $service.PathName $ExpectedServiceExecutable)){throw 'Existing service identity changed.'}
    if((Read-NativeValue $ExpectedServiceExecutable '--cloudcom-managed-protocol') -ne '2'){throw 'Only existing managed protocol 2 targets may be upgraded.'}
    $enrollment=Join-Path $env:ProgramData 'Breeze\data\rustdesk\native-admission.dpapi'
    if(!(Test-Path -LiteralPath $enrollment -PathType Leaf)){throw 'Existing managed enrollment required.'}
    $peer=Read-NativeValue $ExpectedServiceExecutable '--get-id'
    $key=Read-NativeValue $ExpectedServiceExecutable '--cloudcom-managed-public-key'
    if($peer -notmatch '^\d{1,32}$' -or !$key){throw 'Existing managed identity is unavailable.'}
    if([IO.Path]::GetFullPath($ExpectedServiceExecutable) -ieq (Join-Path $env:ProgramFiles 'RustDesk\RustDesk.exe')){throw 'Already adopted: use the verified MSI upgrade release, not the bundle migration.'}
    $oldPath=$service.PathName
    if(!(Test-ManagedEnrollmentProtection $enrollment)){throw 'Enrollment protection is invalid.'}
    if(!(Test-Path -LiteralPath $configPath)){throw 'Private routing configuration missing.'}
    $routing=@(Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^(custom-rendezvous-server|relay-server|key)\s*=' })
    if($routing.Count -ne 3){throw 'Expected explicit private routing settings.'}
    $backup=Join-Path $env:ProgramData ('CloudCom\RustDeskMigration\'+[guid]::NewGuid().ToString('N'))
    Set-CloudComPrivateDirectory $backup
    Copy-Item -LiteralPath $enrollment -Destination (Join-Path $backup 'native-admission.dpapi')
    Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'RustDesk2.toml')
    $oldPath | Set-Content -LiteralPath (Join-Path $backup 'service-path.txt')
    $legacyPath='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\RustDesk'
    $legacy=Get-ItemProperty -LiteralPath $legacyPath -ErrorAction SilentlyContinue
    $adopt=''
    if($legacy) {
        if($legacy.WindowsInstaller -ne 0 -or $legacy.InstallLocation.TrimEnd('\') -ine (Join-Path $env:ProgramFiles 'RustDesk') -or $legacy.DisplayName -ne 'RustDesk'){throw 'Unrecognized legacy registration; manual review required.'}
        & reg.exe export 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\RustDesk' (Join-Path $backup 'legacy-registration.reg') /y | Out-Null
        if($LASTEXITCODE -ne 0){throw 'Legacy registration backup failed.'}
        $adopt=' CLOUDCOM_ADOPT_EXISTING=1'
    }
    $exe=Join-Path $env:ProgramFiles 'RustDesk\RustDesk.exe'
    $msiArgs='/i "'+$InstallerPath+'" /qn /norestart INSTALLPRINTER=1 CREATEDESKTOPSHORTCUTS=N CREATESTARTMENUSHORTCUTS=N CREATESTARTUPSHORTCUTS=N LAUNCH_TRAY_APP=N /l*v "'+$LogPath+'"'
    $msiArgs+=$adopt
    $installationStarted=$true
    $installer=Start-Process msiexec.exe -ArgumentList $msiArgs -WindowStyle Hidden -Wait -PassThru
    if($installer.ExitCode -notin @(0,3010)){throw "Managed MSI installation failed ($($installer.ExitCode)); inspect the MSI log."}
    $installedService=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if(!(Test-CloudComRustDeskServicePath $installedService.PathName $exe) -or $installedService.State -ne 'Running'){throw 'Managed service was not installed/running at its expected path.'}
    if((Get-FileHash -LiteralPath $exe).Hash -ne $NewExecutableSha256 -or (Get-FileHash -LiteralPath (Join-Path (Split-Path $exe) 'librustdesk.dll')).Hash -ne $NewLibrarySha256){throw 'Installed native payload differs from the approved build.'}
    if((Read-NativeValue $exe '--cloudcom-managed-protocol') -ne '2' -or (Read-NativeValue $exe '--get-id') -ne $peer -or (Read-NativeValue $exe '--cloudcom-managed-public-key') -ne $key){throw 'Native protocol or existing target identity changed.'}
    if(!(Get-Printer -Name 'RustDesk Printer' -ErrorAction SilentlyContinue) -or !(Get-PrinterDriver -Name 'RustDesk v4 Printer Driver' -ErrorAction SilentlyContinue)){throw 'Printer setup failed; MSI exit status alone is insufficient.'}
    if(!(Test-ManagedEnrollmentProtection $enrollment)){throw 'Enrollment missing or protection changed after update.'}
    $newRouting=@(Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^(custom-rendezvous-server|relay-server|key)\s*=' })
    if(Compare-Object $routing $newRouting){throw 'Private routing changed during update.'}
    [pscustomobject]@{State='updated';Service='RustDesk';IdentityPreserved=$true;PrinterInstalled=$true;RebootRequired=($installer.ExitCode -eq 3010)}
} catch {
    $failure=$_
    if($installationStarted -and $oldPath) {
        # Restore the retained working target if installation or verification fails.
        # No rollback to a stock executable or new enrollment is permitted.
        Stop-Service RustDesk -Force -ErrorAction SilentlyContinue
        if(Get-Service RustDesk -ErrorAction SilentlyContinue) {
            Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\RustDesk' ImagePath $oldPath
        } else { New-Service -Name RustDesk -BinaryPathName $oldPath -StartupType Automatic | Out-Null }
        Copy-Item -LiteralPath (Join-Path $backup 'RustDesk2.toml') -Destination $configPath -Force
        Copy-Item -LiteralPath (Join-Path $backup 'native-admission.dpapi') -Destination $enrollment -Force
        Start-Service RustDesk
    }
    throw $failure
} finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
