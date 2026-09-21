Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-CloudComTarget {
    param([string]$AllowedComputerName)
    if ($env:OS -ne 'Windows_NT') { throw 'Windows required.' }
    if ([string]::IsNullOrWhiteSpace($AllowedComputerName) -or $env:COMPUTERNAME -ine $AllowedComputerName) { throw 'Device safety guard refused execution.' }
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'SYSTEM execution required.' }
}

function Get-CloudComVersion {
    param([string]$Text)
    if ($Text -notmatch '^(\d+\.\d+\.\d+)(?:[.+ -].*)?$') { throw 'Unrecognized RustDesk version.' }
    return [version]$Matches[1]
}

function Test-CloudComPrivatePath {
    param([string]$Path)
    if (!(Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -Force -LiteralPath $Path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) { return $false }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18', 'S-1-5-32-544')) { return $false }
    }
    $parent = Split-Path -Parent $Path
    if ($parent -and $parent -ine $env:ProgramData) {
        return Test-CloudComPrivatePath $parent
    }
    if ($parent -ieq $env:ProgramData) {
        $root = Get-Item -Force -LiteralPath $parent
        if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $rootOwner = (Get-Acl -LiteralPath $parent).GetOwner([Security.Principal.SecurityIdentifier]).Value
        return $rootOwner -in @('S-1-5-18','S-1-5-32-544')
    }
    return $false
}

function Set-CloudComPrivateDirectory {
    param([string]$Path)
    $base = [IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (!$full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging path must be below ProgramData.' }
    if (Test-Path -LiteralPath $full) {
        if (!(Test-CloudComPrivatePath $full)) { throw 'Untrusted staging tree; manual recovery required.' }
        return
    }
    $parent = Split-Path -Parent $full
    if ($parent -ine $base) { Set-CloudComPrivateDirectory $parent }
    else {
        $root = Get-Item -Force -LiteralPath $base
        $owner = (Get-Acl -LiteralPath $base).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $owner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Untrusted ProgramData root.' }
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # Windows PowerShell 5.1 creates the directory with its final ACL atomically.
    [IO.Directory]::CreateDirectory($full, $acl) | Out-Null
    if (!(Test-CloudComPrivatePath $full)) { throw 'Private directory verification failed.' }
}

function Get-CloudComRustDeskState {
    param([string]$ConfigurationPath, [string]$RendezvousServer, [string]$RelayServer, [string]$PublicKey, [string]$PinnedVersion)
    $exe = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
    $directory = Join-Path $env:ProgramData 'CloudCom\RustDeskDeployment'
    $credential = Join-Path $directory 'unattended-v2.dpapi'
    $issues = New-Object 'Collections.Generic.List[string]'
    if (Test-Path -LiteralPath (Join-Path $directory 'provisioning-incomplete')) { $issues.Add('provisioning_requires_review') }
    $version = $null
    if (!(Test-Path -LiteralPath $exe)) { $issues.Add('installation_missing') }
    else {
        try { $version = Get-CloudComVersion (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
        catch { $issues.Add('version_unknown') }
        if ($version -and $version -lt (Get-CloudComVersion $PinnedVersion)) { $issues.Add('version_below_baseline') }
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if (!$service) { $issues.Add('service_missing') }
    else {
        if ($service.State -ne 'Running') { $issues.Add('service_stopped') }
        if ($service.StartMode -ne 'Auto') { $issues.Add('service_not_automatic') }
        if ($service.PathName -notmatch ('(?i)^"?' + [regex]::Escape($exe) + '"?(?:\s|$)')) { $issues.Add('service_path_unexpected') }
    }
    $configOk = $false
    if (Test-Path -LiteralPath $ConfigurationPath) {
        $text = Get-Content -LiteralPath $ConfigurationPath -Raw
        $sections = [regex]::Matches($text, '(?ms)^\[options\]\s*\r?\n(.*?)(?=^\[|\z)')
        $configOk = $sections.Count -eq 1
        $options = if ($configOk) { $sections[0].Groups[1].Value } else { '' }
        foreach ($pair in @(@('custom-rendezvous-server',$RendezvousServer),@('relay-server',$RelayServer),@('key',$PublicKey))) {
            $pattern = '(?m)^\s*' + [regex]::Escape($pair[0]) + '\s*=\s*[''\"]' + [regex]::Escape($pair[1]) + '[''\"]\s*$'
            $keyPattern = '(?m)^\s*' + [regex]::Escape($pair[0]) + '\s*='
            if ([regex]::Matches($options,$keyPattern).Count -ne 1 -or $options -notmatch $pattern) { $configOk = $false }
        }
    }
    if (!$configOk) { $issues.Add('configuration_drift') }
    if (Test-Path -LiteralPath $exe) {
        $quiet = Get-CloudComRustDeskQuietState $exe
        if ($quiet.Shortcuts.Count -or $quiet.TrayProcesses.Count) { $issues.Add('quiet_mode_drift') }
    }
    if (!(Test-CloudComPrivatePath $directory) -or !(Test-CloudComPrivatePath $credential)) { $issues.Add('credential_missing_or_unprotected') }
    else {
        try { $null = (Get-Content -LiteralPath $credential -Raw).Trim() | ConvertTo-SecureString }
        catch { $issues.Add('credential_unreadable') }
    }
    return [pscustomobject]@{ Exe=$exe; Directory=$directory; Credential=$credential; Version=$version; Service=$service; Issues=@($issues.ToArray()); Healthy=($issues.Count -eq 0) }
}

# Stock OSS hide-tray is a built-in custom-client setting, not a TOML option.
# Suppress only vendor shortcuts and the separate tray process; never the server,
# service, main application or active-session connection manager.
function Test-CloudComNoReparsePath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        }
        $current = Split-Path -Parent $current
    }
    return $true
}

function Test-CloudComRustDeskTrayProcess {
    param($Process, [string]$Exe)
    return $Process.ExecutablePath -ieq $Exe -and $Process.CommandLine -match ('(?i)^"?' + [regex]::Escape($Exe) + '"?\s+--tray\s*$')
}

function Get-CloudComRustDeskQuietState {
    param([string]$Exe)
    $programs = [Environment]::GetFolderPath('CommonPrograms')
    $candidates = @(
        @{Path=(Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'RustDesk.lnk'); Arguments=''},
        @{Path=(Join-Path $programs 'RustDesk\RustDesk.lnk'); Arguments=''},
        @{Path=(Join-Path $programs 'RustDesk\Uninstall RustDesk.lnk'); Arguments='--uninstall'},
        @{Path=(Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'RustDesk Tray.lnk'); Arguments='--tray'}
    )
    $shortcuts = @()
    $shell = $null
    try {
        foreach ($candidate in $candidates) {
            if (!(Test-Path -LiteralPath $candidate.Path)) { continue }
            if (!(Test-CloudComNoReparsePath $candidate.Path)) { throw 'Shortcut path is redirected; manual review required.' }
            if (!$shell) { $shell = New-Object -ComObject WScript.Shell }
            $link = $shell.CreateShortcut($candidate.Path)
            try {
                if ($link.TargetPath -ine $Exe -or $link.Arguments.Trim() -ine $candidate.Arguments) { throw 'Unexpected shortcut target; manual review required.' }
                $shortcuts += $candidate.Path
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) }
        }
    } finally { if ($shell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } }
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" | Where-Object { Test-CloudComRustDeskTrayProcess $_ $Exe })
    return [pscustomobject]@{Shortcuts=@($shortcuts); TrayProcesses=@($processes)}
}

function Set-CloudComRustDeskQuietMode {
    param([string]$Exe)
    $quiet = Get-CloudComRustDeskQuietState $Exe
    foreach ($path in $quiet.Shortcuts) {
        # Only explicit, validated .lnk files; no recursive folder removal.
        if (!(Test-CloudComNoReparsePath $path)) { throw 'Shortcut path changed; manual review required.' }
        Remove-Item -LiteralPath $path -Force
    }
    foreach ($process in $quiet.TrayProcesses) {
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$process.ProcessId)
        if ($current -and $current.CreationDate -eq $process.CreationDate -and (Test-CloudComRustDeskTrayProcess $current $Exe)) {
            Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
        }
    }
}

function Invoke-CloudComRustDesk {
    param([string]$Exe, [string[]]$Arguments)
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(90000)) { $process.Kill(); throw 'RustDesk command timed out.' }
    if ($process.ExitCode -ne 0) { throw 'RustDesk command failed.' }
}

function Write-CloudComRustDeskId {
    param([string]$Exe)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$Exe; $info.Arguments='--get-id'; $info.UseShellExecute=$false
    $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $process = New-Object Diagnostics.Process
    $process.StartInfo=$info
    try {
        $null=$process.Start()
        $output=$process.StandardOutput.ReadToEndAsync()
        $errors=$process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'RustDesk ID lookup timeout.' }
        $id=$output.Result.Trim()
        if ($process.ExitCode -ne 0 -or $id -notmatch '^\d{6,15}$') { throw 'RustDesk ID unavailable.' }
        Write-Output ('::breeze:custom-fields:: ' + (@{rustdesk_id=$id} | ConvertTo-Json -Compress))
    } finally { $process.Dispose() }
}
