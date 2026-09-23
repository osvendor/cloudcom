# Cloud Command Exchange worker image candidate

This is an image and mount contract for the existing bounded Unix-socket broker. It is **not** wired into production Compose or enabled on Lightsail. Build from the repository root:

```sh
docker build -f deploy/cloudcom-exchange-worker/Dockerfile -t cloudcom-exchange-worker:qa .
```

The build fixes ExchangeOnlineManagement at 3.10.0 and rejects PowerShell below 7.6.0. Both Microsoft base images are pinned to the digests used for the GIT build on 2026-09-23; refresh those digests through a reviewed security update. Release builds must publish a signed worker image and pin that final image by digest. No certificate or tenant descriptor belongs in the image or build context.

The API process currently runs as UID 1001. The worker runs as UID/GID 1001 and resolves `--api-user cloudcom` to UID 1001. The broker accepts only a Unix peer with that UID. The API creates the tenant descriptor atomically with mode `0600`, and the worker creates the socket with mode `0660`. Use one dedicated host directory for both descriptor and socket, owned by numeric `1001:1001` with mode `0700`; bind it read-write into **only** the API and worker at `/run/cloudcom-exchange-private`. Set these API-only environment variables:

```text
CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE=/run/cloudcom-exchange-private/tenants.json
CLOUDCOM_EXCHANGE_SOCKET_PATH=/run/cloudcom-exchange-private/exchange.sock
```

The Microsoft administration configuration already contains absolute `certificatePath` and `privateKeyPath` values. The worker must see those files at the **same absolute paths** as the API, using a read-only mount of the existing certificate directory. Do not copy certificate files into the descriptor/socket mount. The worker has no published port, proxy route, or Cloudflare application. It needs outbound HTTPS to Microsoft for Exchange Online; the private Unix socket does not need an inbound firewall rule.

For a Compose candidate, add a service with the digest-pinned image, `user: "1001:1001"`, `read_only: true`, `tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, a read-write private bind mount at `/run/cloudcom-exchange-private`, and the existing certificate bind mounted read-only at its unchanged path. Add the same private bind to the API without changing the certificate mount. The socket directory must be initialized on the VM before either container starts; do not place it under a web, Caddy, Cloudflare tunnel, backup export, or public volume path. Preserve the API's current UID and verify the actual container user and mount permissions in the rendered Compose model before promotion.

The image health check sends one invalid local request and expects the broker's `invalid_request` response. It makes no tenant call and starts no PowerShell session. It accepts an absent tenant descriptor before the first Connect transaction; if a descriptor exists, it requires a regular `0600` file owned by UID 1001. A healthy container proves the socket broker is responsive, not that `Exchange.ManageAsApp`, Exchange RBAC, certificate auth, or any cmdlet works. Those need the OS CONSULTANTS live read canary before enabling Exchange UI. Department/customer connections and Graph administration remain independent.

The current worker allowlist supports `mailbox.inventory`, `mailbox.forwarding.get`, and `mailbox.forwarding.set`. The image alone does not complete the larger mailbox management menu. Do not enable write operations until the existing intent/outcome audit and readback behavior are independently accepted.
Microsoft documents that `Connect-IPPSSession` (Security & Compliance PowerShell) is unavailable from PowerShell 7 on Linux. This worker is for Exchange Online cmdlets only; it does not implement Purview/eDiscovery operations.

GIT packaging verification on 2026-09-23 built the image from a separate public-file staging directory. A read-only, non-root container imported ExchangeOnlineManagement 3.10.0 under PowerShell 7.6.6. With no tenant descriptor or network, the broker created a UID/GID `1001:1001`, mode `0660` socket in a mode `0700` private bind mount, and the local health probe returned success. A `0600` empty descriptor kept the probe healthy; changing it to `0644` made the probe fail. A wrong-UID process without DAC override could not traverse the private mount. The QA container was stopped and its image tag removed after testing because GIT has limited free disk. This does not test Exchange service authentication, Exchange RBAC, or API-to-worker Compose mounts.

Official references: [Exchange Online module version support](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2), [PowerShell container lifecycle](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-in-docker), and [app-only Exchange authentication](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2).
