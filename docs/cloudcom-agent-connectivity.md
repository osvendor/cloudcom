# CloudCom agent connectivity diagnostics

## Scope and current candidate

The agent uses bearer-authenticated HTTPS heartbeats and a bearer-authenticated
WebSocket at `/api/v1/agent-ws/<agent-id>/ws`. Browser login success does not prove
that these machine paths work. Retain the Cloudflare Tunnel, private origin,
TLS verification and application authentication throughout troubleshooting.

The reconnect candidate fixes an independently identified retry defect: a
successful upgrade followed by immediate close previously bypassed the failed-dial
backoff. It also retains the numeric HTTP status of failed handshakes without
logging response bodies, cookies, authorization headers or redirect locations.
An upgrade completing after Stop is rejected before its socket can be retained.
Shutdown during retry waits is interruptible; a stalled in-progress handshake
still has the existing ten-second timeout, not immediate cancellation.
This is not proof of the cause of a historical outage. Validation and deployment
state belong in the PR and private operational record; do not assume a source
change has been published as a signed agent release.

## Collect evidence before changing configuration

Record UTC timestamps, device ID, agent version and network context. Correlate
agent connection/retry messages, successful HTTPS heartbeat times, API route
status and WS lifecycle messages, and cloudflared connection/origin errors.
Capture a Cloudflare Ray ID for a rejected request. Never copy credentials,
cookies, enrollment keys or complete redirect/query strings into reports.

Use `journalctl -u cloudflared --since <UTC-start> --until <UTC-end>` on a
systemd-managed connector. Review output locally and redact before sharing;
tunnel logs can contain URLs and configuration. Read the connector's private
metrics endpoint for active connections and request-error counters. Cumulative
counters are not per-device incident evidence; compare deltas over the same
window. A service restart count is not proof of ongoing restart churn.

Distinguish these events:

- `connect: connection refused` to the local origin means the origin listener
  was unavailable. Inspect Caddy/container availability at that timestamp.
- A QUIC transport timeout or repeated tunnel-registration loss concerns the
  connector-to-edge link. Only then consider a measured, reversible HTTP/2 trial.
- An Access redirect or browser challenge on an agent route concerns the edge
  policy; inspect the matching Access/WAF event before changing it.
- An application401/403 concerns the agent identity, token lifecycle or mTLS
  binding. Do not weaken authentication to turn it into101.
- An HTTP101 followed by close is a different failure from a rejected handshake.
  Record the close code, connection lifetime and subsequent retries.

Current timing: agent protocol ping54s/read deadline60s; server JSON ping30s,
pong-age threshold40s checked each interval; default REST heartbeat60s and
offline-detector threshold5min. WebSocket-close status and REST heartbeat status
can disagree. Inspect both before diagnosing an unreachable host.

## Private path comparison

Use the same route/method and identity at each layer:

1. Isolated loopback test server: reproduces agent recovery without Cloudflare.
2. API inside the private container network: checks application behavior.
3. Caddy through localhost over SSH: adds the reverse proxy. Match the actual
   trusted HTTPS-forwarding context; plain HTTP can correctly redirect under
   HTTPS enforcement. Never trust forwarded headers from arbitrary clients.
4. Normal public hostname through Cloudflare: adds edge, tunnel and client network.

Unauthenticated negative probes should remain rejected by Breeze; they do not
prove authenticated WebSocket establishment. Never publish the origin or create
a global Access/WAF bypass for this test. Agents do not currently send Cloudflare
service-token headers. Preserve dashboard Access and use only a supported,
narrow machine route policy backed by Breeze authentication. A separate hostname
also needs an explicit route allowlist; a hostname by itself is not an auth boundary.

## Canary acceptance and recovery

Use one or two newly enrolled test devices. Keep their currently verified signed
binary and configuration available for rollback. Do not distribute a candidate
fleet-wide or bypass signed-update trust to install it.

First establish normal WS101, command response and heartbeat continuity. Interrupt
only a canary connection, then verify automatic recovery without a service restart,
bounded retry frequency and no duplicate active socket. Exercise clean close,
abrupt loss, transient handshake502, authentication403, network/DNS failure and
shutdown while retrying in an isolated harness. Check a nonresponsive socket is
closed by its read deadline. A successful short connection must not reset the
backoff and create a tight retry loop.

Observe normal traffic after reconnect and compare WS presence with HTTPS
heartbeat/device status. Capture recurrence timestamps before further changes.
Rollback restores the previous verified agent binary and restarts only the canary
service; this candidate needs no database or Cloudflare-policy migration.

References: [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/),
[Breeze tunnel deployment](../apps/docs/src/content/docs/deploy/cloudflare-tunnel.mdx).
