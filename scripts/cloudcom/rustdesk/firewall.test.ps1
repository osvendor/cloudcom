. "$PSScriptRoot\common.ps1"
$script:remote = 'LocalSubnet'
$script:program = 'C:\Program Files\RustDesk\RustDesk.exe'
function Get-NetFirewallApplicationFilter { param($PolicyStore,$ErrorAction) [pscustomobject]@{Program=$script:program} }
function Get-NetFirewallRule { process { [pscustomobject]@{Enabled='True';Direction='Inbound';Action='Allow';Profile='Any'} } }
function Get-NetFirewallAddressFilter { process { [pscustomobject]@{RemoteAddress=$script:remote;LocalAddress='Any'} } }
function Get-NetFirewallPortFilter { process { [pscustomobject]@{Protocol='Any';LocalPort='Any';RemotePort='Any'} } }
foreach ($scope in @('Any','LocalSubnet')) {
    $script:remote=$scope
    if (!(Test-CloudComRustDeskFirewall $script:program)) { throw "Valid scalar scope rejected: $scope" }
    $script:remote=@($scope)
    if (!(Test-CloudComRustDeskFirewall $script:program)) { throw "Valid array scope rejected: $scope" }
}
$script:remote='172.18.96.1'
if (Test-CloudComRustDeskFirewall $script:program) { throw 'Stale fixed address accepted' }
$script:remote='LocalSubnet'
if (Test-CloudComRustDeskFirewall 'C:\old-bundle\rustdesk.exe') { throw 'Wrong executable accepted' }
'PASS: scalar/array scopes, fixed-address rejection, executable matching (6 checks)'
