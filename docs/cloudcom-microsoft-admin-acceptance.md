# Microsoft administration acceptance

## Target and implementation boundary

Acceptance covers reads and writes across the eligible, non-premium portion of the CIPP-derived feature ledger, not only directory inventory. Existing administrative certificates and grants may be reused by an isolated administration executor where verified compatible. The dedicated upstream customer-graph-read and customer-graph-actions profile manifests must not be silently widened or bypassed.

A new extension-owned administrative executor needs a fixed, versioned operation registry, organization-to-tenant resolution on the server, independent role and MFA checks, tenant-bound job context, secure certificate storage, bounded execution, result redaction and durable operation/audit records. The browser cannot submit raw Graph URLs, arbitrary command names or credentials. Existing action-intent semantics must be retained when reusing an upstream mutation.

CIPP remains the source reference for operation coverage. Microsoft is the live provider. No CIPP instance is required. A full administration test is not evidence that every CIPP feature has already been implemented.

## Menu scope

Apply [the Microsoft menu scope](cloudcom-microsoft-menu-scope.md) before importing any CIPP menu, detail tab, drawer action or dashboard card. Premium-only features are excluded from acceptance rather than blocked prerequisites for release.

## Evidence layers

1. **Credential capability:** tenant identity, token/Exchange authorization, actual provider operations on disposable fixtures, independently read back and cleaned up.
2. **Executor correctness:** exact operation/input validation, organization fencing, timeout/unknown-result handling, per-item outcomes, no cross-tenant certificate/context reuse, stable idempotency where supported.
3. **Breeze authorization:** reader cannot mutate; correct administrative role/MFA/intent policy; denied organization/site sessions cannot execute; disabled integration prevents both UI and direct API calls.
4. **UI acceptance:** native Breeze tables/drawers/forms, required validation, clear permission/license restrictions, visible success/failure/partial states, current organization binding and stale-response rejection.
5. **Recovery:** cleanup and reconciliation; a provider success response alone is insufficient proof of completed propagation.

## Administration test matrix

| Area | Live fixture operations | Prerequisites / limits |
| --- | --- | --- |
| Users | Create two disabled cloud-only users; edit attributes; reset password; unblock/block with read-back; assign/remove manager; delete owned fixtures | API password-reset acceptance is distinct from interactive sign-in verification. Passwords never enter logs. |
| Sessions and MFA | Revoke test-user sessions; query and, where supported, manage test authentication methods | An empty test account cannot demonstrate invalidation of an existing session. Authentication-policy writes must not target organization defaults. |
| Groups | Create/edit security group; add/read/remove members and owners; delete fixture | Use explicit `$ref` relationship deletion, never delete the referenced user. Test bulk partial outcomes separately. |
| Licenses | Query availability; assign/remove an existing eligible spare license on a disposable user; verify assignment and removal | No license purchase. Report no spare entitlement as a prerequisite, not a code pass. Provisioning can be asynchronous. |
| Mailboxes | Create disposable shared mailboxes; read/edit aliases and visibility; configure test-only forwarding and auto-reply; add/remove FullAccess, SendAs and SendOnBehalf; delete fixtures | Requires verified Exchange application permissions and role assignments. Do not infer Exchange authorization from Graph roles. |
| Distribution groups | Create/edit fixture distribution group; add/read/remove fixture mailbox member; remove group | Separate Exchange-backed behavior from Graph security/Microsoft 365 groups. |
| Mail flow and quarantine | Query bounded test-related trace/quarantine views; exercise handling only on controlled test messages | Sending mail or releasing real quarantined mail is not a test substitute. Record unavailable fixtures explicitly. |
| SharePoint/OneDrive | Query test sites/drives; create/edit/delete only test content; validate permissions/shortcuts separately | Requires applicable grants, provisioned sites/drives and licenses; native site search is not storage-report parity. |
| Teams | Create/configure test team and test membership/channel where supported; clean up | Validate Teams-specific grants, asynchronous provisioning and licensing. Group permission alone is not assumed sufficient. |
| Roles | Query authorized role surface; validate operation eligibility and denials | Broad grant presence is not authorization to assign privileged production roles. Elevated-role tests need a controlled test principal and a defined restoration case. |
| Jobs/bulk actions | Cancellation, throttling, retry, partial success and ambiguous timeout cases | Do not blindly retry non-idempotent writes; reconcile provider state first. |

## Test resource ownership and cleanup

Use a unique run ID and persist returned object IDs immediately in a private manifest. Before every mutation/cleanup, verify both the selected tenant and ownership of the exact fixture ID. Never delete by a broad name wildcard. Poll reads with a bounded deadline to accommodate Microsoft propagation; keep `accepted`, `verified`, `failed`, `pending` and `not tested` distinct. Report active-object cleanup separately from any provider soft-delete retention.

## Source anchors

- [Pinned CIPP user/group/backend map](cloudcom-microsoft-source-map.md).
- [Microsoft user creation](https://learn.microsoft.com/en-us/graph/api/user-post-users?view=graph-rest-1.0).
- [Microsoft user updates](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0).
- [Group membership](https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0).
- [Exchange application authentication and authorization](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2?view=exchange-ps).
- [Microsoft licensing and premium-feature exclusions](cloudcom-microsoft-menu-scope.md).

Per-run identities, object IDs, grants and deployment addresses belong in private evidence, never this public document. This matrix is a delivery/acceptance plan; it is not a claim that these operations have all passed or are available in the extension today.
