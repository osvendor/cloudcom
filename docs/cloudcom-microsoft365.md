# Cloud Command native Microsoft 365 extension

## Implemented boundary

The Microsoft extension uses Breeze's native Microsoft Graph read executor through a versioned, compiled host bridge. CIPP is a pinned source and capability reference only. There is no CIPP server, API URL, client secret, tenant discovery call or runtime dependency.

The stable page is `/extensions/cloudcommand/microsoft`. The initial implemented resources are users, groups, licenses and SharePoint sites. They use fixed native read actions and show only fields actually supplied by those actions. This is not full CIPP feature parity. User administration, Exchange, Teams administration, Intune administration and other CIPP-derived features remain separate delivery work.

The extension reuses Breeze styling, organization context, authenticated host requests, resource navigation, filters and a details drawer. Native connection setup, consent, retest and disconnect remain in Integrations. The extension does not create another tenant mapping or credential form.

## Administration end goal

This initial read bridge is not the product acceptance target. Full administrative reads and writes are required. The existing broader application can be assessed and reused through an isolated administrative executor; its mismatch with the dedicated native read profile is not a reason to reduce permissions or require a read-only live-test milestone. See [the administration acceptance matrix](cloudcom-microsoft-admin-acceptance.md).

## Host attachment and configuration

`packages/ext-cloud-command/src/server/native-microsoft.ts` defines the version-1 boundary. `apps/api/src/extensions/cloudCommandMicrosoft.ts` is the single host implementation; `builtinRegistry.ts` loads it lazily to preserve the extension boot dependency boundary.

The extension package remains behind `CLOUDCOM_THREECX_ENABLED=true` (historical package-level flag). Microsoft readiness additionally requires the existing native customer Graph read runtime and organization allowlist. See [the upstream executor deployment contract](deploy/m365-customer-graph-read-executor.md). The bridge preserves `M365_GRAPH_READ_TOOLS_ENABLED` and `M365_GRAPH_READ_TOOLS_ORG_IDS`; it does not turn them on or bypass consent. The gate name predates the extension and now also controls its native read capability.

Do not deploy CIPP to satisfy an unavailable state. Configure the native executor and a compatible dedicated read application. Its current credential provider uses Azure Key Vault; the legacy Cloud Command application certificate must not be relabeled as this profile without checking its grants and intended use. Alternative credential storage needs its own reviewed provider design. [Architecture and migration requirements](cloudcom-native-microsoft-architecture.md).

## Authorization and data ownership

Each request requires an active Breeze organization, organization-read permission, tenant reachability and unrestricted site scope. The host repeats these checks before using Microsoft services. Queries cannot select another Microsoft tenant, arbitrary URL or action. System scope additionally requires platform-administrator status.

The authoritative connection is the existing `m365_connections` row for the requested organization and `customer-graph-read` profile, loaded under the caller's RLS context. Only active/degraded connections with a tenant can execute. Remote execution uses the existing read budget and audit service outside the short DB read contexts. A second caller-scoped lookup discards successful results if the connection is revoked, rebound, reconsented, or its credential/profile generation changes during the request.

The old `cloudcommand_microsoft_connections` table and its shipped migration are retained for compatibility, export and recovery; native execution neither reads nor writes it. Its `backend_identity` is not reinterpreted. Old tenant-discovery/binding endpoints return an explicit `native_connection_required` response. Existing deployments with legacy rows must review/export them before any future cleanup; this change does not migrate or delete those rows.

## Inventory semantics

- Users and groups use the native bounded list actions (page size 50), not an unbounded whole-tenant export.
- Sites use native Graph site search with the fixed wildcard, not the former CIPP SharePoint usage report. Owner/storage report fields are not fabricated.
- Licenses show the SKU, assigned units and capability status from Graph. Friendly catalog names and purchase availability are not inferred.
- The executor's truncation flag is retained. The UI's Complete/Partial label describes that bounded response; it is not proof of whole-tenant inventory completeness.
- Browser filters apply only to loaded rows. Full directory paging/search and deeper entity queries remain to be implemented.

## Validation and recovery

Relevant checks include extension server/UI tests and typecheck, native bridge tests, gateway/registry regression checks, API/web builds and headless browser fixtures on the Linux test VM. These do not prove live Microsoft consent or live tenant parity. Record actual deployment and live checks separately.

No new schema migration or Microsoft credential transfer is introduced. Promote matching API/web images through the signed release process. Rollback restores the previous verified images; old CIPP configuration should remain disabled. Preserve 3CX, RustDesk and Cloudflare configuration.

Before merging upstream, validate the narrow host bridge against native profile, snapshot, result, budget and audit changes. The customization contract and change-focused CI must retain this attachment and its tests. A conflict-free merge is not sufficient evidence of compatibility.
