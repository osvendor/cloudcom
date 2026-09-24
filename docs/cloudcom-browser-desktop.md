# Browser desktop restoration

Status: deployed through PR #5 (merge `35b4c1ee842e8d9e95a6f8fde3cfbc187dd7a75a`). Controlled Windows endpoint acceptance on 2026-09-21 verified browser video, mouse and keyboard input, confirmed disconnect, and a fresh connection. This does not establish long-duration reliability or recovery from a network outage.

The earlier Cloud Command application had a browser wrapper around the Breeze viewer. A fresh stock Breeze installation did not carry that separate application customization. This restores browser launch within Breeze itself, without the retiring server or its service credentials.

`ConnectDesktopButton` retains existing device policy, provider selection, session creation and one-time connect-code authorization. Its built-in desktop path now opens the browser viewer by default. Explicit consumers can set `viewerMode="native"` for the original protocol launcher. Configured third-party providers and the existing unavailable-desktop/VNC route are preserved.

The browser shell is isolated under `apps/web/src/components/cloudcom/browserDesktop`. No new endpoint, database migration, authentication exemption or runtime dependency is introduced. Requests remain on the website origin with Cloudflare Access cookies and the API's session-scoped capability. Codes and tokens are held in memory, not URLs or local storage. Redirects are rejected. Native window-registration calls become browser no-ops; clipboard uses browser permissions.

The viewer modules are derived from the current fork's `apps/viewer/src`, under the repository AGPL-3.0 license, using `node scripts/cloudcom/sync-browser-viewer.mjs`. The generator follows the viewer's dependency closure and applies only browser platform/network adapters plus closing cleanup. Its existing WebRTC, WebSocket/VNC compatibility paths, input handling, one-time code deduplication, and revocation leases remain intact. It excludes the desktop app updater, native runtime and old Cloud Command bridge.

On every upstream update run the generator with `--check`. Differences require review of the original viewer changes, regeneration, tests and a real endpoint check. Do not blindly copy the archived 0.114.0 viewer or deploy its old compiled bundles. The customization contract also verifies the launch attachment point.

Disconnect closes local transports immediately and retains the shell until the API reports terminal status and device-confirmed termination. HTTP 400 from a raced End is not treated as success by itself. A failed confirmation remains visible and can be retried. Leaving/reloading the page prompts the browser; server/agent revocation leases remain responsible for abrupt exits.

Validation: browser network isolation, HTML Access-login detection, launch without protocol download, duplicate launch rejection, terminal confirmation and auth failures; retained native launcher tests; upstream answer polling, API exchange, key mapping and revocation tests; production web build. Live desktop video/input and reconnect are separate acceptance gates.

Rollback: restore the previous verified web image. No data rollback is required. Keep origin Access protection and agent transport policies intact.

## Required concurrent access (not implemented)

Multiple independently authorized users must be able to connect to the same computer at the same time. Joining, reconnecting, or leaving must not terminate another user's connection. This means sharing the same desktop; it does not promise separate Windows logon sessions.

Current blockers are explicit: `apps/api/src/routes/remote/sessions.ts` terminates all existing device/type sessions during creation, and `agent/internal/remote/desktop/session_webrtc.go` stops all desktop sessions before starting another. The agent restriction protects its GPU/Desktop Duplication capture pipeline. Removing these guards alone is not a safe implementation.

The implementation must share capture/encoding for an exact desktop target while retaining separate peer connections, authorization, revocation leases, audit attribution, input permissions, clipboard policies and termination for every viewer. Use bounded per-viewer queues so a slow peer cannot stall others. Define monitor/quality control ownership and key-release behavior before allowing shared control. Revoke and disconnect only the affected viewer; release shared resources after the last viewer exits. Preserve terminal behavior unless separately designed. Deploy the agent support before relaxing the server guard.

Acceptance must cover two distinct user identities, concurrent joins, one leaving while the other continues, duplicate delivery/reconnect, slow viewers, revocation and lease expiry, cross-organization denial, clipboard restrictions, input cleanup, and final capture-resource release. Agent race tests and a signed canary agent build are required before live enablement. Retest after upstream capture, session, or authorization changes. This requirement applies to the optional RustDesk path as well; support there must be independently verified.
