# RustDesk Access extension — development contract

Status: transport-independent authorization contract only. Not registered, deployed,
or capable of granting production access. No device credentials are collected.
The existing native RustDesk provider remains a separate password-authenticated path.

The product target is an installed client where the user signs into Breeze and sees
approved computers. The extension will own configuration, enrollment, assignments,
and audit under **Extensions → RustDesk Access**. No changes belong in Cloud Command
or its 3CX package. Native-client login and target enforcement are separate consumers
of this extension's authorization service.

`src/authorization.mjs` defines the decision required before issuing and redeeming
a connection authorization. It receives server-owned, current account/role, device,
assignment, and enforcement facts. Its successful result is eligibility, not a
session credential. There is deliberately no production endpoint or enable switch.

Run `node --test src/*.test.mjs`. These unit tests cannot establish that a remote
client, endpoint, database, or transport enforces the contract.

See `../../docs/cloudcom-rustdesk-account-access.md` for the protocol boundary,
source evidence, phased integration, migration, and required acceptance.
