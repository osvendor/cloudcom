# RustDesk Access extension — development contract

Status: registered administration extension with organization settings and per-device
portal assignments. Browser access is implemented behind the remote access feature
gate. Managed native admission remains unfinished. No device credentials are collected.
The existing native RustDesk provider remains a separate password-authenticated path.

The product target is an installed client where the user signs into Breeze and sees
approved computers. The extension owns settings, assignments and audit under
**Extensions → Remote Access**; native enrollment remains planned. No changes belong in Cloud Command
or its 3CX package. Native-client login and target enforcement are separate consumers
of this extension's authorization service.

`src/authorization.mjs` defines the decision required before issuing and redeeming
a connection authorization. It receives server-owned, current account/role, device,
assignment, and enforcement facts. Its successful result is eligibility, not a
session credential. `src/server/index.ts` provides the separately authorized settings
and assignment endpoints; native connection admission is not enabled by these routes.

Customer invitations support a **Remote access only** restriction from account
creation. Accepting an invitation preserves that restriction. Until an administrator
assigns a computer in this extension, the customer has no remote computers available.
Re-inviting an account never removes an existing remote-only restriction.

Run `node --test src/*.test.mjs`. These unit tests cannot establish that a remote
client, endpoint, database, or transport enforces the contract.

See `../../docs/cloudcom-rustdesk-account-access.md` for the protocol boundary,
source evidence, phased integration, migration, and required acceptance.
