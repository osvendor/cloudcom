# Basic content search and export

## Included workflow

Basic search and export remain required within the Business Standard extension scope. Premium case workflows, legal holds, review sets and advanced analytics are excluded. Do not reinterpret the request as permission to add licenses or consumption billing.

Use Breeze extension navigation and existing table/drawer conventions: Content search list; create/edit query drawer; details with locations, query, status and statistics; export options and job status. Organization selection must resolve the tenant on the server. Search authorization, export authorization and artifact download authorization must be checked independently. No unavailable action should claim success or silently open a different tenant.

## Provider boundary verified 2026-09-22

Microsoft documents the old cloud `New-ComplianceSearchAction -Export` path as retired/on-premises-only. Do not copy a legacy CIPP or Cloud Command implementation that depends on that command.

The current Graph `ediscoverySearch: exportResult` endpoint is asynchronous (202 with an operation location), supports application permissions and documents pay-as-you-go prerequisites for Standard/E3 API usage. This does not establish a no-add-on Business Standard automation path. The user's working portal search/export remains evidence of the portal workflow, not proof that this API has identical entitlements.

Until a supported no-add-on native export interface is verified, keep native export delivery explicitly pending. A clearly labelled Microsoft Purview handoff may preserve access to the existing portal workflow, but must not be counted as integrated export acceptance. Do not use undocumented portal endpoints, scrape authenticated export tokens or substitute arbitrary mailbox downloads for compliance search/export.

## Native acceptance requirements

- Fixed allowlisted operations, bounded query/location inputs, server-resolved tenant, role/MFA and audit checks; no arbitrary PowerShell or Graph requests.
- Persist tenant-bound search/job ownership, provider identifiers, status and reconciliation metadata in extension-owned storage with forced tenant RLS. Never edit shipped migrations.
- Test only owned fixture content with a unique query marker; never use an empty organization-wide search as the default.
- Verify estimate results, export completion, actual downloaded fixture contents and cleanup independently. A 202 response is acceptance, not completion.
- Reconcile timeouts before repeating non-idempotent requests. Validate operation URLs against the fixed provider origin and expected tenant-owned object path.
- Keep signed download links and exported content out of logs. Reauthorize downloads, use expiry/retention controls, and deny cross-organization access even when an object/job ID is known.

## Sources

- [Current PowerShell export limitations](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-compliancesearchaction?view=exchange-ps).
- [Graph exportResult contract and permissions](https://learn.microsoft.com/en-us/graph/api/security-ediscoverysearch-exportresult?view=graph-rest-1.0).
- [eDiscovery API billing](https://learn.microsoft.com/en-us/purview/edisc-billing).

Status: implementation contract and provider research; no native content search/export UI or executor shipped by this change.
