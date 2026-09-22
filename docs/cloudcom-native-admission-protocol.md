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
