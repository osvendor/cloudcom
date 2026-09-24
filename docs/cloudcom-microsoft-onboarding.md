# Single Microsoft 365 onboarding flow

## Required experience

Extensions > Connect > Microsoft 365 is the single customer-facing onboarding and maintenance location. This requirement supersedes earlier instructions to send operators to Integrations or configure independent read and administration connections. The current Connect tab only links to `/integrations#m365`; it does not yet meet this requirement.

An operator selects the Breeze organization, connects its Microsoft tenant and completes required Microsoft administrator consent/role steps in this flow. The application then validates tenant identity, securely stores or reuses credentials, provisions supported provider prerequisites and tests the included capabilities. Administrators must not repeat tenant IDs, certificate configuration or consent separately for Users, Groups, Exchange, Teams, SharePoint or Content search/export.

## Ownership and compatibility

One logical Microsoft connection owns the organization's verified tenant and capability state. Internal executor profiles may remain separate for security and upstream compatibility, but the onboarding orchestrator coordinates them; they are not separate customer onboarding requirements. Preserve native profile manifests rather than weakening a read-only profile to accept broad credentials. Reuse existing compatible administrative credentials through an isolated administration executor. No CIPP instance is required.

Keep orchestration and any new state extension-owned. Reuse Breeze organization, permissions, MFA, secrets and audit interfaces through small versioned host bridges. Avoid duplicate active tenant mappings. Any new tenant table needs a forward migration and forced RLS.

## State and recovery

Expose Not connected, Awaiting administrator consent, Configuring, Needs attention and Ready. Persist per-capability results behind a single connection summary. A successful login/token or directory read is not readiness for every administration surface. Show precise failed steps with retry in Connect. Do not advertise an unsupported capability as available.

Use bounded, idempotent provisioning and reconcile uncertain results. On reconnect verify the same tenant; an intentional tenant change requires explicit rebind semantics and invalidates old jobs/results. Disconnect or consent revocation must disable all dependent operations. Recheck identity, organization access and credential generation at execution and result-delivery boundaries.

Microsoft-required administrator consent or role grants cannot be silently bypassed. Guide those necessary actions within this flow; do not require a second connection. Do not buy licenses, enable consumption billing or request excluded premium permissions. Business Standard scope applies, with basic content search/export retained as a requirement and its automation gap reported accurately.

## Acceptance

Test first connection, existing credential reuse, consent denial/cancel, wrong-tenant response, partial provisioning, retry, token/certificate expiry, revocation, reconnect and cross-organization denial. Verify that all enabled administration pages use this connection without additional setup. Preserve 3CX, Google and remote-access configuration. Use the Linux test VM and the authorized internal test tenant; separate provider capability evidence from end-to-end Breeze acceptance.

Status: the first inline readiness panel and recheck routes are implemented in the extension. They do not provision administrative executors or start consent yet. The start endpoint returns an explicit unavailable error; inventory verification never marks full administration Ready. Unified onboarding remains incomplete until the provisioning, consent and end-to-end acceptance work above passes.
