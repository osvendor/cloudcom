# RustDesk Access: account authorization and connection handoff

## Status and intended experience

The browser implementation is deployed behind explicit organization settings and
customer device assignments; production acceptance is still in progress. Core migrations
provide forced-RLS customer assignments/settings/sessions, and portal routes
enforce the remote-only identity boundary. The separate extension manages
assignments through the scoped host API. Browser session creation, offers,
live leases, viewer presence and fenced termination are wired for testing.
WebRTC availability uses the same live authorization as session creation and
requires both endpoint enforcement protocols. The global feature defaults off;
RustDesk availability remains off until native acceptance succeeds.
Native target enforcement and app sign-in described below are still required.

### Deployment and login boundary

The first browser release passed packaged-image QA before deployment. Production
acceptance identified a login payload projection that omitted `accessMode`; login
and invite acceptance now project that field, and the browser maps it to the
remote-only landing page. A real-database login regression asserts the returned
mode, while navigation tests retain supported remote deep links and reject
off-origin destinations.

The portal's server-side API requests must traverse a trusted internal proxy hop
when HTTPS enforcement is enabled. Keep its private address stable and trust only
that exact portal address in addition to the existing ingress proxy; do not disable
HTTPS enforcement or trust an entire container subnet to solve an SSR redirect.
This deployment correction is configuration, not a change to customer privileges.

The current public ingress also has a host-wide Cloudflare Access login. Customer
portal reachability needs separately reviewed, narrowly scoped Access routing for
the portal and its API paths while retaining staff-route protection. An origin
tunnel used for acceptance does not prove public customer reachability. No Access
policy was changed by this implementation.

A production-origin canary with an existing Windows agent streamed a real
1920×1080 lock screen, denied the unassigned same-organization customer with 404,
survived a further 75 seconds of viewing, and confirmed the customer's End session
action. This used temporary remote-only credentials and an authenticated origin
tunnel; it validates the Windows transport, not public Cloudflare reachability or
TURN relay fallback. No Windows password was entered during this canary.

### Browser QA checkpoint (2026-09-22)

An isolated Linux API/portal/PostgreSQL/Redis stack and an enrolled agent passed
real Chromium sign-in, assigned-computer listing, the browser Connect button,
decoded 800×600 desktop video, mouse movement, and keyboard press/release. The
same-organization customer without assignments saw no devices and received 404
when guessing the active session URL through the API. A session survived 75
seconds of continuous viewing (beyond its initial 60-second authorization lease).
Revoking its assignment ended viewing in approximately five seconds and the
agent acknowledged the terminal fence. Closing the browser also reached a
confirmed terminal state after fixing portal handling of authenticated endpoint
disconnect notifications. The focused route/agent regression suite passed 36
tests, and API and portal builds passed on that source snapshot.
The authenticated Extensions UI also passed settings save, grant, and revoke
against the real API. Its partner-status SQL regression is covered by a real
database test; the remote database suite now has ten passing tests. The merged
Cloud Command baseline passed both extensions' tests, 53 shared web-host tests,
all 767 portal tests, and API/web/portal builds.
Focused TypeScript checking of the remote API production files and their unit
and integration test roots also passed with a 6 GB heap. This is not a claim
that the entire inherited API typecheck passed.

The checkpoint above is isolated Linux acceptance, not Windows acceptance. The
test used an Xvfb desktop and a locally supplied OpenH264 library; it does not
validate production codec packaging, cross-network TURN routing, Windows login
screens, a Breeze upgrade, or the custom native RustDesk client. Those remain
release/transport acceptance requirements.

Device lifecycle boundary: permanent device deletion removes remote sessions
before assignments through the existing audited cascade. Organization moves and
merges are refused while remote grants/history exist; revoking a grant does not
erase its history or make it transferable. A future explicit archival/reset
workflow is needed for transfer without permanent device deletion. This avoids
silently carrying customer access or ownership history into another tenant.
The user wants an installed RustDesk client: sign in with a Breeze account, list
only explicitly approved devices, then connect without entering a device password.
Configuration belongs in a separate **Extensions → RustDesk Access** page. Keep the
existing device-page Connect action as the technician entry point. The Cloud Command
extension and its 3CX code are owned by concurrent work and must not be modified.

### Customer identity and portal clarification

Customers need remote access, not technician/dashboard access. Reuse Breeze's
existing customer identity (`portal_users`) and portal authentication as the
starting point, with a remote-access-only entitlement and landing page. The
customer portal now provides a dedicated `/remote` landing page and
`/remote/:sessionId` browser-viewer route. These routes are portal-authenticated
and do not replace the technician application's device routes.
The installed operator app and emergency browser viewer use the same customer
identity and assignments. Administrators manage these in the RustDesk extension.

The existing portal has invites, login, account status/auth-epoch invalidation,
and organization-scoped identities. Its current Devices API lists devices for the
whole organization (`routes/portal/devices.ts`), NOT user-assigned computers. Do not
enable or reuse that list as the customer's remote-access authorization boundary.
Add an assigned-computers API and enforce its predicates again during connection.

Existing portal section toggles are primarily organization-level, not proof of a
remote-only per-user role. A remote-only entitlement must deny unrelated portal
APIs server-side, including tickets, invoices and organization-wide device exports;
hiding navigation is insufficient. Do not promote portal users into technician
`users`, inherit `linkedUserId` permissions, or accept portal sessions at technician
routes. Represent the subject as `(principalType, principalId)` in all assignments,
audits and authorizations so customer and technician identities cannot be confused.
Verify portal MFA/SSO support for this new use case; do not assume staff MFA applies.
Portal middleware now enforces this entitlement; the native sign-in integration
is still pending.

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

1. **Current checkpoint:** the server-side extension package, forced-RLS account
   settings/assignments/sessions, portal remote-only routing, assigned-computer
   API, browser session signaling, customer viewer source, and separate extension
   settings/assignment UI are implemented in source. Existing focused unit and
   integration evidence covers the authorization policy, RLS/schema contracts,
   portal routing/API contracts, and extension behavior. The complete browser
   desktop acceptance flow is still in progress: live signaling, media/input,
   revocation, and end-to-end portal acceptance remain to be run in designated
   QA. Native RustDesk client/server changes, native sign-in, and native
   transport enforcement remain untouched and are not claimed complete.
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
