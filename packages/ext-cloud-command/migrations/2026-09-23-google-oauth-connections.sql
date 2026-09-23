-- OAuth grants are a separate credential mode. Never coerce a refresh token into
-- google_workspace_connections.service_account_key (domain-wide delegation).
CREATE TABLE IF NOT EXISTS cloudcommand_google_oauth_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id varchar(128) NOT NULL,
  customer_domain varchar(253) NOT NULL,
  authorized_email varchar(320) NOT NULL,
  refresh_token text NOT NULL,
  granted_scopes text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cloudcommand_google_oauth_org_unique UNIQUE (org_id),
  CONSTRAINT cloudcommand_google_oauth_customer_unique UNIQUE (customer_id)
);

CREATE TABLE IF NOT EXISTS cloudcommand_google_oauth_attempts (
  state_hash varchar(64) PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser_hash varchar(64) NOT NULL,
  verifier_ciphertext text NOT NULL,
  expected_domain varchar(253) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloudcommand_google_oauth_attempts_expiry
  ON cloudcommand_google_oauth_attempts (expires_at);

ALTER TABLE cloudcommand_google_oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_google_oauth_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_google_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_google_oauth_attempts FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cloudcommand_google_oauth_connections'
    AND policyname = 'cloudcommand_google_oauth_org_access') THEN
    CREATE POLICY cloudcommand_google_oauth_org_access ON cloudcommand_google_oauth_connections
      FOR ALL USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cloudcommand_google_oauth_attempts'
    AND policyname = 'cloudcommand_google_oauth_attempt_actor_access') THEN
    CREATE POLICY cloudcommand_google_oauth_attempt_actor_access ON cloudcommand_google_oauth_attempts
      FOR ALL USING (breeze_has_org_access(org_id) AND
        (breeze_current_scope() = 'system' OR actor_id = breeze_current_user_id()))
      WITH CHECK (breeze_has_org_access(org_id) AND
        (breeze_current_scope() = 'system' OR actor_id = breeze_current_user_id()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_google_oauth_connections TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_google_oauth_attempts TO breeze_app;
