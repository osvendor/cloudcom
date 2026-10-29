. "$PSScriptRoot\common.ps1"
$script:remote = 'LocalSubnet'
$script:protocols = @('Any')
$script:program = 'C:\Program Files\RustDesk\RustDesk.exe'
function Get-NetFirewallApplicationFilter { param($PolicyStore,$ErrorAction) [pscustomobject]@{Program=$script:program} }
function Get-NetFirewallRule { process { foreach ($protocol in $script:protocols) { [pscustomobject]@{Enabled='True';Direction='Inbound';Action='Allow';Profile='Any';Transport=$protocol} } } }
function Get-NetFirewallAddressFilter { process { [pscustomobject]@{RemoteAddress=$script:remote;LocalAddress='Any'} } }
function Get-NetFirewallPortFilter { process { [pscustomobject]@{Protocol=$_.Transport;LocalPort='Any';RemotePort='Any'} } }
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
$script:protocols=@('TCP')
if (Test-CloudComRustDeskFirewall $script:program) { throw 'TCP-only rule accepted without UDP' }
$script:protocols=@('UDP')
if (Test-CloudComRustDeskFirewall $script:program) { throw 'UDP-only rule accepted without TCP' }
$script:protocols=@('TCP','UDP')
if (!(Test-CloudComRustDeskFirewall $script:program)) { throw 'Separate TCP and UDP rules rejected' }
$script:protocols=@('6','17')
if (!(Test-CloudComRustDeskFirewall $script:program)) { throw 'Numeric TCP and UDP rules rejected' }
'PASS: scopes, fixed-address rejection, executable matching, and both transport protocols (10 checks)'
