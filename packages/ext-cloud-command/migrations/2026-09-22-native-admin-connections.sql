CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_admin_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL UNIQUE,
  tenant_name text NOT NULL,
  client_id uuid NOT NULL,
  credential_version text NOT NULL,
  permission_manifest_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_admin_consent (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  credential_version text NOT NULL,
  expected_generation integer,
  stage text NOT NULL CHECK (stage IN ('consent', 'identity', 'processing', 'complete')),
  verifier_ciphertext text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, actor_id)
);
ALTER TABLE cloudcommand_microsoft_admin_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_admin_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_admin_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_admin_consent FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cloudcommand_microsoft_admin_connections' AND policyname = 'cloudcommand_admin_org_access') THEN
    CREATE POLICY cloudcommand_admin_org_access ON cloudcommand_microsoft_admin_connections
      FOR ALL USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cloudcommand_microsoft_admin_consent' AND policyname = 'cloudcommand_consent_org_access') THEN
    CREATE POLICY cloudcommand_consent_org_access ON cloudcommand_microsoft_admin_consent
      FOR ALL USING (breeze_has_org_access(org_id) AND actor_id = breeze_current_user_id())
      WITH CHECK (breeze_has_org_access(org_id) AND actor_id = breeze_current_user_id());
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_microsoft_admin_connections TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_microsoft_admin_consent TO breeze_app;
