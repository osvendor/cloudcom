# RustDesk Access: account authorization and connection handoff

## Status and intended experience

Development design and executable authorization contract, not a deployed feature.
The user wants an installed RustDesk client: sign in with a Breeze account, list
only explicitly approved devices, then connect without entering a device password.
Configuration belongs in a separate **Extensions → RustDesk Access** page. Keep the
existing device-page Connect action as the technician entry point. The Cloud Command
extension and its 3CX code are owned by concurrent work and must not be modified.

The current server-qualified native URL correction only fixes routing. It neither
authorizes a user nor supplies an unattended password. Do not replace it with a
password-bearing URL, command line, or shared partner password.

## Audited capability limits

The source snapshots reviewed were CortenDesk `5d5470f6fd9295772ddcfdfe02c161e0d42ed87b`,
the previously reviewed CortenDesk Server fork `c488716388656e907b1983d22c2957683c5e0fa2`,
RustDesk Server OSS 1.1.16, and RustDesk client `763d4eeb05fbfe2f368a55e24a2ab7214719a926`.
The latter identifies itself as 1.5.0; it is NOT byte-identical source for the
installed 1.4.9 binary. Pin the exact production client source/build before patching
or claiming native compatibility. No remote source or running server was updated.

Observed in the audited trees:

- CortenDesk `app/Providers/AppServiceProvider.php` authenticates HTTP client tokens.
  `app/Http/Controllers/Api/GroupTabController.php` uses `Device::visibleTo` for peer
  listing. `app/Models/User.php::revokeAllAccess` deletes HTTP tokens.
- CortenDesk Server `src/rendezvous_server.rs::handle_punch_hole_request` checks the
  server key and looks up the target by ID. This path does not authorize a Breeze
  account or consult the CortenDesk device-list ACL. The stock relay pairs peers by
  session UUID; that is not a user/device grant.
- CortenDesk's browser client derives a reusable credential from password+salt,
  stores it in browser local storage when requested, and computes the endpoint's
  challenge response on reconnect. This is saved device authentication, not a
  single-use account approval. Treat the saved hash as a password-equivalent secret.
- The client source's `--password` handoff becomes a URL argument. Its temporary
  password is reusable and is not consumed after successful authentication.

Consequently, listing only assigned devices cannot prevent direct-ID access with
an existing password. Removing a console assignment or token alone cannot revoke
that credential or end an established peer-to-peer connection.

## Required enforcement boundary

The modified **target client** must reject a new remote connection until Breeze
authorizes that exact user, target, and session. A desktop-only wrapper, changed
menu, or rendezvous-only check is insufficient: direct/P2P connections must obey
the same rule. Only the managed mode gets this behavior; do not silently claim that
stock RustDesk connections are protected by it.

In enforced mode:

1. The target is enrolled with a unique device identity and pinned Breeze trust
   root. Enrollment is bound to the authenticated Breeze agent, not a caller's
   supplied device ID. Support authenticated identity rotation and revocation.
2. The operator client signs in through the system browser using a short-lived
   authorization code and PKCE. It does not receive the user's Breeze password.
   Codes are one-use, redirect-bound, client-bound, and must not carry device secrets.
3. The extension checks current account status, session, organization/site scope,
   remote-access permission, applicable MFA policy, device state, and an explicit
   unexpired assignment. Administrative membership is not an implicit assignment.
4. Issue a short-lived single-use connection authorization bound to actor, target
   identity, organization, purpose, operator ephemeral key, grant version, audience,
   protocol version, and session nonce. Transfer it over authenticated HTTPS/native
   IPC or the encrypted handshake, never an OS-launch URL or command-line argument.
5. The target authenticates to Breeze and atomically redeems the authorization.
   Verify the operator's proof of possession and bind it to the target's fresh
   connection challenge/handshake transcript. Re-read current authorization inside
   the redemption transaction; reject reuse, expiry, moved devices, revoked grants,
   disabled accounts, stale sessions, mismatched keys and unknown protocol versions.
6. In managed mode the target denies legacy password-only and interactive-click
   fallback, alternative-server connections, and direct-ID attempts without a valid
   approval. A recovery mechanism must be separately designed, audited and bounded;
   it must not silently become an always-valid back door.
7. Active sessions have a short renewable authorization lease. Revocation ends
   control, clipboard, files, audio and any terminal channels within the stated
   lease bound. A network/authorization outage fails closed after the lease expires.

This replaces ordinary password handoff for account-enforced sessions. A legacy
unattended password may remain a separately controlled migration/recovery concern;
it must not be released to normal clients or accepted as an enforced-mode bypass.

## Extension boundaries and data ownership

Reserve package `packages/ext-rustdesk-access`, extension identity `rustdeskaccess`,
route namespace `/rustdesk-access`, and custom element prefix `rustdesk-access-`.
Do not reuse `cloudcommand`, its migrations, its data, or its settings.

Extension-owned schema should include tenant configuration, endpoint enrollment,
user/device grants, expiring connection authorizations, and session leases. Bind
every record to org/device/user identities with composite constraints where
applicable. Enable AND force RLS from the first migration. Tenant export excludes
credentials, enrollment secrets, authorization hashes and signing material.
Device moves and deletion must revoke outstanding grants/authorizations/sessions;
do not merely update a denormalized org ID and preserve access accidentally.

Keep private signing/enrollment material in the existing encrypted secret facility
with organization/device/column binding. Never expose raw secrets in extension
settings, audit events, exceptions, query logs, support exports, or AI context.
Use separate read/configure/assign/connect/revoke permission checks and live host
permission resolution. `mfaSatisfied` means the host's MFA POLICY is satisfied; it
does not prove a fresh second factor. A fresh-factor gate needs an explicit host
capability before relying on it.

The host changes should be bounded to static extension registration, authenticated
extension-host requests, build packaging, and the connection adapter hook. Reuse
the concurrent extension's shared host API once committed and reviewed; do not copy
unstable private authentication code or overwrite its shared registry changes.

## Implementation and acceptance gates

1. **Current checkpoint:** source audit, separate package, tested pure eligibility
   policy. No live feature, credential store, database migration, or client patch.
2. Pin client/server builds and implement a canary target + operator protocol proof.
   Prove unauthorized direct-ID access fails with the OLD device password. Prove
   concurrent redemption yields exactly one successful connection.
3. Implement transactional broker storage and RLS tests against real PostgreSQL,
   including cross-partner/org/site/user/device denial and revocation races.
4. Add Extensions configuration/assignment UI and device-page connection hook only
   after the transport adapter can enforce the same decisions. Keep default disabled.
5. On designated Linux operator QA and Windows OS-TEST, validate actual login,
   assigned listing, native launch, encrypted video/input, reconnect/reboot,
   wrong-device/replay/expired-ticket denial, simultaneous authorized users,
   direct/P2P bypass denial, account disable and active-session termination.
6. Upgrade the pinned Breeze and RustDesk versions in isolation; rerun SDK/manifest,
   auth, migration, RLS, direct-ID and real desktop acceptance. A unit suite or
   green image build alone is not release approval. Record exact binary hashes.

Keep installation/provisioning separate from Breeze's MSI. Roll back only to a
compatible enforced-mode client/server pair; never silently turn off authorization
or restore password fallback. If the extension fails or is disabled, managed
connections fail closed. Do not deploy a development package over concurrent work.
