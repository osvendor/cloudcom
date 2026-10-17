$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\clear-print-spool.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$script:stops = 0; $script:starts = 0; $script:state = 'Running'
function Get-Service { $s = [pscustomobject]@{ Status = $script:state }; $s | Add-Member ScriptMethod WaitForStatus { param($state,$timeout) }; $s }
function Stop-Service { $script:stops++; $script:state = 'Stopped' }
function Start-Service { $script:starts++; $script:state = 'Running' }
# Test real path validation with synthetic metadata; no registry or service calls.
& {
    function Get-Item { [pscustomobject]@{ PSIsContainer=$true; Attributes=[IO.FileAttributes]::Directory } }
    $expected = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
    Assert ((Assert-SafeSpoolFolder $expected) -eq $expected) 'default directory rejected'
    foreach ($path in @('C:\', 'C:\Users', 'C:\spool', '\\server\spool', "$expected\..\other")) {
        $rejected=$false; try { Assert-SafeSpoolFolder $path | Out-Null } catch { $rejected=$true }
        Assert $rejected "unsafe/custom path accepted: $path"
    }
    function Get-Item { [pscustomobject]@{ PSIsContainer=$true; Attributes=[IO.FileAttributes]::ReparsePoint } }
    $rejected=$false; try { Assert-SafeSpoolFolder $expected | Out-Null } catch { $rejected=$true }
    Assert $rejected 'reparse path accepted'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('companion-spool-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    # Only this child scope replaces filesystem validation with a verified disposable directory.
    & {
        function Get-SpoolFolders { $testRoot }
        function Assert-SafeSpoolFolder($Path) { if ($Path -ne $testRoot) { throw 'Unexpected test path' }; $testRoot }
        Set-Content -LiteralPath (Join-Path $testRoot 'one.SPL') -Value 'test'
        Set-Content -LiteralPath (Join-Path $testRoot 'two.SHD') -Value 'test'
        $r=Invoke-PrintSpoolCleanup $true
        Assert ($r.success -and $r.candidateCount -eq 2 -and $r.deletedCount -eq 0 -and $script:stops -eq 0) 'preview mutated or wrong count'
        & {
            $ExpectedFoldersJson='["C:\\Changed"]'
            $r=Invoke-PrintSpoolCleanup $false
            Assert (-not $r.success -and $script:stops -eq 0) 'changed preview target accepted'
        }
        $r=Invoke-PrintSpoolCleanup $false
        Assert ($r.success -and $r.deletedCount -eq 2 -and $r.serviceState -eq 'Running' -and $script:starts -eq 1) ('successful cleanup failed: ' + ($r | ConvertTo-Json -Compress))
        Assert (@(Get-ChildItem -LiteralPath $testRoot).Count -eq 0) 'files remain'
        $r=Invoke-PrintSpoolCleanup $false
        Assert ($r.success -and $r.deletedCount -eq 0) 'empty cleanup failed'
        New-Item -ItemType Directory -Path (Join-Path $testRoot 'nested') | Out-Null
        $r=Invoke-PrintSpoolCleanup $false
        Assert (-not $r.success -and $r.restartAttempted -and $r.serviceState -eq 'Running') 'directory refusal did not restart'
        Remove-Item -LiteralPath (Join-Path $testRoot 'nested')
        Set-Content -LiteralPath (Join-Path $testRoot 'locked.SPL') -Value 'test'
        & {
            function Remove-Item { throw 'mock access denied' }
            $r=Invoke-PrintSpoolCleanup $false
            Assert (-not $r.success -and $r.failedCount -eq 1 -and $r.deletedCount -eq 0 -and $r.serviceState -eq 'Running') 'deletion failure not reported'
        }
        & {
            function Stop-Service { throw 'mock stop failure' }
            $r=Invoke-PrintSpoolCleanup $false
            Assert (-not $r.success -and $r.deletedCount -eq 0 -and $r.restartAttempted) 'stop failure did not restart'
        }
        & {
            function Start-Service { throw 'mock restart failure' }
            $r=Invoke-PrintSpoolCleanup $false
            Assert (-not $r.success -and $r.serviceState -eq 'Stopped') 'restart failure not reported'
        }
        & {
            function Assert-SafeSpoolFolder { throw 'custom directory requires review' }
            $before=$script:stops
            $r=Invoke-PrintSpoolCleanup $false
            Assert (-not $r.success -and $script:stops -eq $before) 'invalid config stopped service'
        }
    }
    Write-Output 'PASS: preview, counts, empty, custom/root/traversal/reparse refusal, subdirectory refusal, deletion failure, stop failure and restart failure.'
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'companion-spool-test-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

