# Managed RustDesk viewer launch contract

The custom viewer is a complete RustDesk/Flutter bundle. Stock RustDesk cannot
acquire Breeze sign-in or native admission support from a server-settings file.
The viewer and managed target must both implement the supported admission protocol.

## Routing correction (2026-09-24)

An existing managed viewer could sign in, list its assigned computer, and obtain
a Breeze native ticket, but connection attempts reached a public RustDesk server
and returned "target device is offline or does not exist". The enrolled target
and private rendezvous/relay were available. User-profile RustDesk settings were
insufficient to establish the viewer's effective route. Launching the same exact
bundle with `RUSTDESK_APPNAME` specifying the private host, public key and relay
restored the connection; the target consumed the ticket and the user confirmed
the desktop. The native Breeze services were unchanged across the 0.116 intake.
The precise reason the unmanaged launch ignored local settings is not proven.

`scripts/cloudcom/rustdesk/launch-managed.ps1` validates a deployment-local JSON
profile and complete recorded bundle inventory, then sets the portable routing
override only in the child environment. It does not modify global environment,
RustDesk user settings, endpoint services or access grants. Missing configuration
or mismatched fingerprints abort launch. Already-open managed viewers must be
closed first, avoiding an unconfigured existing instance. Profile fingerprints
are local integrity checks, not a signed release or Authenticode substitute.

Profile schema (store outside Git):

```json
{
  "version": 1,
  "bundleDirectory": "C:\\ManagedRemote\\bundle",
  "rendezvous": "rendezvous.example.com",
  "relay": "relay.example.com",
  "publicKey": "<base64 32-byte server public key>",
  "files": {
    "rustdesk.exe": "<SHA256>",
    "librustdesk.dll": "<SHA256>",
    "data/app.so": "<SHA256>"
  }
}
```

Record every delivered bundle file, not just the three mandatory components.
Use `-ProfilePath <path> -ValidateOnly` to verify without starting the viewer.
Regression checks: `pwsh -NoProfile -File scripts/cloudcom/rustdesk/launch-managed.test.ps1`.

## Release acceptance gate

API health, successful SSO and an assigned-device list do not prove remote access.
Before accepting any Breeze, RustDesk or routing update, record the exact API
revision, viewer/target bundle hashes, server public-key fingerprint and agent
version. On the designated test endpoint, require all of:

1. Start through the managed launcher with stock RustDesk absent, then repeat on
   a test workstation with conflicting stock/public-server settings.
2. Sign in, list only assigned computers and establish a real managed desktop.
3. Verify the private transport destination and consumed native ticket; confirm
   visible frames and user input, with lease renewal beyond 60 seconds.
4. Disconnect and reconnect; revoke the assignment and confirm access terminates
   within the lease bound and a new connection is denied. Restore only the test grant.
5. Restart/update the API, repeat sign-in/connection, and check browser remote
   access still works. Preserve the matched rollback bundle and configuration.

This is a required manual acceptance procedure, not an automated transport test.
The existing portal tests cover authentication, authorization, tickets, RLS and
leases, but do not drive a real RustDesk transport. CI preservation checks likewise
do not prove connectivity. The durable product design should deliver explicit
server routing to the managed client and reject absent routing before connecting;
the launcher is the current operational correction for the existing test bundle.

## Distribution boundary

A future branded viewer installer should install a versioned, verified complete
bundle, deploy this routing profile and a managed shortcut, and preserve rollback.
Do not distribute the evidence-directory executable alone or relabel the unsigned
test bundle as a production installer. Managed endpoint deployment additionally
requires Breeze-bound enrollment and target admission enforcement. Installing a
stock internet download does not add those capabilities.
