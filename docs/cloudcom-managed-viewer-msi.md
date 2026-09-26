# Managed viewer MSI

This installer packages the existing custom managed RustDesk viewer, not the
public RustDesk client or the endpoint service. It installs per-machine in
`Program Files\OS Consultants - Remote Access`, with desktop and Start menu shortcuts
directly targeting `OSConsultantsRemote.exe` without arguments. Installed Apps supports
uninstall; `msiexec /fa` supports repair. No custom installer actions, services,
global environment changes or RustDesk configuration edits are used.

The small .NET Framework Windows launcher embeds the validated public server
route/key and payload SHA-256 inventory. It verifies the complete delivered
inventory before starting the managed viewer with child-only RUSTDESK_APPNAME.
The install contains no profile JSON, PowerShell launcher, user credentials or
session tokens. Existing per-user RustDesk state is deliberately retained on
uninstall because another RustDesk installation may share it. Sign out before
uninstalling when removing access from a workstation.

Build on the Windows test/build VM using its existing WiX toolchain and .NET
Framework C# compiler:

```powershell
.\scripts\cloudcom\rustdesk\build-viewer-msi.ps1 `
  -ProfilePath C:\private-build-input\profile.json `
  -OutputDirectory C:\build\viewer-1.0.1 `
  -WixPath C:\tools\wix\wix.exe -Version 1.0.1
```

The input profile is the same verified profile used by launch-managed.ps1;
bundleDirectory must point at the build machine's source bundle. Only its
fingerprinted inventory is copied. Keep deployment-specific profiles outside Git.
Output directory must be new. Preserve the emitted MSI and SHA-256 as an immutable
artifact. Use a new three-part version for each release. Same-version replacement
is also enabled to prevent duplicate Installed Apps entries during testing.

The MSI and custom binaries are unsigned. Packaging does not provide publisher
identity or inherit upstream signing. Current scope is Windows x64 with the
Windows .NET Framework runtime. Server availability, Breeze sign-in and device
assignments are still required.

Acceptance: install; check shortcut TargetPath/Arguments; run installed
OSConsultantsRemote.exe --verify; connect, exit completely, reopen and reconnect;
repair; same-version replacement; uninstall; check removal and existing endpoint
service preservation. Keep MSI logs. Closing a window can leave a tray process:
the launcher currently reports that the viewer is already open in that case.
Do not confuse payload verification with successful remote desktop acceptance.

For the manual-relay client, build the current native checkout on OS-TEST with
`scripts/cloudcom/rustdesk/build-managed-client-local.ps1 -Stage Test` and then
`-Stage Build`, supplying the canonical HTTPS `-Origin`. The build requires the
existing pinned Windows toolchain and checks managed protocol version 2. Use
its new bundle-manifest.json to construct the packaging profile inventory;
never reuse an older bundle simply because its launcher profile validates.
Transport acceptance is separate: default direct attempt must open no relay
transport, an explicit relay retry must obtain fresh admission, and a new
connection must return to direct mode. Server signaling still uses a small
amount of server traffic even for direct desktop sessions.
Remote printing uses RustDesk's existing protocol and incoming-print controls.
The managed main window exposes Printer settings without exposing stock account
or connection controls. The bundle includes the upstream printer adapter and
virtual-printer driver files with pinned hashes, covered by the launcher inventory.
Receiving a print job on the viewer uses a locally installed Windows printer;
the MSI does not register a virtual printer or change the local default printer.
The controlled Windows endpoint must separately have RustDesk Printer installed
and enable-remote-printer allowed. Print to RustDesk Printer in the remote app,
then choose the receiving printer in the viewer. End-to-end printer output is an
additional acceptance check; bundled driver files alone do not establish success.