# Cloud Command Exchange worker contract

Status: first read-only implementation slice exists in the Cloud Command extension. It is not deployed or enabled until the private sidecar, socket mount, descriptor mount, and Exchange app-only capability probe are validated.

## Purpose

The Cloud Command directory needs Exchange recipient type, mailbox/archive usage, primary SMTP and aliases, delegation, forwarding and automatic replies. The current Breeze API image runs Node on Alpine and has no PowerShell runtime. Cloud Command's retained implementation used `exchange-persistent.ps1` behind a bounded local broker. Microsoft supports the Exchange Online PowerShell module on PowerShell 7 for Linux. Its newer Exchange Online Admin API is currently Preview and is not available in every organization, so availability must be measured before it can replace the PowerShell path.

Run a dedicated Exchange Online PowerShell worker on the existing application VM, isolated from the public reverse proxy. Keep the Cloud Command extension as the only browser entry point. The worker is not another tenant database or a second application login.

## Request path and ownership

Browser -> authenticated Breeze extension route -> organization-bound administration service -> fixed Exchange operation -> local worker -> Exchange Online. The Breeze service owns authorization, tenant lookup, connection generation checks, intent/outcome audit, rate limits and result projection. The worker owns PowerShell sessions, command/parameter allowlists, connection reuse, timeouts and bounded response parsing. Only the API process can reach its local socket; no public port or Cloudflare rule is needed.

Each dispatch contains a server-issued request ID, the authorized organization ID, bound tenant ID, app ID, credential version and connection generation, a fixed operation name, and typed parameters. The browser can never supply an Exchange tenant, app, certificate path, cmdlet string or arbitrary PowerShell expression. The worker validates the target tenant and certificate binding against its host-only descriptor before connecting. The API checks the connection and actor permission immediately before dispatch and again before returning a result. A changed connection makes the result unusable and marks a dispatched write as uncertain.

The worker should use a fixed registry rather than accepting the Cloud Command source's broad `command` string interface. Initial entries:

| Operation | Permitted PowerShell action | Result |
| --- | --- | --- |
| `mailbox.inventory` | `Get-EXOMailbox`, `Get-EXOMailboxStatistics` | Bounded pages with type, size, archive status, collected time and per-mailbox errors |
| `mailbox.get` | `Get-Mailbox` | Selected SMTP, alias, forwarding, policy and recipient properties |
| `mailbox.primary.set` | `Set-Mailbox -WindowsEmailAddress` | Accepted, then independent `Get-Mailbox` readback |
| `mailbox.alias.add/remove` | `Set-Mailbox -EmailAddresses` | Accepted, then address-list readback |
| `mailbox.delegation.get/set` | `Get/Add/Remove-MailboxPermission`, `Get/Add/Remove-RecipientPermission`, `Set-Mailbox -GrantSendOnBehalfTo` | Current delegates and per-right outcomes |
| `mailbox.forwarding.get/set` | `Get/Set-Mailbox` forwarding properties | Current destination and keep-copy setting |
| `mailbox.autoreply.get/set` | `Get/Set-MailboxAutoReplyConfiguration` | Current mode, schedule, internal/external replies |

For writes, make an intent audit durable before worker submission and record one terminal outcome: verified success, definite rejection, or uncertain. Never automatically replay a request after a timeout or connection loss. A readback mismatch reports pending/uncertain and offers refresh; it does not treat acceptance as completion. Multi-step changes (such as delegation or mailbox preservation) need a durable job record with per-step checkpoints before being exposed.

## Access and deployment

Use a non-root worker user and a local Unix socket mounted only into the API container. Restrict socket permissions to the two service identities and enforce peer identity at the worker. Do not expose the socket through Caddy, the tunnel or host firewall. Mount only the certificate material required for Exchange into the worker; never include it in images, Git, web bundles or logs. A health check should prove the worker is responsive without making a tenant call. Limit concurrent sessions and queue length; idle sessions expire and any tenant switch creates a fresh session.

The worker's host-only tenant descriptor is a deployment binding, not a second customer setup step. The single Extensions → Connect transaction must provision or refresh it from the already verified organization connection, and disconnect or credential rotation must revoke it. A worker build that relies on manually editing a tenant JSON file is not ready for customer use. Treat write failures or uncertainty during descriptor synchronization as an Exchange capability that needs attention while leaving the Graph connection intact; never silently route to a stale tenant binding.

The implementation uses `CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE` and `CLOUDCOM_EXCHANGE_SOCKET_PATH` only inside the API host. When both are configured, the host creates the local descriptor from the protected Microsoft application certificate already used by Connect; it serializes atomic descriptor updates with mode `0600`. Exchange's `-Organization` value must be the tenant's initial `.onmicrosoft.com` domain, not its GUID. The API resolves that domain from Microsoft Graph `/organization` using the same tenant-bound application credential, checks the returned tenant ID and initial-domain marker, and fails descriptor provisioning closed on mismatch. The descriptor path and socket must be private shared mounts between the API and worker. The current API image runs as non-root UID `1001`; a worker using the API-written `0600` descriptor must run with that same numeric UID inside a separate container and private mount, or the descriptor format/permissions must be changed with a tested group-based model. The Unix socket broker also checks that peer UID, so its configured API username must resolve to `1001` in the worker. None of these identity or mount assumptions has been verified in a deployed worker yet. Their absence leaves Graph administration working and keeps Exchange unavailable. These settings are deployment-only and must never appear in an extension response, UI field, repository secret, or Cloudflare configuration.

Microsoft requires `Exchange.ManageAsApp` and an appropriate Exchange/Entra RBAC role for app-only PowerShell. The existing Microsoft connection should report Exchange capability independently from Graph. A successful Graph consent or token does not prove Exchange cmdlet authorization. Probe the needed read cmdlets per tenant and report permission denial plainly. Use the tenant's existing registered application only if its certificate and Exchange RBAC binding are verified. Any permission change remains part of that single Connect setup and must not require the customer to manage a second CIPP-style onboarding flow.

## Validation

Unit tests must reject arbitrary operation names/parameters, foreign tenants, stale connection generations, mismatched certificates, overlong responses, malformed provider data and unauthorized actors. Integration tests run against a disposable worker and fake PowerShell process, then a real module canary on the Linux GIT VM. Live reads use OS CONSULTANTS first. Live writes use only isolated test mailboxes, restore captured baseline and verify it independently. Validate the signed application release, updated Compose model, socket permissions, migration state and browser controls before enabling the capability.

References: [Microsoft Exchange Online PowerShell app-only authentication](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2), [Exchange Online Admin API preview status](https://learn.microsoft.com/en-us/exchange/reference/admin-api-get-started), and the retained Cloud Command `connector_broker.py` / `exchange-persistent.ps1` source (private task workspace).
