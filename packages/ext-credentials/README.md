# Client credentials

First-party extension, default off (`CLOUDCOM_CREDENTIALS_ENABLED=true` opts in).
Search and secret access require an explicit organization or an owned active
desktop session whose client is resolved on the server. Supports imported
credential metadata, password reveal, TOTP generation and a browser remote-session
toolbar picker. The sibling Documentation page provides encrypted, client-scoped
IT Glue workbook previews and original downloads. Editing, password rotation and
browser autofill are not yet provided. Native document uploads remain in core Documents.

## Security contracts

- `credentials:read`, `credentials:reveal`, `credentials:otp` and
  `credentials:import` are independent grants. No non-wildcard role receives
  them automatically. Organization-wide authority is required; site-limited
  principals cannot access an organization-wide vault.
- Gateway authentication, active organization/partner checks, explicit SQL
  organization predicates and forced RLS all apply. There is no global search.
- Passwords, OTP seeds and notes are stored together as v3 AES-GCM ciphertext,
  using core key management and row-bound AAD. The encrypted payload also
  verifies organization identity. Database identity/organization reassignment
  is prohibited. Key rotation is registered in the core encrypted-column registry.
- The strict core audit sink must commit before a password or code is returned.
  The default SDK audit sink retries failures and is deliberately insufficient
  for this operation. Audits contain IDs/counts only.
- Mutation paths enforce the gateway MFA-policy claim; this is not a fresh
  per-reveal second-factor challenge. Do not describe it as step-up authentication.
- The web component clears secrets on client changes, searches and unmount;
  rejects late responses; hides passwords after 30 seconds and codes on expiry.
  Imported links permit only HTTP(S). Secrets never enter browser storage.
- No public/agent routes, AI tools, jobs or generic export of encrypted values.

## Import

Use the root `passwords.csv` from an IT Glue export. Do not extract or execute
unrelated archive attachments. The parser accepts at most 10 MB/10,000 records
for local preflight. HTTP/operational batches are deliberately smaller: one
explicit source organization, at most 1,000 rows and 500,000 CSV characters,
also subject to the core HTTP byte limit. Split larger imports.

The `one_time_password` column is an enable flag (Yes/No); the reusable seed is
`otp_secret`. A code or Yes flag without a seed is held for correction. Password
whitespace and multiline notes are preserved. Missing usernames are warnings;
invalid seeds, missing identities and malformed records block committing.

Mappings are explicit, source-name exact, with no fuzzy/default destination.
Excluded clients are removed before transmission. Preview reports only counts
and source organization labels. Re-import never overwrites an existing source
record. Client batches commit atomically; import audits identify attempts.

The operator CLI is `node dist/scripts/credentials-import.cjs [--dry-run]`.
It accepts a base64 JSON envelope through stdin, never arguments or a log:
`{partnerId,batches:[{organizationId,organizationName,sourceOrganization,csv}]}`.
It validates current destination IDs, names and partner membership, uses the
unprivileged application connection with explicit RLS context, and records
system/operator audit events. Dry-run verifies encryption without saving records.
Retain the existing key backup/recovery procedure; never put export files or
production secrets in this package or test fixtures.

## Documentation import

`scripts/cloudcom/import-itglue-documentation.py` inventories XLSX attachments
in an IT Glue ZIP without extracting files or executing workbook content. Each
attachment is mapped using its document ID and `documents.csv` organization,
then an explicit destination mapping. Filename guesses are never used. Run
without `--host` for local count-only preflight; with `--host` and `--key` for
server dry-run; add `--commit` only to import. Client exclusions are applied
before transmission. Stdin is sent over SSH; document bodies never enter logs.

The operator CLI `dist/scripts/documentation-import.cjs` validates destination
identity, encrypts and verifies the original workbook and sparse sheet preview,
and inserts one document atomically. A repeat with the same source ID and SHA-256
is idempotent; changed source bytes require an explicit replacement workflow.
Originals preserve images and formatting. The browser converts sheet text into
native Notes, Credentials and Needs review sections. Explicit identity/password
labels and narrowly recognized OTP seed labels produce fields; ambiguous content
and numeric one-time codes stay in review. Classification is deterministic and
local to the browser after the authorized document read. No workbook content is
sent to an AI service or executed. These detected fields are not automatically
created as credential-vault records.

Secret fields, review text and original cells require explicit reveal, hide after
30 seconds, and clear on client/sheet/filter changes, close or page hiding.
Original row/column provenance is preserved. The browser-native view is derived
from the encrypted original preview; it does not rewrite or delete source data.

Embedded raster images are extracted from the integrity-checked original workbook
on the same authorized, audited preview request. Drawing anchors place images near
their source notes; unanchored images stay in a separate sheet image area. Images
require explicit reveal because screenshots can contain credentials. Unsupported
or oversized images remain available in the original download. Extraction does
not follow external links, execute workbook content, or persist decrypted images.

`credentials_documents` has forced RLS and immutable row/client identities.
Contents are encrypted using row-bound AAD and included in encryption-key
rotation. Listing uses `credentials:read`; preview/download additionally require
`credentials:reveal` and satisfaction of the account's MFA policy. Both disclosure
paths require a durable audit. No document bodies enter global search, general
organization exports, browser storage or customer portals. Client changes clear
the reader and invalidate pending responses. Organizations retain deletion and
merge lifecycle coverage even when the extension is disabled.

Version 0.2.0 raises the schema compatibility floor. After its migration, recovery
must retain schema-aware code and tenancy declarations (the extension can be
disabled). Do not roll back to the 0.1.0 manifest or delete imported documents.

## Upstream maintenance

Business logic, web component, parser and migrations live in this package.
Core seams: built-in registration with strict audit injection; permission
catalog/seed; encryption rotation registry; API workspace dependency and Docker
assets; optional operator CLI entry. The browser-only toolbar adapter lives in
`apps/web/src/components/cloudcom/browserDesktop/SessionCredentials.tsx` and
`scripts/cloudcom/browser-credentials-transform.mjs`. Native viewer sources remain
unchanged; checked transform anchors fail on incompatible upstream changes.

Session endpoints require exact session ownership, current permissions epoch,
active desktop status, unchanged device/client binding and credential grants.
The selected navigation client cannot override the session client. Session
termination is rechecked before releasing a secret after durable audit. Picker
state is cleared on close, disconnect or session change; OTP values expire and
passwords hide after 30 seconds. Copy is an explicit operator action.

Run `typecheck`, `test`, `test:web`, `build:web`, plus API built-in registry,
permissions catalog and encrypted-column registry tests. Test forced RLS as
`breeze_app` against PostgreSQL, including denied cross-client inserts and reads.
Disabling the flag preserves encrypted records and their erasure/export policies.
Rollback to code predating the extension requires a schema-aware recovery plan;
do not delete credentials to make an old tenancy sweep pass.

## Staff Edge companion

Version 0.3.0 exposes a dedicated browser connection page and bounded staff-only
browser routes. See `../browser-companion/README.md` for setup, permission and
website-fill constraints. Device shortcuts reuse existing Remote Tools. No new
schema or core authentication flow is introduced. Companion regressions live in
`src/server/browserCompanion.test.ts`, `src/web/browserCompanion.test.ts`,
`src/web/companionFill.test.ts` and the standalone addon tests.
