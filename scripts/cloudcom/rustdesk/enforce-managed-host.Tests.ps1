$scriptPath = Join-Path $PSScriptRoot 'enforce-managed-host.ps1'
$scriptText = Get-Content -LiteralPath $scriptPath -Raw

    # Extract only the pure issue collector. The enforcement script itself is
    # never dot-sourced: that would run its endpoint mutation path.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'enforce-managed-host.ps1 did not parse.' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ManagedIssues' }, $true)
if (-not $function) { throw 'Get-ManagedIssues was not found.' }

$script:exe = 'C:\Program Files\RustDesk\RustDesk.exe'
    $script:dll = 'C:\Program Files\RustDesk\librustdesk.dll'
    $script:enrollment = 'C:\ProgramData\Breeze\data\rustdesk\native-admission.dpapi'
    $script:configPath = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml'
    $script:exeHash = 'exe'; $script:dllHash = 'dll'
    $script:RendezvousServer = 'rd.example'; $script:RelayServer = 'relay.example'; $script:ServerPublicKey = 'key'
    $script:service = $null
    $script:payloadOk = $true; $script:routingOk = $true; $script:enrollmentOk = $true; $script:firewallOk = $true

    function Test-Path { param([string]$LiteralPath,[string]$PathType) if ($LiteralPath -eq $script:enrollment) { return $script:enrollmentOk }; return $true }
    function Test-CloudComNoReparsePath { param([string]$Path) return $true }
function Test-CloudComRustDeskServicePath { param([string]$PathName,[string]$Exe) return $PathName -match ('(?i)^"?' + [regex]::Escape($Exe) + '"?\s+--service\s*$') }
    function Get-CimInstance { param([string]$ClassName,[string]$Filter) return $script:service }
    function Test-ApprovedPayload { return $script:payloadOk }
    function Test-PrivateRouting { return $script:routingOk }
    function Test-CloudComRustDeskFirewall { param([string]$Executable) return $script:firewallOk }
. ([scriptblock]::Create($function.Extent.Text))

Describe 'enforce-managed-host issue collection' {
    BeforeEach {
        $script:service = $null; $script:payloadOk = $true; $script:routingOk = $true
        $script:enrollmentOk = $true; $script:firewallOk = $true
    }

    It 'reports an absent host without treating it as healthy' {
        (@(Get-ManagedIssues) -contains 'host_missing') | Should Be $true
    }

    It 'refuses an unknown existing service path' {
        $script:service = [pscustomobject]@{ PathName='C:\Other\rustdesk.exe --service'; State='Running'; StartMode='Auto' }
        (@(Get-ManagedIssues) -contains 'existing_host_requires_review') | Should Be $true
    }

    It 'reports stopped or nonautomatic managed services' {
        $script:service = [pscustomobject]@{ PathName='"C:\Program Files\RustDesk\RustDesk.exe" --service'; State='Stopped'; StartMode='Manual' }
        (@(Get-ManagedIssues) -contains 'service_stopped') | Should Be $true
        (@(Get-ManagedIssues) -contains 'service_not_automatic') | Should Be $true
    }

    It 'reports a healthy managed host with no issues' {
        $script:service = [pscustomobject]@{ PathName='"C:\Program Files\RustDesk\RustDesk.exe" --service'; State='Running'; StartMode='Auto' }
        @(Get-ManagedIssues).Count | Should Be 0
    }
    It 'requires enrollment even when the service is running' {
        $script:service = [pscustomobject]@{ PathName='"C:\Program Files\RustDesk\RustDesk.exe" --service'; State='Running'; StartMode='Auto' }
        $script:enrollmentOk = $false
        @(Get-ManagedIssues).Count | Should Be 1
        (@(Get-ManagedIssues) -contains 'native_enrollment_pending') | Should Be $true
    }
    It 'reports payload and routing drift instead of a false healthy state' {
        $script:service = [pscustomobject]@{ PathName='"C:\Program Files\RustDesk\RustDesk.exe" --service'; State='Running'; StartMode='Auto' }
        $script:payloadOk = $false; $script:routingOk = $false
        (@(Get-ManagedIssues) -contains 'approved_payload_missing_or_changed') | Should Be $true
        (@(Get-ManagedIssues) -contains 'private_routing_missing_or_changed') | Should Be $true
    }
}