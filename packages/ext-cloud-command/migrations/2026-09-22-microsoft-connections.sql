CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  tenant_domain text NOT NULL,
  tenant_name text NOT NULL,
  backend_identity text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cloudcommand_microsoft_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_connections FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cloudcommand_microsoft_connections' AND policyname = 'cloudcommand_microsoft_org_access') THEN
    CREATE POLICY cloudcommand_microsoft_org_access ON cloudcommand_microsoft_connections
      FOR ALL USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_microsoft_connections TO breeze_app;
