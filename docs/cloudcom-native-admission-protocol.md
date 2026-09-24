# Native admission protocol, version 1

Status: preparatory code, **not wired into a connection and not enabled**.
`services/portalNativeProof.ts` verifies an operator's Ed25519 proof. The native
`cloudcom_access/proof.rs` builds the matching bytes. Neither helper replaces
ticket consumption, target authentication, live account checks, or channel
termination. Do not enable the native transport on the strength of these tests.

## Admission bytes

The signature covers the following fixed-width sequence, with no JSON or text
normalization inside the signature:

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 29 | ASCII `CloudCom/native/admission/v1` followed by one NUL byte |
| 29 | 16 | Organization UUID bytes |
| 45 | 16 | Device UUID bytes |
| 61 | 16 | Session UUID bytes |
| 77 | 16 | Target-generated connection UUID bytes |
| 93 | 8 | Target enrollment generation, unsigned big-endian |
| 101 | 32 | SHA-256 of the decoded opaque 256-bit ticket |
| 133 | 32 | Fresh target-generated connection challenge |
| 165 | 32 | Operator ephemeral Ed25519 public key |
| 197 | 32 | Enrolled target public key |

UUID text at the API boundary must be canonical lowercase, with a supported UUID
version and RFC variant. Generation must be a positive JavaScript-safe integer.
Binary JSON fields use canonical unpadded base64url. Signatures are 64 bytes.
Reject padding, alternate encodings, wrong lengths and unsupported versions.

The API must construct the expected binding from the authenticated target and
stored ticket/session records. An operator cannot substitute those stored
identities by supplying a valid signature over different values. The target must
construct the same binding from its own challenge, enrolled identity and exact
connection, rather than trust an echoed challenge in the operator's request.

## Required integration

- Use system-browser sign-in with PKCE; retain the remote-only portal identity.
- Enroll targets through the authenticated Breeze agent. Protect local enrollment
  material against ordinary desktop-user modification and expose only restricted
  target operations through the target credential.
- Atomically consume a short-lived ticket once, checking its stored account,
  assignment version, auth epoch, target generation, audience and hard deadline.
- Recheck live authorization at redemption and renewal. A valid proof alone is
  not an authorization decision.
- Require the encrypted, authenticated RustDesk transport. The legacy handshake
  permits paths without a stream key; managed admission must explicitly reject
  these paths before sending or receiving admission secrets.
- Gate every path that can reach `send_logon_response_and_keep_alive`, including
  connection-manager approval, recent sessions, side switching and second-factor
  responses. Also reject unauthorized traffic before ordinary login processing.
- Enforce expiry independently of incoming traffic and renewal HTTP requests.
  Stop queued input and all enabled outgoing channels as well as the socket.
- Preserve the existing implementation when the new feature is absent. Managed
  installations must never silently fall back to the stock password path.

## Evidence

The API proof suite passes four tests covering valid signatures, every binding
field, wrong keys, invalid signatures/encodings/generations, the fixed byte layout
and strict ticket hashing. This is unit evidence, not native end-to-end acceptance.
On the designated Windows canary, Rust 1.75 compiled and ran the five lease tests
and two native encoding tests with exit code zero. The compiler and build
directory are isolated; rustfmt was not installed for this run. No full client
build or target/operator handshake was exercised by these standalone tests.


## Version 2 backend preparation

Default-off `CLOUDCOM_NATIVE_ADMISSION_ENABLED` adds target enrollment/rotation,
customer ticket issuance, target consumption/renewal/closure and customer
presence/end handlers. This is preparatory backend code, not deployed or proof
that a paired RustDesk client/target works. Technician issuance and ordinary
RustDesk password handoff remain unimplemented.

V2 changes the domain to `CloudCom/native/admission/v2` followed by NUL and
appends a 32-byte channel binding at offset 229 (261 total bytes). The channel
binding is HMAC-SHA256 with the actual encrypted TCP secretbox key over ASCII
`CloudCom/native/channel/v2` followed by NUL. The operator must separately pin
the authenticated RustDesk signing key to the enrolled target public key. Ticket
hashes remain SHA-256 of the **decoded 32 ticket bytes**, never of their base64url
text. No v1 proof or insecure/non-TCP transport fallback is allowed.

Enrollment is `/api/v1/agents/:id/native-target/enroll` under normal current
main-agent authentication (not watchdog, previous, staged or draining credentials).
Body: `{version:2, installationId, targetPublicKey, targetCredential, rustdeskId}`.
The target generates and securely persists its 32-byte credential *before*
enrollment. API stores only its SHA-256 hash and never returns a credential.
Identical enrollment is idempotent; changed state is 409. Explicit `/rotate` adds
`expectedGeneration`, requires a new credential, increments generation and
invalidates every prior admission. Keep the pending local credential until a
successful response; loss of local state requires explicit rotation, not an
automatic new trust binding. Two new tables have forced RLS and composite
org/device/session/owner constraints. Export excludes credentials/proof hashes;
org merge and device move cannot transfer target authority.

Customer endpoints, beneath `/api/v1/portal/remote/native`, require both the
personal `ccn1.` bearer and an enabled verified company gateway:

- `POST /sessions`: `{version:2,deviceId,operatorPublicKey}` returns session/org/
  device IDs, ticket, ticketExpiresAt, hardDeadline, targetId, targetGeneration,
  targetPublicKey, peerId, transport (`tcp`) and restrictive policy.
- `POST /sessions/:id/presence`: `{version:2,connectionId}`. Only the exact
  originating native login may refresh presence, bounded by verified Cloudflare
  expiry and native-session expiry. No browser cookie/technician shortcut.
- `POST /sessions/:id/end`: `{version:2}`; exact same-owner login only.

Target endpoints use `Authorization: Bearer cct1.<credential>` and dedicated
middleware beneath `/api/v1/native-target`, never an agentAuth skip:

- `POST /admissions`: `{version:2,sessionId,ticket,connectionId,targetChallenge,
  channelBinding,operatorSignature}`. Stored keys/identities construct the proof;
  row locks admit only one redemption and bind it to one exact connection.
- `POST /sessions/:id/renew`: `{version:2,connectionId,leaseToken}`.
- `POST /sessions/:id/closed`: `{version:2,connectionId}`.

Admission returns version, sessionId, connectionId, deviceId, targetGeneration,
leaseToken, revision, ttlMs, expiresAt, hardDeadline, renewEverySec=20, graceSec=0,
and target policy. Renew returns the same binding with a higher revision and no
replacement token (lost responses must not strand a legitimate renewal). Apply
`ttlMs` from the **monotonic request start**, not response receipt. TTL is at most
60000 ms, never beyond independent operator presence or hard deadline; leases
cannot revive after expiry. Check current assignment version, account epoch,
org/device/target status and policy at consumption and every renewal. Target
renewal never refreshes operator presence. Retained expired rows are audit state,
not active authority.

First slice is desktop-only: no clipboard, file transfer, audio or tunnels.
Consume and renew independently return these restrictions plus idleTimeoutSeconds;
target must enforce them, including terminating all channels at expiry. A
configured notification or consent prompt currently denies ticket issuance;
there is no silent prompt bypass. Unsupported target policy is denial, not a
hint. Cloudflare machine-path exposure requires separate deployment review;
no broad bypass or public diagnostic endpoint is introduced by this code.

Acceptance still requires real PostgreSQL/RLS/concurrency runs, migration checks,
paired native build/install and actual account/target disconnect tests. UI native
availability remains off until that evidence exists.
