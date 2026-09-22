# Cloud Command provider extension

Compiled-in Breeze extension, default off (`CLOUDCOM_THREECX_ENABLED=true` opts in).
See [implementation and operations](../../docs/cloudcom-threecx.md).

The optional [Microsoft 365 adapter](../../docs/cloudcom-microsoft365.md) uses Breeze’s
native Microsoft services for users, groups, licenses and SharePoint site inventory.
It requires a configured native read executor and an authorized organization connection.
CIPP is a feature/source reference only; no CIPP instance is required.
Provider navigation follows the selected organization's connection and permissions.
This is not full CIPP feature parity.

The first slice supports per-organization credentials, connection verification,
explicit department or whole-PBX scope, and a read-only extension directory with
a details drawer. It does not change PBX configuration, calls, users, or routing.

Server-owned transport uses Breeze's public-only DNS-pinned HTTPS egress guard.
The web component uses a revocable host API bridge; it never reads login tokens.
Credentials are encrypted with organization-bound AAD and excluded from exports.

Run `pnpm --filter @cloudcom/ext-cloud-command typecheck`, `build:web`, `test`,
`test:server`, and `test:web`. `bash scripts/cloudcom/test-threecx-rls.sh` from the
repository root creates a disposable local database and verifies real forced RLS.
The runtime bundle, manifest and migrations must ship with the same API release.
