param(
    [Parameter(Mandatory)][string]$AllowedComputerName,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$LibrarySha256
)
. "$PSScriptRoot\common.ps1"
Assert-CloudComTarget $AllowedComputerName
# Native enrollment replaces the legacy password-credential requirement.
$issues=New-Object 'Collections.Generic.List[string]'
$exe=Join-Path $env:ProgramFiles 'RustDesk\RustDesk.exe'
$library=Join-Path (Split-Path $exe) 'librustdesk.dll'
$service=Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
if(!$service){$issues.Add('service_missing')}
elseif(!(Test-CloudComRustDeskServicePath $service.PathName $exe)){$issues.Add('service_path_unexpected')}
else {
    if($service.State -ne 'Running'){$issues.Add('service_stopped')}
    if($service.StartMode -ne 'Auto'){$issues.Add('service_not_automatic')}
}
foreach($entry in @(@{Path=$exe;Hash=$ExecutableSha256},@{Path=$library;Hash=$LibrarySha256})) {
    if(!(Test-Path -LiteralPath $entry.Path -PathType Leaf) -or !(Test-CloudComNoReparsePath $entry.Path)){$issues.Add('native_payload_missing')}
    elseif((Get-FileHash -LiteralPath $entry.Path).Hash -ne $entry.Hash){$issues.Add('native_payload_changed')}
}
$enrollment=Join-Path $env:ProgramData 'Breeze\data\rustdesk\native-admission.dpapi'
if(!(Test-Path -LiteralPath $enrollment -PathType Leaf)){$issues.Add('native_enrollment_missing')}
if(!(Get-Printer -Name 'RustDesk Printer' -ErrorAction SilentlyContinue)){$issues.Add('printer_missing')}
if(!(Get-PrinterDriver -Name 'RustDesk v4 Printer Driver' -ErrorAction SilentlyContinue)){$issues.Add('printer_driver_missing')}
$state=if($issues.Count){'breach'}else{'ok'}
$detail=if($issues.Count){$issues -join ', '}else{'Managed RustDesk target and printer verified.'}
Write-Output ('::breeze:monitor:: '+(@{state=$state;detail=$detail}|ConvertTo-Json -Compress))
if(!$issues.Count){Write-CloudComRustDeskId $exe}
exit 0
