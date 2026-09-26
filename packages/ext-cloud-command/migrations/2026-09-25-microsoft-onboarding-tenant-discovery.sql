-- The Microsoft administrator selects a tenant during consent. Keep the
-- consent attempt unbound until Microsoft's callback supplies the tenant ID;
-- the same attempt is then bound atomically before identity verification.
ALTER TABLE cloudcommand_microsoft_admin_consent ALTER COLUMN tenant_id DROP NOT NULL;
