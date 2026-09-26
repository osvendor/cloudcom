# Dependency-free regression test. Never launches RustDesk or changes user config.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-managed.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cloudcom-launch-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'data') -Force | Out-Null
$files = @{}
foreach ($name in @('rustdesk.exe', 'librustdesk.dll', 'data/app.so')) {
    $path = Join-Path $fixture $name
    [IO.File]::WriteAllText($path, 'fixture ' + $name)
    $files[$name] = (Get-FileHash -LiteralPath $path).Hash
}
$profile = [ordered]@{ version=1; bundleDirectory=$fixture; rendezvous='rendezvous.example.test:21116'; relay='relay.example.test:21117'; publicKey=[Convert]::ToBase64String((New-Object byte[] 32)); files=$files }
$profilePath = Join-Path $fixture 'profile.json'
$script:passed = 0
function Invoke-Case([string]$Name, [bool]$ShouldPass) {
    $profile | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $profilePath -Encoding UTF8
    $failed = $false
    try { $result = & $launcher -ProfilePath $profilePath -ValidateOnly } catch { $failed = $true }
    if ($failed -eq $ShouldPass) { throw "FAIL: $Name" }
    if ($ShouldPass -and ($result.PortableRoute -ne "rustdesk-host=$($profile.rendezvous),key=$($profile.publicKey),relay=$($profile.relay).exe" -or $result.VerifiedFiles -ne 3)) { throw "FAIL: $Name route" }
    $script:passed++
    Write-Output "PASS: $Name"
}
try {
    Invoke-Case 'explicit routing and complete matching bundle' $true
    $profile.bundleDirectory='.'; Invoke-Case 'installed profile resolves beside itself' $true
    $profile.bundleDirectory='../other'; Invoke-Case 'reject arbitrary relative bundle path' $false
    $profile.bundleDirectory=$fixture
    $profile.rendezvous=''; Invoke-Case 'missing route cannot fall back to public servers' $false
    $profile.rendezvous='host.example,key=injected'; Invoke-Case 'reject filename-setting injection' $false
    $profile.rendezvous='host.example:70000'; Invoke-Case 'reject invalid port' $false
    $profile.rendezvous='host.example'; $profile.publicKey='invalid'; Invoke-Case 'require server key' $false
    $profile.publicKey=[Convert]::ToBase64String((New-Object byte[] 32))
    $original=$files['librustdesk.dll']; $files['librustdesk.dll']='a'*64; Invoke-Case 'reject mismatched native DLL' $false
    $files['librustdesk.dll']=$original
    $original=$files['data/app.so']; $files.Remove('data/app.so'); Invoke-Case 'require Flutter application fingerprint' $false
    $files['data/app.so']=$original
    $files['../outside.exe']='a'*64; Invoke-Case 'reject traversal in bundle inventory' $false
    $files.Remove('../outside.exe')
    Invoke-Case 'valid profile after failed cases' $true
    Write-Output "$script:passed managed launcher checks passed."
} finally {
    # Exact newly-created fixture only; never traverse a user-selected directory.
    $resolved = [IO.Path]::GetFullPath($fixture)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ((Split-Path $resolved) -eq $parent -and (Split-Path $resolved -Leaf) -match '^cloudcom-launch-test-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
