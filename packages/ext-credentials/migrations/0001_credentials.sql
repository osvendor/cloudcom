CREATE TABLE IF NOT EXISTS credentials_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  secret_ciphertext text NOT NULL CHECK (secret_ciphertext LIKE 'enc:v3:%'),
  has_password boolean NOT NULL DEFAULT false,
  has_otp boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  source_organization text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_organization, source_id)
);
CREATE INDEX IF NOT EXISTS credentials_records_org_idx ON credentials_records(org_id);
ALTER TABLE credentials_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials_records FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='credentials_records' AND policyname='credentials_records_org_access') THEN
    CREATE POLICY credentials_records_org_access ON credentials_records
      USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON credentials_records TO breeze_app;
-- No reassignment: record ciphertext is bound to its original org and id.
CREATE OR REPLACE FUNCTION credentials_records_immutable_scope() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Credential scope cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS credentials_records_scope_guard ON credentials_records;
CREATE TRIGGER credentials_records_scope_guard BEFORE UPDATE ON credentials_records
FOR EACH ROW EXECUTE FUNCTION credentials_records_immutable_scope();

INSERT INTO permissions(resource,action,description)
SELECT resource,action,description FROM (VALUES
  ('credentials','read','Search client credential metadata'),
  ('credentials','reveal','Reveal client passwords'),
  ('credentials','otp','Generate client one-time codes'),
  ('credentials','import','Import client credentials')
) AS desired(resource,action,description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.resource=desired.resource AND p.action=desired.action);
