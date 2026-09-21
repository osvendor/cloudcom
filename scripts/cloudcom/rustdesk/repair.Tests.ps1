# Pester 5. Run on OS-TEST; all endpoint mutations/native calls are mocked.
BeforeAll {
    # PowerShell on Linux has no Windows service cmdlets; declaration-only stubs make
    # Pester's mocks portable. A real call is an explicit test failure.
    foreach ($command in @('Set-Service','Start-Service','Restart-Service','Get-Service')) {
        if (!(Get-Command $command -ErrorAction SilentlyContinue)) {
            Set-Item -Path "Function:$command" -Value { param($Name,$StartupType,[switch]$Force) throw 'Unmocked Windows service command.' }
        }
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
        Mock Set-Content {}
        Mock Remove-Item {}
        Mock Set-Service {}
        Mock Start-Service {}
        Mock Restart-Service {}
        Mock Get-Service { [pscustomobject]@{Status='Stopped'} }
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
        Should -Invoke Restart-Service -Times 1
    }
}
