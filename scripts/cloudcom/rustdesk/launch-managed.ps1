param(
    [Parameter(Mandatory)][string]$ProfilePath,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
try {

# Local deployment profile; keep addresses and bundle fingerprints out of Git.
# RUSTDESK_APPNAME is RustDesk's supported portable executable-name override.
# Scope it to this process: never depend on mutable stock-client settings.
$profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
if ($profile.version -ne 1) { throw 'Unsupported managed launcher profile version.' }
foreach ($field in @('rendezvous', 'relay')) {
    $value = [string]$profile.$field
    if ($value -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$') {
        throw "Missing or invalid $field. Public-server fallback is not allowed."
    }
    if ($value -match ':(\d+)$' -and ([int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535)) {
        throw "Invalid $field port."
    }
}
$publicKey = [string]$profile.publicKey
if ($publicKey -notmatch '^[A-Za-z0-9+/]{43}=$' -or [Convert]::FromBase64String($publicKey).Length -ne 32) {
    throw 'A pinned 32-byte RustDesk server public key is required.'
}
if ($profile.bundleDirectory -eq '.') {
    $bundle = Split-Path -Parent (Resolve-Path -LiteralPath $ProfilePath).Path
} else {
    if (![IO.Path]::IsPathRooted([string]$profile.bundleDirectory)) { throw 'Bundle directory must be absolute or a profile-relative dot.' }
    $bundle = [IO.Path]::GetFullPath([string]$profile.bundleDirectory).TrimEnd('\', '/')
}
$fingerprints = @($profile.files.PSObject.Properties)
foreach ($required in @('rustdesk.exe', 'librustdesk.dll', 'data/app.so')) {
    if ($required -notin $fingerprints.Name) { throw "Missing bundle fingerprint: $required" }
}
foreach ($entry in $fingerprints) {
    $relative = $entry.Name
    if ($relative -match '(^[\\/]|:|(^|[\\/])\.\.?([\\/]|$))' -or $entry.Value -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Invalid bundle fingerprint entry.'
    }
    $file = Join-Path $bundle $relative
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) {
        throw "Managed bundle is missing or changed: $relative. Use a verified complete bundle."
    }
}
$exe = Join-Path $bundle 'rustdesk.exe'
$route = "rustdesk-host=$($profile.rendezvous),key=$publicKey,relay=$($profile.relay).exe"
if ($ValidateOnly) {
    [pscustomobject]@{ Valid = $true; Executable = $exe; PortableRoute = $route; VerifiedFiles = $fingerprints.Count }
    return
}
if (@(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" | Where-Object { $_.ExecutablePath -eq $exe }).Count) {
    throw 'The managed viewer is already open. Close it before launching a fresh managed session.'
}
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $exe
$start.WorkingDirectory = $bundle
$start.UseShellExecute = $false
$start.EnvironmentVariables['RUSTDESK_APPNAME'] = $route
$start.EnvironmentVariables['RUST_LOG'] = 'info'
$process = [Diagnostics.Process]::Start($start)
[pscustomobject]@{ ProcessId = $process.Id; Executable = $exe; VerifiedFiles = $fingerprints.Count }
} catch {
    if (!$ValidateOnly) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($_.Exception.Message, 'CloudCom Remote Access') | Out-Null
    }
    throw
}
