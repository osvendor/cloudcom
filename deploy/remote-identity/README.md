# Remote identity deployment template

This directory is an isolated Authentik deployment for CloudCom remote identity.
It runs Authentik `2026.8.3` and PostgreSQL `16-alpine`, both pinned by
multi-architecture manifest digest, with a dedicated PostgreSQL data volume. It has no
Docker socket mount, no database host-port, no outpost, and no public listener.
The only published port is Authentik HTTP on loopback, for the existing private
reverse proxy and Cloudflare path to reach. This template does not modify the
existing Breeze deployment, Cloudflare configuration, or Authentik objects.

## Prepare and start

For a fresh installation only (never overwrite existing secret files), copy `.env.example` to `.env`, create the two
secret files named there, and restrict them to the deployment operator. Do not
commit `.env` or either secret file.

```sh
cd deploy/remote-identity
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
umask 077
openssl rand -base64 36 | tr -d '\n' > secrets/postgresql_password
openssl rand -base64 60 | tr -d '\n' > secrets/authentik_secret_key
# The pinned Authentik image runs as UID 1000. Keep the parent directory private.
sudo chown 1000 secrets/postgresql_password secrets/authentik_secret_key
chmod 400 secrets/postgresql_password secrets/authentik_secret_key
docker compose --env-file .env -f compose.yml config
docker compose --env-file .env -f compose.yml up -d
```

`AUTHENTIK_HTTP_PORT` changes only the port; the template fixes the bind address
to `127.0.0.1`. Do not change it to a public address.
PostgreSQL is available only on the Compose network.

The reverse proxy must forward the original `Host`, `X-Forwarded-Proto`,
`X-Forwarded-For`, and WebSocket upgrade headers. Authentik 2026.8 only honors
these headers from trusted proxy networks. The default trust list covers common
Docker private networks. This template narrows that default to loopback; set
`AUTHENTIK_TRUSTED_PROXY_CIDRS` in `.env` to only the proxy's direct source
network after verifying that address. Do not include customer networks.

Verify the stack with `docker compose --env-file .env -f compose.yml ps` and
the proxy path with `/-/health/ready/`. The server readiness endpoint verifies a
PostgreSQL connection; the worker health check runs `ak healthcheck`.

## Initial setup and owner handoff

Open the root URL of the configured Authentik hostname through the private proxy
and follow its setup redirect. The pinned release rejects a direct uninitialized
`/if/flow/initial-setup/` visit. Set the initial
`akadmin` password interactively and store it in the approved credential store.
Then create at least one separately held break-glass administrator and confirm
both admin sign-ins before handing the service to the owner. Retain the two
secret files and database volume for backup and recovery; changing the Authentik
secret key invalidates active sessions. Use the currently reachable private Base
URL during staging; change it to the verified public identity hostname at cutover.

For this deployment, Cloudflare is used with **password-only SHARED COMPANY
accounts**. Create only the explicitly approved company accounts and use the
normal password login flow. Individual Breeze accounts remain separate and are
not imported, linked, or replaced by this deployment. Do not configure customer
MFA, customer self-signup, customer password recovery, invitations, or account
provisioning here. This template intentionally includes no blueprints or flows,
so those decisions remain an explicit follow-up configuration task.

## Version and source references

- Authentik Compose baseline: <https://goauthentik.io/version/2026.8/lifecycle/container/compose.yml>
- [Docker Compose installation](https://docs.goauthentik.io/install-config/install/docker-compose/)
- [Configuration and secret-file loaders](https://docs.goauthentik.io/install-config/configuration/)
- [Reverse proxy requirements](https://docs.goauthentik.io/install-config/reverse-proxy/)
- [Monitoring and health checks](https://docs.goauthentik.io/sys-mgmt/ops/monitoring/)
- [2026.8.3 release notes](https://docs.goauthentik.io/releases/2026.8/)
