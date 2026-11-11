CREATE TABLE IF NOT EXISTS credentials_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type text NOT NULL,
  source_organization text NOT NULL,
  source_id text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sheet_count integer NOT NULL CHECK (sheet_count BETWEEN 0 AND 1000),
  payload_ciphertext text NOT NULL CHECK (payload_ciphertext LIKE 'enc:v3:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_organization, source_id)
);
CREATE INDEX IF NOT EXISTS credentials_documents_org_idx ON credentials_documents(org_id);
ALTER TABLE credentials_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials_documents FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='credentials_documents' AND policyname='credentials_documents_org_access') THEN
    CREATE POLICY credentials_documents_org_access ON credentials_documents
      USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON credentials_documents TO breeze_app;
CREATE OR REPLACE FUNCTION credentials_documents_immutable_scope() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Document scope cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS credentials_documents_scope_guard ON credentials_documents;
CREATE TRIGGER credentials_documents_scope_guard BEFORE UPDATE ON credentials_documents
FOR EACH ROW EXECUTE FUNCTION credentials_documents_immutable_scope();
