# Cloud Command Microsoft 365 extension

## Implemented boundary

This is the first read-only CIPP adapter, not full CIPP feature parity. The extension
provides organization-bound users, groups, licenses and SharePoint site inventory,
with Breeze-style tables, filters, resource navigation and detail drawers. It does
not embed CIPP's UI or copy its backend. Unsupported domains and actions are not
shown as working buttons.

The separate CIPP service remains responsible for Microsoft authentication,
provider permissions and data collection. Current API contracts were reviewed at
CIPP-API commit `c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600`. Its source and generated
OpenAPI may differ (notably ListTenants GET usage); pin and contract-test upgrades.

## Deployment configuration

The existing compiled Cloud Command extension must be enabled with
`CLOUDCOM_THREECX_ENABLED=true` (historical deployment switch; it loads the whole
package). Additionally, Microsoft reads require these server-only variables:

| Variable | Meaning |
|---|---|
| CLOUDCOM_CIPP_ENABLED | Exact string `true`; otherwise unavailable |
| CLOUDCOM_CIPP_ORIGIN | Public HTTPS origin only, e.g. `https://cipp.example.com`; no `/api` suffix |
| CLOUDCOM_CIPP_PARTNER_ID | Breeze partner UUID allowed to use this backend |
| CLOUDCOM_CIPP_AUTH_TENANT_ID | Entra tenant hosting the API-client application |
| CLOUDCOM_CIPP_CLIENT_ID | Dedicated CIPP API-client application UUID |
| CLOUDCOM_CIPP_CLIENT_SECRET | Secret injected from deployment secret storage |
| CLOUDCOM_CIPP_SCOPE | Exact API scope copied from CIPP, e.g. `api://<app-id>/.default` |

Do not reuse an old Cloud Command Graph token as a CIPP API credential. Create a
least-privilege CIPP API client through its documented setup. Pass variables
explicitly to the API process; a host .env entry alone is insufficient. Invalid or
incomplete configuration yields an unavailable provider without disabling 3CX.

Official supported self-hosting requires the documented Azure infrastructure.
The upstream generic Docker/Azurite development stack is not a validated production
replacement. No Azure subscription or paid service is provisioned by this change.

## Organization mapping and permissions

Breeze's organization selector is authoritative. A platform administrator or a
matching partner-scoped manager with organizations:write and effective MFA policy
may discover CIPP-authorized tenants and bind one to an organization. Organization-
scoped users cannot enumerate or remap the partner's tenants. Reads require live
organization access, organizations:read and an unrestricted whole-organization role.
The backend credential is pinned to exactly one Breeze partner per deployment.

The table `cloudcommand_microsoft_connections` owns the mapping and enable flag.
It has forced RLS, an organization foreign key, cascade and safe export declarations.
It stores no credentials. Version checks protect concurrent saves. Every read
revalidates the stored tenant ID and default domain against CIPP's current permitted
tenant list. A changed backend identity invalidates existing bindings until an
explicit reconnection; secret rotation for the same identity preserves them.
Disabling an existing binding does not need a working upstream API.

The browser cannot choose arbitrary CIPP endpoints, Graph filters, target tenants,
backend origins or OAuth scopes. Only four fixed read operations are exposed. The
literal AllTenants is rejected. Authenticated requests use Breeze's DNS-pinned
public-only HTTPS transport, bounded deadlines/response sizes and no redirects.
Provider bodies, secrets and tokens never enter logs or error responses.

## Contracts and completeness

- ListTenants is GET, accepts only valid unique tenant UUID/domain records; an
  HTTP-200 error sentinel is an error, not an empty tenant list.
- ListUsers and ListGroups use the stored concrete tenantFilter with live arrays.
- ListLicenses uses a concrete tenantFilter and projects only license summary fields.
- ListSites uses concrete tenantFilter and Type=SharePointSiteUsage. It may contain
  report-derived data; its report date is shown alongside request completion time.
- CIPP handles provider pagination internally for these calls. The adapter accepts
  at most 10,000 records and 8 MiB; larger/malformed responses fail visibly. It does
  not silently truncate or follow returned next links. Completeness means the
  accepted CIPP response array was fully projected, not an independent guarantee
  that Microsoft's reporting data is current or every object is licensed/visible.

## Validation status

The Linux VM passed 57 server tests, 30 UI tests, four database integration tests,
103 RLS coverage checks, API/web builds and synthetic Chromium light/dark/mobile
checks. These counts describe the initial candidate; later focused tests may add
coverage. No live CIPP backend or Microsoft tenant has been certified by these
checks.

## Remaining capability coverage

The approved planning ledger covers Identity, Tenant, Security/Compliance, Copilot,
Intune, Teams/SharePoint, Email/Exchange, Tools and connector administration. This
release implements only the four resource reads above. User editing, MFA, licenses
assignment, mailbox delegation/forwarding/replies, onboarding/offboarding, policies,
reports beyond these lists, and durable mutation jobs remain unimplemented.

Live CIPP authentication, direct-tenant onboarding, real tenant read parity and
mutation acceptance require a configured CIPP backend and appropriate consent.
Mutations must use disposable test resources and preserve partial/unknown outcomes;
fixture tests do not establish live provider acceptance. Do not enable unverified
write actions to make a menu appear complete.

## Upgrade and recovery

Keep custom code under packages/ext-cloud-command and preserve the host bridge,
manifest entries and image build attachments. The new migration is forward-only;
never edit a shipped migration. The current disabled-extension path retains table
classification. An older image unaware of the Microsoft table is not a validated
rollback; use a compatible image or restore the matching pre-migration database
backup. Do not remove extension tables to bypass tenancy startup checks.

Tests cover provider projection/errors, permission and org/partner boundaries,
stale backend bindings, optimistic saves, disabled-provider behavior, UI races and
real breeze_app RLS. Repeat affected contracts after each Breeze/CIPP upgrade.

## Primary references

- https://docs.cipp.app/api-documentation/setup-and-authentication
- https://docs.cipp.app/user-documentation/cipp/integrations/cipp-api
- https://docs.cipp.app/setup/setting-up-cipp/install
- https://github.com/KelvinTegelaar/CIPP-API/tree/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600

## Organization entry page

Extensions → Cloud Command opens a provider overview for the selected organization.
Readers see only enabled providers; managers can reopen available provider setup.
Microsoft stays hidden until its partner backend is configured. Existing provider
deep links remain stable. Switching organizations clears pending drafts and data
and invalidates old requests before displaying the next organization.
