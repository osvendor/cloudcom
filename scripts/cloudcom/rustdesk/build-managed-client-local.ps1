[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Origin,
    [ValidateSet('Test','Build')][string]$Stage = 'Test',
    [string]$BuildRoot = 'C:\CloudComNativeBuild',
    [string]$Source = 'C:\CloudComNativeBuild\managed-client',
    [string]$CargoTargetDirectory = 'C:\CloudComNativeBuild\source\rustdesk-763d4eeb05fbfe2f368a55e24a2ab7214719a926\target'
)
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne 'OS-TEST') { throw 'Run this build on OS-TEST.' }
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'https' -or !$uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $Origin -ne $uri.AbsoluteUri.TrimEnd('/')) { throw 'Canonical HTTPS origin required.' }
$logs = Join-Path $BuildRoot 'managed-client-logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$lock = [IO.File]::Open((Join-Path $logs 'build.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $completion = Join-Path $logs "$Stage-complete.json"
    if (Test-Path -LiteralPath $completion) { Remove-Item -LiteralPath $completion }
    if ($Stage -eq 'Build' -and (Test-Path -LiteralPath "$logs\bundle-manifest.json")) {
        Remove-Item -LiteralPath "$logs\bundle-manifest.json"
    }
    $vs = 'C:\Program Files\Microsoft Visual Studio\2022\Community'
    Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=amd64 -host_arch=amd64' | Out-Null
    $env:CARGO_HOME = Join-Path $BuildRoot 'cargo'
    $env:RUSTUP_HOME = Join-Path $BuildRoot 'rustup'
    $env:CARGO_BUILD_JOBS = '1'
    $env:CARGO_TARGET_DIR = $CargoTargetDirectory
    $env:VCPKG_ROOT = Join-Path $BuildRoot 'vcpkg\vcpkg-9e593bb18ea69cc5095e012465dcd675a822ed0d'
    $env:VCPKG_DEFAULT_TRIPLET = 'x64-windows-static'
    $env:VCPKG_DEFAULT_HOST_TRIPLET = 'x64-windows-static'
    $env:VCPKG_DISABLE_METRICS = '1'
    $env:PUB_CACHE = Join-Path $BuildRoot 'pub-cache'
    $env:LIBCLANG_PATH = Join-Path $BuildRoot 'tools\llvm-15.0.6\bin'
    $flutter = Join-Path $BuildRoot 'tools\flutter-3.24.5\flutter\bin'
    $rust = Join-Path $BuildRoot 'rustup\toolchains\1.75.0-x86_64-pc-windows-msvc\bin'
    $python = Join-Path $BuildRoot 'tools\python-3.11.9-embed-amd64'
    $env:PATH = "$rust;$BuildRoot\cargo\bin;$BuildRoot\tools\mingit-2.55.0.5\cmd;$python;$flutter;$env:LIBCLANG_PATH;$vs\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;$env:PATH"
    function Run([string]$Name,[string]$Executable,[string[]]$Arguments,[string]$Directory) {
        Push-Location $Directory
        try {
            "$(Get-Date -Format o) $Name" | Add-Content (Join-Path $logs 'progress.log')
            $previousPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $Executable @Arguments *> (Join-Path $logs "$Name.log")
                $code = $LASTEXITCODE
            } finally { $ErrorActionPreference = $previousPreference }
            if ($code -ne 0) { throw "$Name failed ($code); see $logs\$Name.log" }
        } finally { Pop-Location }
    }
    Run 'pub-get' "$flutter\flutter.bat" @('pub','get') "$Source\flutter"
    if ($Stage -eq 'Test') {
        Run 'dialog-test' "$flutter\flutter.bat" @('test','test/cloudcom_direct_connection_dialog_test.dart','test/cloudcom_account_page_test.dart') "$Source\flutter"
        Run 'targeted-analyze' "$flutter\flutter.bat" @('analyze','--no-fatal-infos','--no-fatal-warnings','lib/cloudcom/direct_connection_dialog.dart','lib/cloudcom/retry_connection.dart','lib/cloudcom/account_page.dart','lib/common.dart','lib/models/model.dart','lib/main.dart','lib/desktop/pages/desktop_home_page.dart','lib/desktop/pages/desktop_setting_page.dart','lib/desktop/pages/remote_tab_page.dart','lib/desktop/widgets/remote_toolbar.dart','lib/common/widgets/toolbar.dart','lib/common/widgets/setting_widgets.dart') "$Source\flutter"
    } else {
        Run 'virtual-display' "$rust\cargo.exe" @('build','--locked','--release') "$Source\libs\virtual_display\dylib"
        Run 'native' "$rust\cargo.exe" @('build','--locked','--features','hwcodec,vram,flutter,cloudcom-access','--lib','--release') $Source
        New-Item -ItemType Directory -Force "$Source\target\release\deps" | Out-Null
        Copy-Item "$CargoTargetDirectory\release\librustdesk.dll" "$Source\target\release\librustdesk.dll" -Force
        Copy-Item "$CargoTargetDirectory\release\deps\dylib_virtual_display.dll" "$Source\target\release\deps\dylib_virtual_display.dll" -Force
        Run 'flutter' "$flutter\flutter.bat" @('build','windows','--release','--dart-define=CLOUDCOM_ACCOUNT_ACCESS=true',"--dart-define=CLOUDCOM_ORIGIN=$Origin") "$Source\flutter"
        $bundle = Join-Path $Source 'flutter\build\windows\x64\runner\Release'
        Copy-Item "$Source\target\release\deps\dylib_virtual_display.dll" $bundle -Force
        $printerDownloads = Join-Path $BuildRoot 'downloads\printer'
        $printerHashes = @{
            'rustdesk_printer_driver_v4-1.4.zip' = 'c4cf4d3b48c4d9079b243edc43bb1db03b076282bc259c9f49883e9db20fa8b5'
            'printer_driver_adapter.zip' = 'e90e5d52c8807b4c6293c78a52479338715e0bf396b1b34802777b8c452e6781'
        }
        New-Item -ItemType Directory -Force $printerDownloads | Out-Null
        foreach ($name in $printerHashes.Keys) {
            $archive = Join-Path $printerDownloads $name
            if (!(Test-Path $archive)) {
                Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/rustdesk/hbb_common/releases/download/driver/$name" -OutFile $archive
            }
            if ((Get-FileHash $archive).Hash -ne $printerHashes[$name]) { throw "Printer asset checksum mismatch: $name" }
            Expand-Archive -LiteralPath $archive -DestinationPath "$BuildRoot\printer-assets" -Force
        }
        New-Item -ItemType Directory -Force "$bundle\drivers\RustDeskPrinterDriver" | Out-Null
        Copy-Item "$BuildRoot\printer-assets\rustdesk_printer_driver_v4-1.4\*" "$bundle\drivers\RustDeskPrinterDriver" -Recurse -Force
        Copy-Item "$BuildRoot\printer-assets\printer_driver_adapter.dll" $bundle -Force
        $probe = Start-Process "$bundle\rustdesk.exe" -ArgumentList '--cloudcom-managed-protocol' -WorkingDirectory $bundle -WindowStyle Hidden -RedirectStandardOutput "$logs\protocol.log" -RedirectStandardError "$logs\protocol-error.log" -Wait -PassThru
        if ($probe.ExitCode -ne 0) { throw 'Managed protocol probe failed.' }
        if ((Get-Content "$logs\protocol.log" -Raw).Trim() -ne '2') { throw 'Managed protocol check failed.' }
        [ordered]@{origin=$Origin;acceptanceMock=$false;unsigned=$true;files=@(Get-ChildItem $bundle -File -Recurse | ForEach-Object { @{path=$_.FullName.Substring($bundle.Length+1);sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash} })} | ConvertTo-Json -Depth 5 | Set-Content "$logs\bundle-manifest.json"
    }
    [ordered]@{stage=$Stage;completed=(Get-Date -Format o);source=$Source;origin=$Origin} | ConvertTo-Json | Set-Content "$logs\$Stage-complete.json"
} finally { $lock.Dispose() }
