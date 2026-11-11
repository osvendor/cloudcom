# Runs as the agent's elevated Windows identity. No caller-supplied filesystem paths.
param([switch]$Preview, [string]$ExpectedFoldersJson)
$ErrorActionPreference = 'Stop'

function Get-SpoolFolders {
    $default = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
    $properties = Get-ItemProperty -LiteralPath $root -ErrorAction Stop
    $global = $properties.PSObject.Properties['DefaultSpoolDirectory']
    if ($global -and -not [string]::IsNullOrWhiteSpace([string]$global.Value)) { $default = [string]$global.Value }
    $folders = @($default)
    foreach ($printer in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
        $properties = Get-ItemProperty -LiteralPath $printer.PSPath -ErrorAction Stop
        $custom = $properties.PSObject.Properties['SpoolDirectory']
        if ($custom -and -not [string]::IsNullOrWhiteSpace([string]$custom.Value)) { $folders += [string]$custom.Value }
    }
    @($folders | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) } | Select-Object -Unique)
}

function Assert-SafeSpoolFolder([string]$Path) {
    $expected = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\spool\PRINTERS')).TrimEnd('\')
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('..') -or $Path.Contains('*') -or $Path.Contains('?')) {
        throw 'Spool directory must be an absolute local Windows path without traversal or wildcards.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $full.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Custom spool directory requires review: $full. No files were deleted."
    }
    # Check the complete ancestor chain, including the spool folder itself.
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unsafe spool directory or ancestor: $cursor"
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    $full
}

function Invoke-PrintSpoolCleanup([bool]$PreviewOnly) {
    $result = [ordered]@{
        success = $false; mode = $(if ($PreviewOnly) { 'preview' } else { 'execute' })
        spoolFolders = @(); candidateCount = 0; fileCount = 0; deletedCount = 0; failedCount = 0
        errors = @(); serviceState = 'Unknown'; restartAttempted = $false
    }
    $mustRestart = $false
    try {
        $result.spoolFolders = @(Get-SpoolFolders)
        $safeFolders = @($result.spoolFolders | ForEach-Object { Assert-SafeSpoolFolder $_ } | Select-Object -Unique)
        if (-not $safeFolders.Count) { throw 'No spool directories were found.' }
        if (-not $PreviewOnly -and $ExpectedFoldersJson) {
            $expectedFolders = @($ExpectedFoldersJson | ConvertFrom-Json | ForEach-Object { Assert-SafeSpoolFolder ([string]$_) } | Select-Object -Unique)
            if (@(Compare-Object $expectedFolders $safeFolders).Count -ne 0) { throw 'Spool directories changed since preview; preview again.' }
        }
        $service = Get-Service -Name Spooler -ErrorAction Stop
        $result.serviceState = [string]$service.Status
        if (-not $PreviewOnly) {
            # Once a stop is attempted, always attempt restart even if stop/cleanup fails.
            $mustRestart = $true
            Stop-Service -Name Spooler -Force -ErrorAction Stop
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
        foreach ($folder in $safeFolders) {
            $null = Assert-SafeSpoolFolder $folder
            $entries = @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop)
            # Never recurse. Unexpected directories/links are refused before any deletion.
            foreach ($entry in $entries) {
                if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw 'Spool directory contains a subdirectory or reparse point; cleanup refused.'
                }
            }
            $result.candidateCount += $entries.Count
            $result.fileCount = $result.candidateCount
            if ($PreviewOnly) { continue }
            foreach ($entry in $entries) {
                try {
                    $null = Assert-SafeSpoolFolder $folder
                    $fresh = Get-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop
                    if ($fresh.PSIsContainer -or ($fresh.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'File changed to a directory or reparse point.' }
                    if (-not [IO.Path]::GetDirectoryName($fresh.FullName).Equals($folder, [StringComparison]::OrdinalIgnoreCase)) { throw 'File escaped the spool directory.' }
                    Remove-Item -LiteralPath $fresh.FullName -Force -ErrorAction Stop
                    $result.deletedCount++
                } catch {
                    $result.failedCount++
                    $result.errors += "File cleanup failed: $($_.Exception.Message)"
                }
            }
        }
    } catch { $result.errors += $_.Exception.Message }
    finally {
        if ($mustRestart) {
            $result.restartAttempted = $true
            try {
                Start-Service -Name Spooler -ErrorAction Stop
                $service = Get-Service -Name Spooler -ErrorAction Stop
                $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
            } catch { $result.errors += "Spooler restart failed: $($_.Exception.Message)" }
        }
        try { $result.serviceState = [string](Get-Service -Name Spooler -ErrorAction Stop).Status }
        catch { $result.errors += 'Unable to verify final Spooler service state.' }
    }
    $result.success = ($result.errors.Count -eq 0 -and ($PreviewOnly -or $result.serviceState -eq 'Running'))
    if (-not $PreviewOnly -and $result.serviceState -ne 'Running' -and $result.errors.Count -eq 0) { $result.errors += 'Spooler is not running after cleanup.' }
    [pscustomobject]$result
}

# Dot sourcing is reserved for mocked tests; normal agent execution emits one JSON result.
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-PrintSpoolCleanup -PreviewOnly ([bool]$Preview)
    $result | ConvertTo-Json -Depth 5 -Compress
    if (-not $result.success) { exit 1 }
    exit 0
}

