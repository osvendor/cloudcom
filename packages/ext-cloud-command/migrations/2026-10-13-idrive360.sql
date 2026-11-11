CREATE TABLE IF NOT EXISTS cloudcommand_idrive_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
 company_id bigint NOT NULL CHECK (company_id > 0),
 group_id bigint CHECK (group_id > 0),
 company_name text NOT NULL, group_name text,
 secret_ciphertext text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 stale_hours integer NOT NULL DEFAULT 48 CHECK (stale_hours BETWEEN 1 AND 2160),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 last_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloudcommand_idrive_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 connection_version integer NOT NULL,
 kind text NOT NULL, payload_ciphertext text NOT NULL,
 status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','running','completed','failed')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS cloudcommand_idrive_operations_org_created ON cloudcommand_idrive_operations(org_id,created_at DESC);
ALTER TABLE cloudcommand_idrive_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_idrive_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_idrive_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_idrive_operations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cloudcommand_idrive_connections' AND policyname='idrive_connections_org') THEN
 CREATE POLICY idrive_connections_org ON cloudcommand_idrive_connections USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cloudcommand_idrive_operations' AND policyname='idrive_operations_org') THEN
 CREATE POLICY idrive_operations_org ON cloudcommand_idrive_operations USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloudcommand_idrive_connections,cloudcommand_idrive_operations TO breeze_app;
