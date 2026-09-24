Remote customer identity/session tables are core-owned because the portal and
authenticated agent lease routes use them even when this extension is disabled.
Their migrations live in `apps/api/migrations`; disabling the extension stops
authorization but must not drop live-session history or portal entitlements.
