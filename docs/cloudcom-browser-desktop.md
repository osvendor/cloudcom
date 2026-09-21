# Browser desktop restoration

Status: implemented candidate; production deployment and real endpoint acceptance are required before marking verified.

The earlier Cloud Command application had a browser wrapper around the Breeze viewer. A fresh stock Breeze installation did not carry that separate application customization. This restores browser launch within Breeze itself, without the retiring server or its service credentials.

`ConnectDesktopButton` retains existing device policy, provider selection, session creation and one-time connect-code authorization. Its built-in desktop path now opens the browser viewer by default. Explicit consumers can set `viewerMode="native"` for the original protocol launcher. Configured third-party providers and the existing unavailable-desktop/VNC route are preserved.

The browser shell is isolated under `apps/web/src/components/cloudcom/browserDesktop`. No new endpoint, database migration, authentication exemption or runtime dependency is introduced. Requests remain on the website origin with Cloudflare Access cookies and the API's session-scoped capability. Codes and tokens are held in memory, not URLs or local storage. Redirects are rejected. Native window-registration calls become browser no-ops; clipboard uses browser permissions.

The viewer modules are derived from the current fork's `apps/viewer/src`, under the repository AGPL-3.0 license, using `node scripts/cloudcom/sync-browser-viewer.mjs`. The generator follows the viewer's dependency closure and applies only browser platform/network adapters plus closing cleanup. Its existing WebRTC, WebSocket/VNC compatibility paths, input handling, one-time code deduplication, and revocation leases remain intact. It excludes the desktop app updater, native runtime and old Cloud Command bridge.

On every upstream update run the generator with `--check`. Differences require review of the original viewer changes, regeneration, tests and a real endpoint check. Do not blindly copy the archived 0.114.0 viewer or deploy its old compiled bundles. The customization contract also verifies the launch attachment point.

Disconnect closes local transports immediately and retains the shell until the API reports terminal status and device-confirmed termination. HTTP 400 from a raced End is not treated as success by itself. A failed confirmation remains visible and can be retried. Leaving/reloading the page prompts the browser; server/agent revocation leases remain responsible for abrupt exits.

Validation: browser network isolation, HTML Access-login detection, launch without protocol download, duplicate launch rejection, terminal confirmation and auth failures; retained native launcher tests; upstream answer polling, API exchange, key mapping and revocation tests; production web build. Live desktop video/input and reconnect are separate acceptance gates.

Rollback: restore the previous verified web image. No data rollback is required. Keep origin Access protection and agent transport policies intact.
