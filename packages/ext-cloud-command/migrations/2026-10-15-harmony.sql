-- Core harmony_integrations must exist before extension migrations run.
CREATE TABLE IF NOT EXISTS cloudcommand_harmony_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('group','endpoint')),
  external_id varchar(512) NOT NULL CHECK (length(external_id)>0),
  FOREIGN KEY (org_id,partner_id) REFERENCES organizations(id,partner_id) ON DELETE CASCADE,
  FOREIGN KEY (integration_id,partner_id) REFERENCES harmony_integrations(id,partner_id) ON DELETE CASCADE,
  UNIQUE (integration_id,kind,external_id)
);
CREATE INDEX IF NOT EXISTS cloudcommand_harmony_scopes_org_idx ON cloudcommand_harmony_scopes(org_id);
CREATE TABLE IF NOT EXISTS cloudcommand_harmony_clients (
  org_id uuid PRIMARY KEY,
  partner_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  checked_at timestamptz NOT NULL,
  FOREIGN KEY (org_id,partner_id) REFERENCES organizations(id,partner_id) ON DELETE CASCADE,
  FOREIGN KEY (integration_id,partner_id) REFERENCES harmony_integrations(id,partner_id) ON DELETE CASCADE,
  UNIQUE (org_id,integration_id,partner_id)
);
CREATE TABLE IF NOT EXISTS cloudcommand_harmony_endpoints (
  org_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_id varchar(512) NOT NULL,
  device_id uuid,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  PRIMARY KEY (integration_id,external_id),
  FOREIGN KEY (org_id,integration_id,partner_id) REFERENCES cloudcommand_harmony_clients(org_id,integration_id,partner_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id,org_id) REFERENCES devices(id,org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cloudcommand_harmony_endpoints_org_idx ON cloudcommand_harmony_endpoints(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS cloudcommand_harmony_endpoints_device_idx ON cloudcommand_harmony_endpoints(device_id) WHERE device_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['cloudcommand_harmony_scopes','cloudcommand_harmony_clients','cloudcommand_harmony_endpoints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_org_isolation') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))',t||'_org_isolation',t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='breeze_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO breeze_app',t);
    END IF;
  END LOOP;
END $$;
