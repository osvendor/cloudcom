# Cloud Command extension foundation

Initial read-only 3CX orchestration; NOT a registered or deployable extension yet.
No API endpoints, migration, credentials, live PBX calls or UI activation are included.

Each connection belongs to one partner and organization and has its own HTTPS PBX origin,
encrypted credential reference and optional department ID. The server must supply the
authorized actor/scope; the browser is not trusted to assert these values.

The service receives server-owned ports for authorization, RLS-protected connection
lookup and a readUsers transport. It rejects mismatched/disabled connections, projects
only supported user fields and handles pagination before department filtering.

Before registration: implement and test secret storage, forced RLS/migrations, audited
connection configuration, MFA, connection verification, native Breeze UI and the transport.
The transport must enforce DNS/IP egress policy (including rebinding and redirects), TLS,
timeouts, bounded response size, redacted errors and per-connection client-credentials
authentication. normalizePbxOrigin is syntax validation, NOT SSRF protection. Private PBXs
need an explicit controlled reachability policy. Never use unrestricted fetch as this port.

Do not transfer the legacy hardcoded PBX origin, organization or DEFAULT department to
source. Discover accessible departments per connection. Full PBX scope is an explicit
configuration choice; department filtering here does not prove report isolation.

Next slice: connection persistence + test-connection endpoint + native connection/list UI.
Call reports and mutations follow separately. CIPP and Google are not part of this slice.

Reference: https://www.3cx.com/docs/configuration-rest-api-endpoints/

Run foundation tests with `npm test` inside this package (Node 22+).
