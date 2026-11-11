# RustDesk desired-state scripts

## Current Breeze-only host enforcement

Use `enforce-managed-host.ps1` for the custom unattended host. The older
`probe.ps1` / `repair.ps1` password-based workflow documented below is legacy
and must not be substituted for the Breeze-only host.

The current script has Probe and Repair modes. It pins the MSI and installed
EXE/DLL hashes for approved host 1.5.0.68, verifies the local Breeze organization,
and checks private routing, automatic service startup, native enrollment, and
application-bound firewall rules. The custom host requires Breeze native session
admission; this workflow creates no shared RustDesk password. The Breeze agent
performs its own enrollment, normally within ten minutes.

Repair installs an absent host silently without requesting a reboot. Unknown,
modified, or different existing payloads require review rather than automatic
replacement. Failures have a fifteen-minute cooldown and three-attempt ceiling.
Review the protected ProgramData/CloudCom/ManagedHostEnforcement journal before
resetting attempts. A healthy probe does not prove an interactive desktop session.

Deploy through a native Script Monitor with a fifteen-minute interval and a
run-script repair response. Start with a device pilot, then assign the policy
at organization level with a Windows filter to cover future enrollments. Keep
organization and server values in private deployment records. For saved scripts,
bundle the required common.ps1 functions after the parameter block.

The API serves immutable versioned MSIs at
`/api/v1/agents/download/rustdesk/windows/amd64/msi/1.5.0.68` (and the separately
reviewed `/msi/1.5.0.69` canary). Stage the currently pinned MSI in the persistent
`CLOUDCOM_RUSTDESK_HOST_DIR` as `cloudcom-rustdesk-host.msi`; it contains no device
enrollment secrets. Preserve this directory across agent binary promotions.
Changing the approved host requires a reviewed hash update and another pilot.
Disable the monitor/policy assignment to stop enforcement; do not delete native
enrollment identities or uninstall hosts as an automatic rollback.

`enforce-managed-host.Tests.ps1` tests probe behavior without executing Repair.

## Legacy password-based host workflow

These Windows PowerShell 5.1-compatible scripts use native Breeze Script Monitors and run as SYSTEM. They do not alter the Breeze MSI, agent, database, or application. The quiet profile is the default and has been validated on one Windows canary; do not infer fleet approval from this single-canary result. Configuration and credentials belong in private deployment records, never this directory.

`probe.ps1` detects installation/version, service running and Automatic, service executable path, configured rendezvous/relay/public key, and protected SYSTEM-DPAPI credential presence/readability. It emits Breeze's explicit monitor marker and exits zero for a completed noncompliant check. It does not establish a remote connection or prove that RustDesk currently accepts the stored password.

`repair.ps1` installs only when missing, from an explicitly supplied HTTPS artifact and SHA256. An existing version different from the approved version is not upgraded/downgraded by remediation. An existing healthy newer version is left untouched. Unmanaged existing installations require explicit adoption. Password generation occurs only when no managed credential exists; existing credentials are never reapplied or rotated during routine repair. Optional RSA XML recovery produces encrypted ciphertext only. Repair uses a global mutex, a 15-minute failure cooldown and three-attempt default limit. The final service check waits for Running and the expected service identity, changes startup type to Automatic only when needed, and avoids a redundant restart after a fresh install. Successful repair removes its counter. Review a failed repair before manually resetting its protected journal.

Supply the exact canary computer name, effective SYSTEM RustDesk2.toml path, approved server/key, and installer URL/hash through native script parameters. The current stock Windows service config commonly resides under the LocalService profile even when its service runs as LocalSystem; verify the actual endpoint path. Scope the configuration policy to one device first. Do not broaden assignments until acceptance passes. Do not enable unattended scheduled adoption by default.

Both entrypoints load `common.ps1` from their directory. For Breeze's single-body script editor, retain the entrypoint's `param(...)` first, replace its `. "$PSScriptRoot\common.ps1"` line with the complete common.ps1 content, and upload the resulting body. Use saved native parameters rather than string interpolation of credential or infrastructure values.

Run `./test-contract.ps1` for non-mutating parser and contract checks. `repair.Tests.ps1` adds eighteen Pester 5 mutation-boundary tests; these passed with PowerShell 7.6.6/Pester 5.7.1 on the Linux test VM, and CloudCom CI run 35670867442 passed. The Windows canary passed quiet cleanup, automatic scheduled repair after a missing-install event, controlled relay-drift repair, credential preservation, post-repair remote reconnect, and the post-reboot quiet check/reconnect. Generate single-body uploads with `build-upload.ps1 -OutputDirectory <private-staging-directory>`. Keep this to one canary: first-ever credential provisioning is not live tested, and multiuser access, browser access, and user assignment are separate acceptance work. Stop active test sessions before intentional drift tests: actual configuration repair may restart RustDesk.

Limitations: inventory compliance alone is delayed and does not verify service/config health. Configuration-policy compliance software-deploy remediation is not implemented upstream; Script Monitor run-script responses are used instead. Credential checks verify protected storage, not the actual RustDesk password. A password-set command failure leaves `credential-pending.dpapi` for manual recovery and must not be retried by deleting that file blindly. Windows command arguments briefly expose the password to privileged process inspection during initial provisioning. The implementation accepts three expected TOML option lines, not a complete TOML parser; unusual TOML syntax requires manual review; duplicate expected keys or options sections fail the probe. Repair emits RustDesk ID custom-field writeback, including its healthy no-op path. Configure the org-scoped rustdesk_id field to permit script writes.

Upstream updates: preserve this isolated directory and revalidate native script parameters, monitor markers, response dispatch, SYSTEM execution, and stock RustDesk CLI/config/DPAPI conventions. No conflict-free merge guarantees runtime compatibility. To roll back policy behavior, disable its monitor response/assignment; do not uninstall endpoints or delete stored credentials automatically.

## Quiet unattended default

The managed profile defaults to silent EXE installation, no shared desktop/Start menu shortcuts, and no tray autostart. Stock EXE installation briefly creates shortcuts; remediation removes only the four known vendor `.lnk` files after checking the installed executable target and expected arguments. No directories or user-created connection shortcuts are recursively removed. The monitor detects restored shortcuts or a running tray and the response reapplies this profile.

The stock OSS client does not expose `hide-tray` as an ordinary TOML option. This profile suppresses its common Startup shortcut and terminates only a verified installed `--tray` process, rechecking process identity before termination. It does not terminate the service, server, main application, or active-session connection manager. Opening the main application can respawn the tray until the next successful policy repair. Active-session UI remains visible. A shortcut can exist briefly during installation before cleanup. Reboot/unattended connection acceptance passed on the Windows canary; do not describe this as a permanently invisible custom client.

No Breeze MSI/core changes are required. Preserve the quiet-state probe and remediation hooks on upstream imports and revalidate vendor shortcut/CLI behavior on RustDesk upgrades. Removing this policy stops enforcement; reinstalling/repairing the vendor package restores its normal shortcuts. Credentials must be preserved during rollback.

### Direct UDP server prerequisite

Endpoint health alone does not establish direct connectivity. The custom hbbs
UDP compatibility feature was originally restricted to one pilot RustDesk ID by
`CLOUDCOM_UDP_TARGETS`. An enrolled, healthy host outside that list can still fail
direct connections while the pilot works from the same viewer.

`server-udp-fleet.patch` adds an explicit `CLOUDCOM_UDP_TARGETS=*` mode to that
custom server module. Empty configuration remains disabled; exact-ID lists retain
their canary behavior. The change does not bypass the rendezvous key, TCP admission,
request correlation, rate/capacity bounds, replay checks, or Breeze host admission.
Build and validate the server patch before using the wildcard; the older binary
treats `*` as a literal ID and will not enable fleet support. Test disabled, exact-ID,
fleet, and newly introduced target IDs in isolated wire tests before promotion.

Rollout acceptance must cover server transport configuration plus actual desktop
connectivity, separately from the endpoint installation/enrollment health probe.
Keep the prior server binary and compose configuration for rollback. A running
listener or healthy endpoint probe alone is not a successful remote session.

### Diagnosing direct-to-relay reports

Treat installation, authorization, and transport as separate checks. Confirm a
native target is enrolled before changing transport settings. A missing host is
handled by the existing organization-bound policy; never copy another host's ID
or enrollment files.

The managed firewall check requires effective, executable-bound inbound coverage
for **both TCP and UDP**, either an Any-protocol rule or separate protocol rules.
A TCP-only rule must not suppress UDP repair. Preserve firewall enforcement,
private rendezvous routing, and native admission checks.

On a failed direct attempt, capture the viewer's effective `udp_enabled` and
`forced_relay` values and the selected target ID before restarting anything.
Inspect the configuration in the real interactive user's context: packaged tools
can see a virtualized profile that differs from a normal desktop/browser launch.
Confirm server fleet eligibility separately. A remembered hostname, URL, or a
healthy installation check is insufficient evidence that the same native peer ID
and transport mode were used. Never log admission tokens or credentials.

A relay success proves an authorized working fallback, not a direct path. Accept
a direct repair only after a fresh direct session records successful transport
and desktop frames. Some NAT/firewall combinations legitimately require relay;
do not bypass authorization or indiscriminately open network ports to avoid it.
A TCP-derived `SYMMETRIC` NAT classification can also explain an immediate relay
choice even with UDP enabled. Capture the controlled host's classification and
native NAT-test log as well as the viewer's. Do not overwrite the classification
with a false value. A managed UDP implementation should test the requested UDP
path within its existing concurrency/deadline bounds before deciding that a TCP
mapping classification makes it unusable. Explicit relay/proxy policy and native
session admission must retain priority. Validate a native change in the Windows
endpoint VM and promote it as a new pinned host artifact; changing a policy hash
alone is not a valid native release.

### Reviewed host upgrades

The desired-state probe accepts complete approved 68 and reviewed 69 EXE/DLL
pairs. This allowance does not upgrade healthy 68 installations or permit stock
RustDesk adoption. A separate promotion operator prepares 69 for new installs; live saved scripts remain
at version 2 with installer 68 until the audited promotion is applied. Previously
queued scripts must continue receiving their pinned bytes.
Versioned download paths end in `/msi/1.5.0.68` and `/msi/1.5.0.69`, separate from
the existing stable `/msi` route. Never overwrite a versioned artifact.

`upgrade-managed-host.ps1` is the separate, explicit 68-to-69 MSI operation.
It requires SYSTEM, an exact computer and organization, the approved installed
68 hashes and MSI ownership, a pinned new MSI and an approved 68 rollback MSI.
It preserves the native ID/key, protected enrollment and private routing. MSI
timeouts or a busy Windows Installer stop further installation attempts and
leave a protected review journal; they must not trigger a concurrent rollback.
Completed but failed upgrades can restore only the verified 68 package and the
existing identity. Validate upgrade, rollback and re-upgrade in OS-TEST before
dispatching a release to endpoint canaries. The fourth MSI version component
does not provide downgrade protection; the exact payload guards are essential.
