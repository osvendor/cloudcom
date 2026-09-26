param(
    [Parameter(Mandatory)][string]$ProfilePath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$WixPath,
    [string]$Version = '1.0.1'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a three-part MSI version.' }
$launcher = Join-Path $PSScriptRoot 'launch-managed.ps1'
$validated = & $launcher -ProfilePath $ProfilePath -ValidateOnly
$profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
$bundle = Split-Path -Parent $validated.Executable
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new output directory for each build.' }
New-Item -ItemType Directory -Path $output | Out-Null
$payload = Join-Path $output 'payload'
New-Item -ItemType Directory -Path $payload | Out-Null
# Only the trusted, fingerprinted inventory is packaged; no local session/config files.
foreach ($entry in $profile.files.PSObject.Properties) {
    $dest = Join-Path $payload $entry.Name
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $bundle $entry.Name) -Destination $dest
}
# Compile a Windows GUI launcher with public routing embedded. No PowerShell or
# JSON is needed on the installed client's shortcut or launch path.
$literal = { param([string]$text) '"' + $text.Replace('\','\\').Replace('"','\"') + '"' }
$entries = foreach ($entry in $profile.files.PSObject.Properties) {
    '        { ' + (& $literal $entry.Name) + ', ' + (& $literal $entry.Value) + ' },'
}
$cs = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ManagedViewerLauncher.cs') -Raw
$cs = $cs.Replace('@@ROUTE@@', (& $literal $validated.PortableRoute)).Replace('@@FILES@@', ($entries -join "`r`n"))
$csPath = Join-Path $output 'ManagedViewerLauncher.generated.cs'
$cs | Set-Content -LiteralPath $csPath -Encoding UTF8
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $output 'viewer.ico'
$icon = [Drawing.Icon]::ExtractAssociatedIcon((Join-Path $payload 'rustdesk.exe'))
$stream = [IO.File]::Create($iconPath)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll "/win32icon:$iconPath" "/out:$payload\OSConsultantsRemote.exe" $csPath
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$check = Start-Process -FilePath "$payload\OSConsultantsRemote.exe" -ArgumentList '--verify' -WindowStyle Hidden -Wait -PassThru
if ($check.ExitCode -ne 0) { throw 'Compiled launcher payload verification failed.' }
function Escape-Xml([string]$value) { [Security.SecurityElement]::Escape($value) }
function Get-Id([string]$value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { 'I' + ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-','').Substring(0,32)) } finally { $hash.Dispose() }
}
$components = New-Object Text.StringBuilder
$refs = New-Object Text.StringBuilder
foreach ($file in Get-ChildItem -LiteralPath $payload -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($payload.Length + 1)
    $id = Get-Id $relative
    $subdir = Split-Path $relative -Parent
    $directoryAttribute = if ($subdir) { ' Subdirectory="' + (Escape-Xml $subdir) + '"' } else { '' }
    [void]$components.AppendLine('<Component Id="C' + $id + '" Guid="*" Directory="INSTALLFOLDER" Bitness="always64"' + $directoryAttribute + '><File Id="F' + $id + '" Source="' + (Escape-Xml $file.FullName) + '" KeyPath="yes" /></Component>')
    [void]$refs.AppendLine('<ComponentRef Id="C' + $id + '" />')
}
$xml = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
 <Package Name="OS Consultants - Remote Access" Manufacturer="OS Consultants" Version="$Version" UpgradeCode="4778292B-356A-40CA-AE79-C5B4B70A933F" Scope="perMachine" InstallerVersion="500">
  <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer OS Consultants - Remote Access version is already installed." />
  <MediaTemplate EmbedCab="yes" />
  <Property Id="ARPNOMODIFY" Value="1" />
  <Icon Id="ViewerIcon" SourceFile="$(Escape-Xml $iconPath)" />
  <Property Id="ARPPRODUCTICON" Value="ViewerIcon" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="OS Consultants - Remote Access" /></StandardDirectory>
  <StandardDirectory Id="ProgramMenuFolder"><Directory Id="MenuFolder" Name="OS Consultants" /></StandardDirectory>
  <StandardDirectory Id="DesktopFolder" />
  <Component Id="ViewerShortcuts" Directory="INSTALLFOLDER" Guid="*" Bitness="always64">
   <RegistryValue Root="HKLM" Key="Software\CloudCom\RemoteAccessViewer" Name="Installed" Type="integer" Value="1" KeyPath="yes" />
   <Shortcut Id="StartMenuShortcut" Directory="MenuFolder" Name="OS Consultants - Remote Access" Target="[INSTALLFOLDER]OSConsultantsRemote.exe" WorkingDirectory="INSTALLFOLDER" Icon="ViewerIcon" />
   <Shortcut Id="DesktopShortcut" Directory="DesktopFolder" Name="OS Consultants - Remote Access" Target="[INSTALLFOLDER]OSConsultantsRemote.exe" WorkingDirectory="INSTALLFOLDER" Icon="ViewerIcon" />
   <RemoveFolder Id="RemoveMenuFolder" Directory="MenuFolder" On="uninstall" />
  </Component>
  $components
  <Feature Id="Complete" Title="OS Consultants - Remote Access" Level="1"><ComponentRef Id="ViewerShortcuts" />$refs</Feature>
 </Package>
</Wix>
"@
$source = Join-Path $output 'viewer.wxs'
$xml | Set-Content -LiteralPath $source -Encoding UTF8
$msi = Join-Path $output "OS-Consultants-Remote-Access-$Version-x64.msi"
& $WixPath build $source -arch x64 -o $msi
if ($LASTEXITCODE -ne 0) { throw "WiX build failed: $LASTEXITCODE" }
Get-FileHash -LiteralPath $msi -Algorithm SHA256
