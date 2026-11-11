CREATE TABLE IF NOT EXISTS harmony_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  region varchar(2) NOT NULL CHECK (region IN ('us','eu','ap')),
  credentials_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  checked_at timestamptz,
  last_status varchar(16) NOT NULL DEFAULT 'pending' CHECK (last_status IN ('pending','ready','failed')),
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS harmony_integrations_partner_idx ON harmony_integrations(partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS harmony_integrations_id_partner_idx ON harmony_integrations(id,partner_id);
ALTER TABLE harmony_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE harmony_integrations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='harmony_integrations' AND policyname='harmony_integrations_partner_isolation') THEN
    CREATE POLICY harmony_integrations_partner_isolation ON harmony_integrations
      USING (breeze_has_partner_access(partner_id)) WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harmony_integrations TO breeze_app;
  END IF;
END $$;
