# 3CX extension detail menu

Design scope: menu structure and interaction design, not implementation of PBX editing. The shipped Breeze adapter still exposes basic read-only directory fields. Removing the redundant Configure 3CX button is the only runtime change in this pass. Connection setup remains under Extensions → Connect.

## Navigation and layout

Cloud Command → 3CX → Extensions → selected extension opens a full detail page. Use the same header and underlined, responsive `OverflowTabs` pattern as Breeze device details, instead of expanding the existing narrow details drawer into a large form.

- Header: Back to extensions, avatar, name, extension number, registration status, main department. Keep identity visible while changing tabs.
- Primary tabs: **General · Call Forwarding · IP Phone · BLF · Voicemail**.
- More: **Schedule · 3CX Talk · View & Options**. Use Breeze's overflow behavior as available width decreases; never squeeze tab labels until unreadable.
- Header actions: Save changes and an Actions menu. Save is enabled only for a validated, authorized draft. Show pending changes and preserve them across tabs; warn before changing extension or organization with a dirty draft.
- Use stable extension IDs and hash-based selection, for example `#extension=42&tab=general`. Back closes the detail view and restores the directory selection/focus; direct links must load the extension through the scoped server route, not trust cached list membership.
- Read-only users see the same information layout without editable controls. Unsupported fields or actions explain their availability instead of silently failing or implying they work.

## General

Use three readable sections with two-column forms on desktop and one column on mobile:

| Section | Fields and actions |
| --- | --- |
| Identity | Avatar, extension number, first name, last name, email, mobile. Keep the existing extension number read-only until renumbering semantics have been verified. |
| Numbers | Outbound caller ID and assigned DID numbers, with explicit assignment/removal controls only after routing ownership is verified. |
| Access | Main department, department-specific role, account enabled, two-factor authentication state/enforcement. Role options are bounded by the operator's grant, not a free text field. |

Keep **Reset password** and **QR setup** in the header Actions menu, with corresponding links in Access for discoverability. Reset the web-client password only; do not unintentionally rotate SIP credentials, phone passwords, provisioning links, or voicemail PINs. QR provisioning is a sensitive reveal action, never a permanently visible or cached image. The design includes avatar management, but the upload contract requires separate verification.

## Priority tabs

| Tab | Proposed content |
| --- | --- |
| Call Forwarding | Profile selector from the PBX; no-answer ring time; internal/external destinations for no answer, busy and not registered; away routing; ring mobile; push/ring-group behavior; ordered exceptions. Show destination type and target together. |
| IP Phone | Assigned phone list with model/template, MAC and interface; selected-phone settings; registration information where available. Add/edit phone, reprovision and reboot are separate deliberate actions. Do not reveal SIP or deskphone passwords in routine detail responses. |
| BLF | Ordered keys: position, type, target and label, with add/remove/reorder affordances. Preserve unknown key types when round-tripping. Do not invent a JSON format for the opaque provider string. |
| Voicemail | Enabled state, email delivery behavior, greeting selection, caller-ID/date playback and a separate PIN-reset action. Do not return existing PINs. Greeting upload/record/delete requires a verified file-operation contract. |

## API evidence and implementation boundaries

Reviewed on 2026-09-22 against the connected PBX's public `/xapi/v1/swagger.yaml`, OpenAPI 3.0.4, PBX version **20.0.10.1621**. Public background: [3CX Configuration API](https://www.3cx.com/docs/configuration-rest-api/) and [endpoint specification](https://www.3cx.com/docs/configuration-rest-api-endpoints/). The schema is evidence that a surface exists, not proof that the configured service principal can execute it. No PBX mutation was performed during design discovery. Keep the full downloaded schema and deployment address in private task evidence, not this repository.

| Surface | Observed schema/operation | What remains before enabling edits |
| --- | --- | --- |
| Identity and caller ID | `GET/PATCH /Users({Id})`; `Number`, `FirstName`, `LastName`, `EmailAddress`, `Mobile`, `ContactImage`, `OutboundCallerID`, `Enabled` | Field allowlist, validation, concurrency behavior, image upload contract and scoped authorization. |
| Department and role | `PrimaryGroupId`, inherited `Groups`, `Pbx.UserGroup` rights | Department membership and role semantics; prevent escalation beyond the caller or configured department. |
| 2FA | `Enable2FA`, `Require2FA` | Distinguish enrollment/state from enforcement; prove supported patch semantics and avoid exposing enrollment secrets. |
| Password reset | `POST /Users({Id})/Pbx.Regenerate`; `Pbx.RegenerateOptions.WebclientPassword` | Confirm options and their effects. Other options separately rotate SIP, deskphone, RPS, provisioning or voicemail credentials; never send all flags. Email sending remains a separately disclosed action. |
| QR setup | `GET /Users({Id})/Pbx.GenerateProvLink()` | Confirm official QR payload format, effective authorization, expiry/revocation and no-cache handling. Do not assume the returned link is directly a QR image. |
| DID assignment | `InboundRules` API; no simple DID-list property observed on `Pbx.User` | Establish routing-to-extension mapping and tenant-safe assignment rules; do not treat every PBX DID as available to the current organization. |
| Call forwarding | `GET /Users({Id})/ForwardingProfiles`; user `ForwardingProfiles`, `ForwardingExceptions`; `Pbx.ForwardingProfile`, `AvailableRouting`, `AwayRouting` | Validate nested-update shape, profile identity and destination scope with a test extension. |
| Phones | User `Phones`; `Pbx.Phone`, `PhoneSettings`; `Users/Pbx.GetPhoneRegistrar`, `GetPhoneRegistrars`, `RebootPhone`, `ReprovisionPhone` | Verify per-phone payloads, ownership and safe settings projection. Read-only phone metadata must not include provisioning links by default. |
| BLF | User `Blfs` is a nullable string with maximum length 20,480 | Verify serialization and supported key types against real, redacted fixtures; preserve unsupported entries. |
| Voicemail | `VMEnabled`, `VMEmailOptions`, `VMPlayCallerID`, `VMPlayMsgDateTime`, `VMPIN`, `Greetings`; regenerate option `VoicemailPIN` | Safe DTOs, write-only PIN inputs and verified greeting endpoints. Enum options include None, Notification, Attachment and AttachmentAndDelete; expose destructive attachment-and-delete behavior explicitly. |

Future backend work must retain the existing authenticated host bridge, encrypted per-organization connection, DNS-pinned transport, RLS, department fencing and stale-response guards. Check scope on every detail read and mutation; an extension shown earlier in a list is not ongoing authorization. Keep secrets and provider error bodies out of responses and audits. Require appropriate write permission and MFA for mutations, with safe audit summaries and explicit outcome feedback.

## Acceptance for a later implementation

Validate cross-organization and out-of-department denial, read-only roles, service-principal denials, unsupported PBX versions, partial failures, stale drafts, unknown BLF types and retry behavior. Verify keyboard navigation, overflow, focus return, mobile layout and theme inheritance. Exercise writes only against an explicitly designated test extension; the design preview is synthetic and cannot establish PBX write acceptance.
