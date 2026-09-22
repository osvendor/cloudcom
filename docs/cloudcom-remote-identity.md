# Customer remote identity: selected default

Status: owner-selected architecture, 2026-09-22. Implementation staged; customer cutover is not enabled.

The design uses one shared company username/password in an isolated Docker Authentik service solely for the Cloudflare gateway. Individual customers remain Breeze `remote_only` username/password identities. The browser and native flows intentionally retain two login steps: Cloudflare first authenticates the shared company identity, then Breeze authenticates the individual user. Breeze remains the authority for organization membership and individual computer assignments.

## Customer experience and administration

- The extension manages the company gateway identity and individual Breeze customer accounts, including disablement, manual password resets, session revocation, and device assignments under Extensions → Remote Access.
- Customers use individual Breeze username/password accounts with the existing `remote_only` entitlement. Do not replace them with Authentik identities.
- Do not enable customer MFA, self-registration, email codes, or self-service account recovery. Existing administrator authentication and MFA policy remain unchanged.
- Customers receive no Breeze administrator role or general customer-portal access. A successful login with no explicit assignment returns no computers.
- Native login uses the system browser and authorization code flow with PKCE. The app API's Cloudflare transport still needs an explicit solution; do not place a shared gateway secret or embedded credential in a native binary or app bundle.
- Remote authentication does not sign the user into Windows on the target computer.

## Isolation and integration contract

Run Authentik as a separate Compose project with independently pinned images, storage, backups, and upgrade procedures. It is used only for the Cloudflare gateway; do not reuse Breeze's database or mount the Docker socket. Public ingress exposes only the required Cloudflare authentication resources; administrative operations use a private server-side API.

The extension presents administration. Its server-side integration manages the single company gateway identity and individual Breeze accounts with least-privilege credentials. Secrets and password values must never enter audit details, request logs, URLs, or browser storage. Authentik stores the gateway password; Breeze keeps its normal password handling for individual accounts.

Cloudflare's immutable issuer/subject company mapping must match the individual Breeze user's organization. Bind the mapping to an explicit organization and verify issuer, audience, signature, and expiry server-side. Never link accounts or tenants by email address, and never trust a bare forwarded email header. Cloudflare claims authenticate the company gateway; Breeze identity, `remote_only` entitlement, and device assignment remain the live authorization checks.

The integration must preserve the intentional second login step while retaining CSRF protection, account epochs, and live assignment checks. Disabling a customer, resetting credentials, or revoking the company gateway identity must invalidate relevant Breeze sessions and native admission. An existing Cloudflare session must not bypass those live checks. Deletion must first revoke access and preserve required audit/history references.

## Required rollout evidence

1. Isolated Compose startup, health, private database/admin reachability, backup restore, and pinned-version upgrade/recovery rehearsal.
2. Extension-managed company gateway identity and individual Breeze account create/reset/disable actions, unauthorized and cross-tenant denial, and safe handling of partial provider failures.
3. Cloudflare gateway login with the shared managed company identity, with no customer MFA, registration, recovery, or email OTP flow.
4. Verified two-step browser login and native system-browser PKCE flow; reject forged, expired, wrong-audience, and wrong issuer/subject company mappings.
5. Approved-computer-only listing and browser video/input; live disablement and assignment revocation stop access even with a retained Cloudflare cookie.
6. App API Cloudflare transport has an explicit, reviewed design without shared embedded secrets before native admission is enabled.

Production cutover is a separate step after this evidence. Preserve the working customer route and coordinate API/web/portal changes with other extension releases.

## References

- [Authentik Docker Compose installation](https://docs.goauthentik.io/install-config/install/docker-compose/)
- [Authentik integration with Cloudflare Access](https://integrations.goauthentik.io/security/cloudflare-access/)
- [Cloudflare generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)




## Implementation checkpoint

The API now has a default-off company gate at remote-only password login, remote
API requests (including browser renewals and native authorization), and native
code exchange. `CLOUDCOM_COMPANY_GATEWAY_ENABLED=true` requires a valid
`CLOUDCOM_COMPANY_GATEWAY_CONFIG` JSON object with `teamDomain`, `audience`, and
`companies` entries containing a unique `subject`, `orgId`, and `enabled` flag.
The subject is the verified Cloudflare Access subject, not an email or an
unverified client-supplied organization. Invalid configuration fails closed.
This temporary operator configuration is not yet the extension management API.

Seven focused suites passed 87 tests, including the existing cryptographic
Cloudflare verifier tests and new company/login/PKCE boundary tests. These do
not establish live OIDC login, native edge passage or target admission.
The isolated Compose template is in `deploy/remote-identity`; runtime validation
passed for all three containers and HTTP readiness. Existing production authentication remains unchanged.
