# Native Microsoft administration extension: corrected architecture

Decision recorded 22 September 2026. This supersedes the proposal to require a running CIPP backend.

## Product boundary

CIPP is the source reference for capability breadth and menu depth. Breeze remains the running application. The Cloud Command extension owns custom Microsoft administration code and UI. Microsoft Graph, Exchange Online and any other explicitly required Microsoft service are the provider backends. No CIPP installation, CIPP API client or Azure deployment for CIPP is required.

The original deployed adapter called CIPP and was unavailable without configuration. The native replacement in this branch removes that runtime dependency and retains the list/drawer components and provider overview. Deployment and live Microsoft acceptance are separate checks; do not activate an older image by provisioning CIPP.

Breeze remains authoritative for organizations, staff identities, roles, MFA policy, audit, existing jobs and equivalent native capabilities. Do not import CIPP's customer editor, operator login, Azure hosting system or MSP billing interfaces just to reproduce its navigation.

## Source-derived coverage, not a menu imitation

Pin both CIPP repositories. For every menu node, trace the actual page, imported table/action configuration, entity tabs, detail drawers, modal forms and lazy-loaded subcomponents. Then trace each operation to its CIPP-API handler and the Microsoft calls or command helpers it makes.

A top-level route list is not enough. The coverage ledger must contain one row for every user-visible action or query with:

- Menu ancestry, route and label.
- Entity page, tab, drawer, form and bulk-action placement.
- Source commit and file links for frontend and backend.
- Input fields, validation, eligibility rules and confirmation behavior.
- Microsoft service, API version or PowerShell cmdlet and paging/report semantics.
- Required application/delegated permissions, tenant roles and product licenses.
- Current Breeze equivalent and whether to reuse it or add extension-owned code.
- Interactive versus queued execution, timeout, throttling and cancellation behavior.
- Audit fields, per-item results, partial/unknown outcomes and verification after writes.
- Implementation and test status: inventoried, mapped, implemented, fixture-tested, live-tested.

Documentation entries are not interchangeable with screens or operations. The earlier 373-entry documentation inventory is a discovery aid, not proof of complete implementation. Dynamic menus and shared action registries need explicit review.

## Runtime design

Browser -> Breeze extension page -> authenticated, organization-pinned extension route -> typed operation service -> Microsoft Graph or isolated Exchange worker.

The server resolves the Microsoft tenant from the authorized Breeze organization. Browser-supplied tenant IDs, arbitrary Graph URLs and arbitrary PowerShell command strings are not an execution interface. Provider availability, consent and action permissions decide which menus and controls are enabled for each organization.

Re-use Breeze's supported services through one narrow, versioned adapter rather than importing private services throughout the extension. Existing action-intent approvals, MFA requirements, audit and result handling remain in force when a click-driven UI uses an operation that previously appeared only as an AI tool.

Graph reads and writes should retain distinct credential and authorization boundaries. Exchange runs in an isolated service/worker with a fixed operation registry and typed parameters. Long operations use durable jobs and polling; they do not hold a browser request open for several minutes. Partial completion and uncertain delivery must remain visible and must not trigger blind retries.

The runtime location for any new worker is a deployment decision, not a reason to install CIPP. First evaluate the existing Linux VM capacity and supported Microsoft modules. Do not claim every CIPP operation is app-only or supported on Linux until its underlying service is checked.

## Existing Breeze capabilities verified in source

Reference files in the fork:

- packages/shared/src/m365/readActions.ts: 12 interactive operations for users, groups/members, organization/SKUs, sign-ins, Intune devices and SharePoint sites; seven distinct sync operations.
- apps/api/src/services/m365ControlPlane/readActionService.ts: organization/connection checks, budgets, result projection and typed executor calls.
- packages/shared/src/m365/writeActions.ts: disable-user and reset-password only. This is not a complete administration backend.
- apps/api/src/services/m365ControlPlane/writeActionService.ts: existing write flow to assess for reusable authorization/approval semantics.
- apps/m365-graph-read-executor: certificate-authenticated Microsoft Graph executor. Its current credential provider is tied to Azure Key Vault and its runtime has a dedicated read-profile contract.
- docs/deploy/m365-customer-graph-read-executor.md: explicitly requires a dedicated read application and forbids reusing a mutation/PowerShell application for that profile.
- The customer-exchange-powershell profile is declared; a declaration alone is not evidence of a complete operational Exchange backend.

Do not activate the legacy-direct compatibility path as a shortcut or label a broad certificate read-only. Select reuse at the service/contract boundary, preserving its checks. If a separate extension-owned credential provider is needed for the existing deployment, it requires its own explicit design and isolation tests.

## Credential migration evidence and limits

Existing credential readiness and tenant identities must be verified privately. Do not put tenant inventories, credentials, tokens or deployment identities in this document. A successful organization read is not proof of Exchange or write-action readiness.

Migration sequence:

1. Inventory app registrations, certificate references/expiry, tenant identities, observed grants and Exchange application roles without exporting secret values.
2. Map each external tenant to the existing Breeze organization; resolve ambiguity explicitly.
3. Compare each credential against the intended read/write/Exchange profile. Reuse only when compatible. Do not relax Breeze's profile validation to fit an existing credential.
4. Transfer approved credentials through a private secret mechanism directly to the owning executor, with file/secret access and rotation documented. Never through chat or repository files.
5. Re-test tenant identity and permitted read operations from the new executor. Enable one internal organization first.
6. Validate writes with disposable test resources, explicit permissions, audit and read-back. Keep the old application available until parity and cutover are accepted.

## Replacing the mistaken CIPP dependency

1. Preserve existing 3CX behavior, routes and connection data.
2. Replace cipp-config.ts/cipp-provider.ts usage in Microsoft routes with a typed native Microsoft service boundary.
3. Replace CIPP tenant discovery with verified native Microsoft connections mapped to Breeze organizations.
4. Preserve the stable Microsoft extension route and reuse its UI after native response models are defined.
5. Do not repurpose backend_identity values or edit a shipped migration. Add forward-only migration(s) for any native extension-owned state. Existing native m365_connections remains authoritative wherever compatible; avoid two active mapping systems.
6. Remove the CIPP-instance setup requirement from the active UI/configuration only when the native path replaces it. Retain truthful not-connected states during transition.
7. Validate migration, organization boundaries, native service contracts and browser flows on the Linux test VM, then promote one signed release.

## Delivery order

First: finish the source-to-capability ledger and native connection boundary, then replace the current four inventory reads with real Microsoft reads.

Next: user and group detail panels and queries, followed by the existing supported disable/reset flows through their native controls. Build mailbox/Exchange execution before presenting mailbox actions as available.

Then: expand in the source-derived domain order (Identity, Tenant, Email/Exchange, Teams/SharePoint, Security/Compliance, Intune and the remaining applicable areas), with explicit per-operation test status. CIPP-only hosting/administration functions are recorded as intentionally excluded, not silently overlooked.

## Definition of completion

A menu is complete only when its pages, tabs, drawers, queries, mutations, errors, permissions, bulk outcomes and tests are accounted for. Matching a sidebar or rendering buttons does not establish functional parity. No full-CIPP-parity claim should be made until the ledger supports it.
