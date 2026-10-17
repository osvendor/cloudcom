# OS Companion for Edge (v0.2 candidate)

## 0.4 Scripts panel

The side panel includes Scripts beside Files for Windows devices. Clear stuck print jobs first runs a read-only inspection, then requires an explicit Run and clear queue action. Execution creates a work ticket or attaches to an open ticket for the same client/device. Requests and outcomes are internal ticket comments. Recent runs are stored on the server and remain available after the panel closes.

The first script stops Print Spooler, removes direct files from the standard Windows spool directory, and attempts restart in `finally`. It reports actual deleted/failed file counts and final service state. Custom spool paths, reparse points, and subdirectories are refused. Execution requires a successful preview less than ten minutes old. Replayed request IDs cannot duplicate execution, and each preview can authorize only one execution.

Requires the companion-scripts API routes and credentials extension migration 0003. The API enforces script execution, device, and ticket permissions plus client boundaries; the browser cannot supply arbitrary PowerShell. This adds a curated script, not a general script editor. Validate cleanup with mocked services and disposable files using `scripts/clear-print-spool.test.ps1`; do not clear live print queues as an acceptance test.

This package is a staff-only, unpacked Edge extension candidate. It is not deployed or a signed Edge Add-ons release until the extension, bridge, and managed remote viewer complete verification.

The companion uses a session-scoped login flow independent of whether a Breeze tab remains open. Connect starts normal browser session sign-in; the companion bearer is held in `chrome.storage.session`, while core JWTs and credentials are not stored by the extension. The popup remembers only the non-secret Remote Tools workspace preference: Side panel or separate window.

After choosing an explicit client, Devices opens persistent workspaces for processes, services, registry, event logs, scheduled tasks, files, and terminal transport when available. Desktop launches the direct managed RustDesk link and requires a compatible managed viewer installation. Device state, staff authorization, client scope, and tenant isolation are checked again by Breeze and its bridge.

Credential fill is exact-origin and site-scoped. The selected client and site origin determine which login records are returned; the popup shows no secrets and offers individual username, password, and one-time-code fill actions. There is no automatic fill, form submission, password capture, ticket UI, offline vault, or generic API proxy. Secrets remain transient in the bridge, worker, and target field.

Build with `node build.mjs https://your-breeze.example /absolute/output`, then load the output folder through Edge Extensions → Developer mode → Load unpacked. This is a candidate implementation pending verification; no production deployment is implied.

Tests: `node --test *.test.mjs` plus the ext-credentials server and browser suites. The package does not change core authentication, Cloudflare policy, agent transport, or the Breeze deployment.

