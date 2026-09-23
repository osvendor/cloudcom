# Cloud Command 3CX extension

## Scope and current delivery status

Implemented in `packages/ext-cloud-command`, registered as the compiled-in
`cloudcommand` extension. Deployment is opt-in and remains disabled by default.
Implementation and local VM verification are distinct from a signed release and
live PBX acceptance. No legacy PBX credential has been transferred by this change.

Use Breeze's organization selector, then Extensions → Connect for 3CX setup. The
operational 3CX page is directory-only; managers return to Connect when they need
to configure a connection. Each organization can configure its own HTTPS PBX
origin, client ID, secret, department scope and enabled state. No partner-wide
UniFi-style discovery or matching is required. Existing organizations remain the
authoritative client records.

The first slice provides connection verification, accessible department discovery,
a paginated extension list, and a full-page extension detail view. When an enabled
connection opens in the directory or combined view, the first extension page loads
automatically; Refresh remains available for a later read. Configuration-only views
and disabled connections do not issue extension reads. Whole-PBX access is an
explicit choice; selecting a department filters the returned users. This does not
establish a permission boundary for future call reports.

The operational directory keeps the retained Cloud Command columns separate:
User, Extension, Email, Registration, current-profile Status, and Account. Its
search filters only rows already loaded from the organization-scoped connection;
when another page exists, the page says to load more before treating the search
as complete. Registration and profile are read-only provider observations, not
synonyms for whether the extension account is enabled.

The detail view has General, Call Forwarding, IP Phone, BLF, Voicemail, Schedule,
3CX Talk, and View & Options tabs. The server returns a positive, redacted
projection of the provider response; unsupported or unavailable values are shown as
read-only notices. General and Voicemail fields, plus the supported ring controls in
Call Forwarding, can be edited for users with organization write access and a
verified MFA session. IP Phone, BLF, forwarding destinations and exceptions,
Schedule, 3CX Talk, View & Options, and assigned DID/routing ownership remain
read-only or unavailable. BLF is displayed only when the provider response matches
the verified empty envelope; arbitrary BLF XML is not parsed or round-tripped.

Updates are deliberately narrow. A save carries the detail revision and the
selected fields, rechecks the organization connection/version, rejects mixed scalar
and forwarding saves, and targets exactly one extension. Forwarding updates merge
only validated profile keys and require a reload after a forwarding save. Expanded
3CX profiles do not reliably include numeric IDs: the browser key is a validated,
unique raw `Name`, while `CustomName` is display-only. The key is stripped before
the provider update and the complete expanded profile object is preserved. Phone
and forwarding-exception IDs are nullable in the read-only projection. The revision is a preflight comparison: 3CX does not
document conditional PATCH, so it is not an ETag and does not make the provider
operation atomic against an external concurrent edit. PBX user editing outside these
fields, queues, reports, and other telephony mutations are unavailable.

The provider uses the documented 3CX V20 Configuration API client-credentials flow:
https://www.3cx.com/docs/configuration-rest-api/
https://www.3cx.com/docs/configuration-rest-api-endpoints/
The configured API principal's actual rights still constrain what the PBX returns.

## Ownership and host compatibility

Extension-owned manifest, SQL, server routes, transport and web bundle live in the
package. Its only persistent table is `cloudcommand_threecx_connections` in the
existing database; no copied core organization records and no separate database
are necessary for this slice. No EE implementation was copied.

Host changes are limited to compiled-in registration/build packaging and a web
API bridge. The bridge is a separate `element.hostApi` capability, leaving strict
plain-data context contracts unchanged. It resolves the declared route namespace
from the authenticated registry, pins the mounted organization, uses Breeze's
existing authentication/refresh logic, rejects credentials and redirects supplied
by extensions, and aborts on unmount. Server authorization remains authoritative;
compiled-in extension JavaScript is trusted code, not a sandbox.

The registry now advertises `routeNamespace`. Deploy the matching API and web
images together. Existing extension elements may ignore the new property.
The Cloud Command UI uses Breeze's CSS tokens and native card/form/table/drawer
patterns; no product rebranding, image replacements or new palette.

Mutation-feedback exception: a standalone custom element cannot import the host's
private React `runAction` helper. Test/save use an inline `aria-live` status region,
explicit HTTP failure handling and busy controls. The web tests cover successful
and failed outcomes, draft preservation, and write-only secret clearing.

## Security and storage

- Host-authenticated users only. Reads require `organizations:read`, reachable
  active/trial organization and no site-restricted role. Configuration and test
  also require `organizations:write` and the host's effective MFA policy. This is
  not a claim that a fresh second factor was presented.
- Forced PostgreSQL RLS uses `breeze_has_org_access(org_id)` for all DML, with an
  organization foreign key. Org deletion cascades and exports declare the table.
  Exports explicitly exclude `secret_ciphertext`.
- AAD-bound `enc:v3` encryption is mandatory: configure `APP_ENCRYPTION_KEY` and
  `APP_ENCRYPTION_KEY_ID` using the host's normal key management. AAD includes the
  organization. Preserve historical decryption keys during rotations; this custom
  column is not automatically re-encrypted by a core-only column rotation job.
  Rotate a connection credential through the extension to write it with the active
  key. Never remove old keys until all extension rows have been re-encrypted and
  verified. Never paste credentials in source, test fixtures, reports or logs.
- An omitted secret is retained only for the same PBX origin and client ID. A
  target change requires a new secret. Version checks prevent stale saves from
  overwriting a concurrent administrator's changes. Disabling an unchanged
  connection works even when the PBX is unavailable.
- Only public HTTPS PBXs, including custom HTTPS ports, are supported initially.
  Breeze's DNS-pinned egress guard blocks private, loopback, metadata and carrier
  NAT targets. TLS validation stays enabled. Redirects are not followed, responses
  and deadlines are bounded, provider errors are redacted, and next links never
  control the destination of a credential-bearing request.
- No global token cache. List reads request a short-lived provider token for the
  selected connection. Configuration/test audits omit all credential material.

## Packaging, enablement and recovery

Both API Dockerfiles package the extension's manifest, migration and web bundle;
the API bundles server source. To enable a verified release, pass the exact string
`CLOUDCOM_THREECX_ENABLED=true` to the API/worker processes through the deployment's
explicit environment mapping. Merely putting it in a host `.env` file is not enough.
Default-off boot performs no new migration when the extension has never run.

The host migration ledger owns `cloudcommand/<migration-file>`. The migration is
idempotent and never edits core tables. Do not rename the extension or edit a
shipped migration. Future schema changes are forward migrations in this package.

Disable the deployment flag to stop loading routes while retaining data and tenancy
classification. Disable an individual organization's connection in the UI to stop
its reads. For rollback after a schema change, use an extension-compatible prior
image or restore the verified database backup with its matching images. An older
core image that does not know these extension tables is not a validated rollback.
Do not drop the table to work around a startup tenancy check.

## Upstream-update checks

`docs/cloudcom-upstream-maintenance.md` and `.github/cloudcom-customizations.json`
register the package, host bridge, build attachments and CI checks. Upstream imports
must preserve or deliberately adapt them. This guards deletion/attachment drift;
it does not prove behavioral compatibility or guarantee conflict-free merges.

Recheck the extension SDK, auth/permissions, organization selector, registry schema,
web asset loader, safe egress, encryption, RLS/cascade/export contracts and both
Dockerfiles against each pinned upstream release. Run the focused CloudCom tests
against the merged revision. Do not rerun every upstream workflow just because
upstream already released a version.

The first live acceptance must verify a real organization's credential and selected
scope, successful list/details display, unauthorized/cross-org denial and disable/
re-enable behavior without changing PBX settings. Legacy credential reuse requires
an explicit organization mapping; do not infer that the old default department
belongs to every client.

Provider proof for the implemented narrow updates was completed against a
user-authorized dedicated test extension: an identity/voicemail PATCH and a
forwarding update through `Users/Pbx.MultiUserUpdate` both succeeded and were
restored afterward. The proof used no production or customer identifiers. It does
not establish atomic stale-write protection, ETag support, or deployment readiness.
The profile compatibility fix shipped in PR #22. Live detail loading and narrow save/restore checks passed on the authorized test extension.

## Call Log candidate

The extension has a read-only Call Log candidate for connections explicitly scoped to the full PBX. It uses a fixed 3CX report function, validates a range of no more than 31 days, reads at most the first 100 events, projects only approved call metadata, audits the scoped read, and labels CSV export as loaded results. It does not load call events until the operator searches. A department-scoped connection receives `report_scope_unverified` before decrypting a credential or calling the provider: the retained Cloud Command report query had no explicit department predicate, so provider role constraints alone must not be assumed to isolate customer call records. PBX server-driven continuation semantics are unverified; an apparent next page is labeled incomplete and never followed or converted into an invented `$skip` query. This new path has local tests but no live PBX report proof or deployment claim. Any future department support requires a demonstrated provider-side boundary or verified row filter before the gate is relaxed.

## Extension menu design

The [proposed device-style detail menu](cloudcom-threecx-menu-design.md) prioritizes General, Call Forwarding, IP Phone, BLF and Voicemail. It maps the observed PBX API schema to future controls. This is a design, not a claim that PBX editing is implemented.
