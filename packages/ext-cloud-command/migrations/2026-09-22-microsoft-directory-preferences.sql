CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_directory_preferences (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  microsoft_user_id uuid NOT NULL,
  excluded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, actor_id, microsoft_user_id)
);

ALTER TABLE cloudcommand_microsoft_directory_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_directory_preferences FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'cloudcommand_microsoft_directory_preferences'
    AND policyname = 'cloudcommand_microsoft_directory_preferences_actor_org_access') THEN
    CREATE POLICY cloudcommand_microsoft_directory_preferences_actor_org_access
      ON cloudcommand_microsoft_directory_preferences
      FOR ALL
      USING (breeze_has_org_access(org_id) AND actor_id = breeze_current_user_id())
      WITH CHECK (breeze_has_org_access(org_id) AND actor_id = breeze_current_user_id());
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_microsoft_directory_preferences TO breeze_app;
