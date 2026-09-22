CREATE TABLE IF NOT EXISTS cloudcommand_threecx_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  origin text NOT NULL,
  client_id text NOT NULL,
  secret_ciphertext text NOT NULL,
  department_id integer CHECK (department_id IS NULL OR department_id >= 0),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cloudcommand_threecx_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_threecx_connections FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cloudcommand_threecx_connections' AND policyname = 'cloudcommand_threecx_org_access') THEN
    CREATE POLICY cloudcommand_threecx_org_access ON cloudcommand_threecx_connections
      USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_threecx_connections TO breeze_app;
