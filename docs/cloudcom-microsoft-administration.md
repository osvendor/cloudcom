# CloudCom Microsoft administration

Cloud Command provides one Microsoft 365 connection per organization. Extensions → Connect is the only setup surface; the operational Microsoft page uses that connection for directory inventory and a deliberately bounded administration candidate. This is not a claim of live production completion.

## Implemented boundary

### Directory presentation

The Microsoft operational page uses a directory layout with search, resource tabs, optional columns, expandable user rows and an account drawer, styled with Breeze theme tokens. Established services are reached through the Cloud Command sidebar. The connected page omits duplicate provider navigation, routine loaded notices and the connection setup card; setup remains in Connect. Errors, partial results, loading and empty states remain visible.

Only returned inventory fields and implemented administration actions are displayed. User rows expose account details/editing; groups retain the explicit membership-change flow. Sites navigation is omitted because the native administration provider does not implement it. Mailbox classification/usage, archive/OneDrive usage, exclusions, email/alias editing and threat/message-trace navigation are not implied by this presentation. User security actions are exposed separately with explicit confirmation. Column controls change presentation only.

The current implementation supports Microsoft OAuth consent and identity completion through the authenticated extension host bridge, then stores an organization-scoped administration connection. The browser never receives a certificate, private key, access token, authorization code after callback submission, or a reusable provider credential.

Directory inventory covers users, groups, and licenses. The site search surface remains unavailable in this administration provider. Managers can edit only these user fields: `displayName`, `givenName`, `surname`, `department`, `jobTitle`, `officeLocation`, and `accountEnabled`. They can request an explicitly confirmed group membership add or removal by object ID, reset a password, and revoke the user’s sign-in sessions. Password reset generates a one-time 32-character temporary password, requires change at next sign-in, and shows the secret only in the open drawer; it is never audited. Session revocation reports acceptance and explains Microsoft propagation delay. Each operation checks its own application role at runtime, so optional security permissions do not become an extra onboarding step. User profile writes are read back and reported saved only when the returned fields match. Group changes report acceptance; membership verification remains pending unless a future provider response supplies a bounded member list.

The UI and server both enforce organization context and manager authorization. Mutations additionally require the interactive authorization/MFA checks in the host. Dispatched writes have no automatic retry. A rejected request or a write whose outcome cannot be established must be reconciled by reading the affected Microsoft object.

The implementation does **not** provide Exchange administration, Teams administration, SharePoint or OneDrive administration, content search, export, a generic CIPP action runner, bulk writes, or arbitrary Graph operations. These boundaries apply even when a related Microsoft application permission exists.

## Protected host configuration

The API host reads only the absolute path named by `CLOUDCOM_MICROSOFT_ADMIN_CONFIG_FILE`. Keep that environment value and the referenced descriptor out of source control, web assets, extension manifests, logs, and browser requests. A generic descriptor shape is:

```json
{
  "clientId": "00000000-0000-0000-0000-000000000000",
  "credentialVersion": "rotation-2026-01",
  "certificatePath": "/run/secrets/microsoft-admin-certificate.pem",
  "privateKeyPath": "/run/secrets/microsoft-admin-private-key.pem",
  "redirectUri": "https://your-cloudcom.example/extensions/cloudcommand/connect"
}
```

The paths must be absolute and host-controlled. The redirect URI must be HTTPS and exactly the Cloud Command Connect callback path, without credentials, query parameters, or a fragment. The certificate and PKCS#8 private key are loaded only by the API host to create short-lived certificate assertions for fixed Microsoft endpoints. Rotating the descriptor's `credentialVersion` disables old stored bindings until the organization reconnects; it is not a browser-side migration.

## Persistence and tenancy

The existing Entra app registration must include the exact Web redirect URI and emit directory roles in ID tokens (`groupMembershipClaims: DirectoryRole`, unless an existing broader group-claim configuration already includes roles). Connect validates the signed `wids` claim for an active Global Administrator or Privileged Role Administrator. Configuring this identity claim does not grant additional Graph permissions.

`packages/ext-cloud-command/migrations/2026-09-22-native-admin-connections.sql` is additive. It creates:

- `cloudcommand_microsoft_admin_connections`, one connection per organization and one organization per tenant;
- `cloudcommand_microsoft_admin_consent`, short-lived, actor-bound consent state with an encrypted verifier.

Both tables use enabled and forced RLS. Connection rows use `breeze_has_org_access(org_id)`; consent rows additionally bind `actor_id` to `breeze_current_user_id()`. Foreign keys cascade with organization/user removal. Apply the migration through the normal migration runner and validate as `breeze_app`, including an attempted cross-organization read/write denial. Do not edit the shipped migration; use a new forward migration for any schema correction.

## Rollback and recovery

Disable the extension or roll back the application image to remove the UI and host routes. Existing connections can be disabled through the bounded disconnect action; do not delete or hand-edit consent/verifier rows during an active authorization callback. Image rollback does not reverse the additive tables, and the tables are intentionally retained because they may contain audit-relevant connection state. A later schema rollback requires an explicit, reviewed forward migration after pending callbacks have expired. Revoke or rotate the Microsoft application certificate separately when host credential compromise is suspected, then change `credentialVersion` and reconnect affected organizations.

## Validation status

Current automated coverage includes the extension server services, Microsoft administration runtime/authorization, onboarding, execution/provider boundaries, web Connect callback handling, and user/group drawer behavior. Required deployment validation remains separate: apply the migration to a disposable database, verify RLS as the application role, configure an isolated Microsoft test tenant, complete consent, test manager and non-manager paths, reconcile a controlled write, and record the deployed revision privately. No production tenant, credential, consent, or live completion result is represented by this document.
