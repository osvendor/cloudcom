# Pester 5. Run on OS-TEST; all endpoint mutations/native calls are mocked.
BeforeAll {
    # PowerShell on Linux has no Windows service cmdlets; declaration-only stubs make
    # Pester's mocks portable. A real call is an explicit test failure.
    foreach ($command in @('Set-Service','Start-Service','Restart-Service','Get-Service')) {
        if (!(Get-Command $command -ErrorAction SilentlyContinue)) {
            Set-Item -Path "Function:$command" -Value { param($Name,$StartupType,[switch]$Force) throw 'Unmocked Windows service command.' }
        }
    }
    if (!(Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
        function Get-CimInstance { param($ClassName,$Filter) throw 'Unmocked CIM query' }
    }
    . "$PSScriptRoot\common.ps1"
    $source = Get-Content "$PSScriptRoot\repair.ps1" -Raw
    $source = $source.Replace('. "$PSScriptRoot\common.ps1"','')
    $source = $source.Replace('Global\CloudComRustDeskDesiredState','Local\CloudComRustDeskDesiredStateTests')
    $script:repair = [scriptblock]::Create($source)
    $script:arguments = @{
        AllowedComputerName='test-only'; ConfigurationPath='test-config'; RendezvousServer='id.example.com'
        RelayServer='relay.example.com'; PublicKey='test-public-key'; InstallerUrl='https://example.com/installer.exe'
        InstallerSha256=('a'*64)
    }
}
Describe 'RustDesk desired-state repair mutation boundaries' {
    BeforeEach {
        $script:calls=0
        $script:first=[pscustomobject]@{Healthy=$false;Issues=@('service_stopped');Exe='test-exe';Directory='test-dir';Credential='test-credential';Version=[version]'1.4.9';Service=$null}
        $script:after=[pscustomobject]@{Healthy=$true;Issues=@();Exe='test-exe';Directory='test-dir';Credential='test-credential';Version=[version]'1.4.9';Service=$null}
        Mock Assert-CloudComTarget {}
        Mock Get-CloudComRustDeskState { $script:calls++; if($script:calls -eq 1){$script:first}else{$script:after} }
        Mock Test-Path { $LiteralPath -in @('test-exe','test-credential') }
        Mock Test-CloudComPrivatePath { $true }
        Mock Set-CloudComPrivateDirectory {}
        Mock Set-CloudComRustDeskQuietMode {}
        Mock Set-Content {}
        Mock Remove-Item {}
        Mock Set-Service {}
        Mock Start-Service {}
        Mock Restart-Service {}
        Mock Get-Service { [pscustomobject]@{Status='Stopped'} }
        Mock Get-CimInstance { [pscustomobject]@{State='Running';StartMode='Auto';PathName='test-exe --service'} }
        Mock Start-Sleep {}
        Mock Write-CloudComRustDeskId {}
        Mock Invoke-CloudComRustDesk {}
        Mock Invoke-WebRequest { throw 'Unexpected download' }
    }
    It 'healthy device performs no mutation or password command' {
        $script:first=$script:after
        & $script:repair @script:arguments
        Should -Invoke Set-Service -Times 0
        Should -Invoke Set-Content -Times 0
        Should -Invoke Invoke-CloudComRustDesk -Times 0
        Should -Invoke Restart-Service -Times 0
    }
    It 'stopped service starts without restart or password/config command' {
        & $script:repair @script:arguments
        Should -Invoke Start-Service -Times 1
        Should -Invoke Restart-Service -Times 0
        Should -Invoke Invoke-CloudComRustDesk -Times 0
    }
    It 'configuration drift applies config once and restarts without password command' {
        $script:first.Issues=@('configuration_drift')
        & $script:repair @script:arguments
        Should -Invoke Invoke-CloudComRustDesk -Times 1 -ParameterFilter { $Arguments[0] -eq '--config' }
        Should -Invoke Invoke-CloudComRustDesk -Times 0 -ParameterFilter { $Arguments[0] -eq '--password' }
        Should -Invoke Restart-Service -Times 1
    }
    It 'unknown existing version refuses mutation' {
        $script:first.Version=[version]'1.5.0'
        { & $script:repair @script:arguments } | Should -Throw
        Should -Invoke Set-Content -Times 0
        Should -Invoke Invoke-CloudComRustDesk -Times 0
    }
    It 'quiet drift applies the quiet profile without resetting credentials or restarting the service' {
        $script:first.Issues=@('quiet_mode_drift')
        Mock Get-Service { [pscustomobject]@{Status='Running'} }
        & $script:repair @script:arguments
        Should -Invoke Set-CloudComRustDeskQuietMode -Times 1
        Should -Invoke Invoke-CloudComRustDesk -Times 0
        Should -Invoke Restart-Service -Times 0
        Should -Invoke Set-Service -Times 0
    }
    It 'repairs a nonautomatic service startup mode' {
        $script:first.Issues=@('service_not_automatic')
        Mock Get-CimInstance { [pscustomobject]@{State='Running';StartMode='Manual'} }
        & $script:repair @script:arguments
        Should -Invoke Set-Service -Times 1 -ParameterFilter { $StartupType -eq 'Automatic' }
    }
    It 'interrupted provisioning refuses another mutation' {
        $script:first.Issues=@('provisioning_requires_review')
        { & $script:repair @script:arguments } | Should -Throw
        Should -Invoke Set-Content -Times 0
        Should -Invoke Invoke-CloudComRustDesk -Times 0
    }
    It 'attempt ceiling refuses another repair' {
        Mock Test-Path { $true }
        Mock Get-Content { '{"attempts":3,"lastAttempt":"2020-01-01T00:00:00Z"}' }
        { & $script:repair @script:arguments } | Should -Throw
        Should -Invoke Set-Content -Times 0
        Should -Invoke Invoke-CloudComRustDesk -Times 0
    }
    It 'missing installation restores the existing credential exactly once without rotation' {
        $script:first.Issues=@('installation_missing','service_missing','configuration_drift')
        $script:first.Version=$null
        $script:exeChecks=0
        Mock Test-Path {
            if($LiteralPath -eq 'test-exe') { $script:exeChecks++; return $script:exeChecks -gt 1 }
            return $LiteralPath -eq 'test-credential'
        }
        Mock Get-Item { [pscustomobject]@{VersionInfo=[pscustomobject]@{ProductVersion='1.4.9+67'}} }
        Mock Get-FileHash { [pscustomobject]@{Hash=('a'*64)} }
        Mock Invoke-WebRequest {}
        Mock Get-Content { 'mock-protected-credential' }
        Mock ConvertTo-SecureString {
            $value=New-Object Security.SecureString
            foreach($character in 'test-existing-secret'.ToCharArray()){ $value.AppendChar($character) }
            return $value
        }
        & $script:repair @script:arguments
        Should -Invoke Invoke-CloudComRustDesk -Times 1 -ParameterFilter { $Arguments[0] -eq '--password' -and $Arguments[1] -eq 'test-existing-secret' }
        Should -Invoke Invoke-CloudComRustDesk -Times 1 -ParameterFilter { $Arguments[0] -eq '--silent-install' }
        Should -Invoke Set-Content -Times 0 -ParameterFilter { $LiteralPath -eq 'test-credential' -or $LiteralPath -like '*credential-pending*' }
        Should -Invoke Restart-Service -Times 0
        Should -Invoke Set-Service -Times 0
    }
}

Describe 'Private staging tree trust boundaries' {
    BeforeAll {
        if (!(Get-Command Get-Acl -ErrorAction SilentlyContinue)) { function Get-Acl { param($LiteralPath) throw 'Unmocked ACL read' } }
    }
    BeforeEach {
        $script:savedProgramData = $env:ProgramData
        $env:ProgramData = Join-Path $TestDrive 'ProgramData'
        $script:parentPath = Join-Path $env:ProgramData 'CloudCom'
        $script:leafPath = Join-Path $script:parentPath 'RustDeskDeployment'
        $script:badOwnerPath = ''
        $script:junctionPath = ''
        Mock Test-Path { $true }
        Mock Get-Item { [pscustomobject]@{ Attributes = $(if ($LiteralPath -eq $script:junctionPath) { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]::Directory }) } }
        Mock Get-Acl {
            $acl = [pscustomobject]@{ Access=@(); OwnerSid=$(if ($LiteralPath -eq $script:badOwnerPath) { 'S-1-5-21-123-456-789-1001' } else { 'S-1-5-18' }) }
            $acl | Add-Member ScriptMethod GetOwner { param($type) [pscustomobject]@{Value=$this.OwnerSid} }
            return $acl
        }
    }
    AfterEach { $env:ProgramData = $script:savedProgramData }
    It 'rejects a user-owned leaf even with an apparently private DACL' {
        $script:badOwnerPath=$script:leafPath
        Test-CloudComPrivatePath $script:leafPath | Should -BeFalse
    }
    It 'rejects a trusted leaf below a parent junction' {
        $script:junctionPath=$script:parentPath
        Test-CloudComPrivatePath $script:leafPath | Should -BeFalse
    }
    It 'rejects a trusted leaf below a user-owned parent' {
        $script:badOwnerPath=$script:parentPath
        Test-CloudComPrivatePath $script:leafPath | Should -BeFalse
    }
    It 'accepts a trusted private chain rooted in ProgramData' {
        Test-CloudComPrivatePath $script:leafPath | Should -BeTrue
    }
}

Describe 'Quiet mode process boundaries' {
    It 'selects only the exact installed tray process' {
        $exe='C:\Program Files\RustDesk\rustdesk.exe'
        $p=[pscustomobject]@{ExecutablePath=$exe;CommandLine=('"'+$exe+'" --tray')}
        Test-CloudComRustDeskTrayProcess $p $exe | Should -BeTrue
        foreach($arg in @('--service','--server','--cm','--tray --server','')) {
            $p.CommandLine='"'+$exe+'" '+$arg
            Test-CloudComRustDeskTrayProcess $p $exe | Should -BeFalse
        }
        $p.CommandLine='"'+$exe+'" --tray';$p.ExecutablePath='C:\Other\rustdesk.exe'
        Test-CloudComRustDeskTrayProcess $p $exe | Should -BeFalse
    }
    It 'refuses redirected shortcut paths' {
        Mock Test-Path { $true }
        Mock Get-Item { [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint} }
        Test-CloudComNoReparsePath (Join-Path $TestDrive 'RustDesk.lnk') | Should -BeFalse
    }
}

Describe 'Quiet mode termination safety' {
    BeforeAll {
        if (!(Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
            function Get-CimInstance { param($ClassName,$Filter) throw 'Unmocked CIM query' }
        }
    }
    BeforeEach {
        $script:tray=[pscustomobject]@{ExecutablePath='C:\Program Files\RustDesk\rustdesk.exe';CommandLine='"C:\Program Files\RustDesk\rustdesk.exe" --tray';ProcessId=42;CreationDate='original'}
        Mock Get-CloudComRustDeskQuietState { [pscustomobject]@{Shortcuts=@();TrayProcesses=@($script:tray)} }
        Mock Stop-Process {}
    }
    It 'does not terminate a PID reused by the service' {
        Mock Get-CimInstance { [pscustomobject]@{ExecutablePath=$script:tray.ExecutablePath;CommandLine='"C:\Program Files\RustDesk\rustdesk.exe" --service';ProcessId=42;CreationDate='new'} }
        Set-CloudComRustDeskQuietMode $script:tray.ExecutablePath
        Should -Invoke Stop-Process -Times 0
    }
    It 'terminates only the revalidated tray instance' {
        Mock Get-CimInstance { $script:tray }
        Set-CloudComRustDeskQuietMode $script:tray.ExecutablePath
        Should -Invoke Stop-Process -Times 1 -ParameterFilter { $Id -eq 42 }
    }
}

Describe 'Final service identity' {
    It 'rejects the vendor temporary import service and accepts only its final service' {
        $exe='C:\Program Files\RustDesk\rustdesk.exe'
        Test-CloudComRustDeskServicePath ('"'+$exe+'" --service') $exe | Should -BeTrue
        Test-CloudComRustDeskServicePath ('"'+$exe+'" --import-config file') $exe | Should -BeFalse
        Test-CloudComRustDeskServicePath ('"'+$exe+'" --server') $exe | Should -BeFalse
    }
}
