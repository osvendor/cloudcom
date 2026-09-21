# Optional RustDesk integration

## Status and boundaries

The first implementation adds **Other remote tools** beside Connect Desktop on the technician Remote Tools page. It selects an existing partner-configured provider for one click; it does not change the partner default or technician preference. Configure RustDesk through Breeze's existing partner remote-access settings with `rustdesk_id` and `rustdesk://{id}`. Keep the default provider unset to retain built-in WebRTC. The endpoint still needs a configured RustDesk installation and reachable ID/relay services.

This is launcher issuance, not an embedded RustDesk browser client or completed self-service remote access. Browser transport, endpoint installation, per-user desktop assignments, native session revocation, and Cloudflare acceptance testing are pending. No CortenDesk dashboard, theme assets, or protocol code are included in this change. Deployment and real endpoint acceptance are separate from unit-test results.

## Minimal upstream integration

- `apps/api/src/routes/devices/index.ts` mounts one isolated router: `cloudcomRemoteAccess.ts`.
- `apps/api/src/services/cloudcom/remoteAccessOptions.ts` adapts upstream provider resolution without modifying it. An explicit selection has no fallback to the default.
- `apps/web/src/components/remote/RemoteToolsPage.tsx` mounts `components/cloudcom/RemoteAccessAlternatives.tsx` beside the existing button.
- Existing provider settings, secret encryption, launch URL scheme validation, and remote-access permissions are reused. No package additions, database migrations, or changes to the WebRTC session lifecycle are needed for this stage.

The two routes are `GET /devices/:id/remote-access-options` and `POST /devices/:id/remote-access-options/:providerId/launch`. Each independently requires authentication, permitted scope, `remote:access`, MFA, partner `remote_control` capability, and device organization/site access. GET returns only safe provider summaries; POST rereads provider configuration, checks the resolved scheme, returns `Cache-Control: no-store`, and audits issuance without recording the URL or credentials. An unavailable/deleted/foreign provider is denied, never substituted with another provider.

An external launcher does **not** establish a Breeze-managed session. Issuance does not prove that RustDesk connected, and Breeze's WebRTC revocation leases do not terminate an external RustDesk connection. Do not expose this technician endpoint as a portal endpoint or claim that hiding device IDs enforces remote-session authorization. Prefer per-device credentials or interactive approval; a partner-wide preset password is unsuitable for end-user self-service.

## Update protection

### Optional Windows desired-state deployment

`scripts/cloudcom/rustdesk/` supplies separate read-only probe and idempotent repair scripts for Breeze's native Script Monitor response. Attach that monitor through a Configuration Policy, initially assigned to one canary device. A native Required Software compliance rule may report inventory status separately. It does not replace the probe: inventory is asynchronous and does not establish configuration, service health, or credential readiness.

Use the existing monitor mechanism rather than patching the agent/MSI. In the pinned upstream implementation, Configuration Policy compliance's software-deploy remediation is not implemented, and script remediation requires an additional enabled standalone automation reference. Script Monitor response actions provide the supported direct wiring for this deployment.

Build standalone upload bodies with `build-upload.ps1`, supply environment-specific values outside Git, and import through Breeze's versioned script bundle interface. Preserve the mandatory device guard until promotion is explicitly scoped and tested. The customization register and Pester CI tests protect the scripts and mutation boundaries during upstream updates; repeat live Windows acceptance before promotion. See the deployment README for safeguards and outstanding acceptance requirements.

`.github/cloudcom-customizations.json` records module files and their two attachment points. The controlled upstream importer reads this contract **before** the merge and aborts if the merged tree loses one. It does not blindly restore application files over upstream fixes. CI checks the contract again and runs behavior tests/builds. A synthetic Git test covers a conflict-free update that removes an attachment and verifies rollback to the original clean checkout.

This detects deletion/disconnection, not every semantic change. An upstream change to provider schemas, authentication, site scoping, React lifecycle, or secret handling requires review and regression tests even with no Git conflict. Keep the change register current; do not pull directly into production. Rollback for this stage is the previous verified application images; it has no schema migration and does not alter provider preferences.

## Browser-client reference audit

Reference: `marcpope/cortendesk` commit `5d5470f6fd9295772ddcfdfe02c161e0d42ed87b`.

- `webclient/src/core`, `transport`, `worker`, `input`, and `media` contain separable TypeScript protocol/streaming code. `SessionConfig` is the worker boundary; the browser makes WebSocket rendezvous/relay connections and authenticates to the endpoint.
- The repository's `NOTICE` identifies the main code and protocol definitions as AGPL, while separately excluding its commercial `public/assets` admin theme from reuse outside the end product. Do not copy those theme assets. Any future code import needs exact provenance, notices, source availability, dependency review, and a reproducible build; copying the dashboard is not part of this design.
- `WebClientPageController::show` accepts a query-supplied peer ID and provides server connection settings. That controller does not implement the per-device assignment check required here. The client accepts a configured peer ID; a browser-only restriction is not an authorization boundary.
- Its `Reverse-Proxy-and-TLS` wiki documents `/ws/id`, `/ws/relay`, WebSocket upgrades, forwarded headers, and trusted proxies. It is not evidence that Cloudflare Access plus unattended/native clients have been validated together.

Sources: [repository](https://github.com/marcpope/cortendesk), [pinned NOTICE](https://github.com/marcpope/cortendesk/blob/5d5470f6fd9295772ddcfdfe02c161e0d42ed87b/NOTICE), [proxy guide](https://github.com/marcpope/cortendesk/wiki/Reverse-Proxy-and-TLS).

## Remaining implementation and acceptance

1. Package ID/relay services independently of Breeze application images and database. Pin verified image digests and keep server identity keys in protected persistent storage. Do not deploy the CortenDesk console merely to obtain its browser client.
2. Build a Breeze-styled viewer around reviewed protocol components. Serve only configured destinations; do not accept arbitrary relay URLs from browser requests. Retain server-key and peer-ID verification.
3. Introduce explicit portal-user/device grants with same-organization constraints and forced RLS. Today's portal list is organization-wide; it is not proof of ownership. Test list, CSV, launch, cross-user/cross-org denial, revocation and device organization moves.
4. Enforce assignment at session establishment and continuation, including attempts made directly from the standalone client. A launch URL, hidden menu, remembered password hash, or public server key is not a revocable authorization token. Decide the enforceable server/client mechanism before enabling end-user access.
5. Validate Cloudflare separately for interactive browser login, WebSocket upgrade, and unattended/native traffic. Do not blanket-bypass Access or silently expose origin ports to make a client work. Preserve the existing Breeze tunnel and agent rules.
6. On the designated canary, verify WebRTC is unchanged, native RustDesk connects, embedded browser control works, disconnect/reconnect works, an unassigned user is denied, revocation takes effect, and audit records distinguish issuance from an established session. Repeat these checks against each proposed Breeze/RustDesk update before promotion.

## Validation commands

```sh
node --test scripts/cloudcom/update-upstream.test.mjs scripts/cloudcom/customization-contract.test.mjs .github/scripts/cloudcom-delta.test.mjs
node scripts/cloudcom/customization-contract.mjs
pnpm --filter @breeze/api exec vitest run src/services/cloudcom/remoteAccessOptions.test.ts src/routes/devices/cloudcomRemoteAccess.test.ts src/services/remoteAccessLauncher.test.ts src/services/remoteAccessProviders.test.ts src/routes/devices/core.remoteAccessLaunch.test.ts
pnpm --filter @breeze/web exec vitest run src/components/cloudcom/RemoteAccessAlternatives.test.tsx src/components/remote/ConnectDesktopButton.test.tsx src/components/remote/RemoteToolsPage.test.tsx
```

Use the repository-pinned package manager. Mocked route tests exercise real organization/site helper logic with a simulated database and configurable auth gates; they do not replace real-DB RLS or live Cloudflare/end-to-end acceptance.

### Script-monitor response binding compatibility fix

A live stopped-service canary exposed an upstream compiler/runtime mismatch: the compiler stored both the diagnostic probe and response script in the response automation's resource bindings, while admission correctly requires bindings to match executable response actions exactly. This prevented all responses when the probe and repair were different scripts.

The compiler now validates probe ownership separately and persists only response-action bindings. Runtime authorization, tenant boundaries and device binding remain unchanged. Re-saving an existing monitor recompiles its bindings. The focused compiler regression and authorization/device-binding tests are registered in CloudCom CI and the customization contract; preserve this fix during upstream merges until upstream supplies equivalent behavior.

The deployment staging tree must be owned by SYSTEM or Administrators, reject reparse points in ancestors, and have private ACLs. New directories are created atomically with their final ACL under Windows PowerShell 5.1. Existing untrusted trees fail closed for manual recovery; repair never takes over a user-owned directory.
