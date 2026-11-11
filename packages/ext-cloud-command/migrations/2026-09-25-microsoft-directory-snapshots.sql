-- Shared Microsoft directory and usage data. The collector publishes only complete,
-- tenant-verified sources; a failed refresh leaves the previous good source intact.
CREATE TABLE IF NOT EXISTS cloudcommand_microsoft_directory_snapshots (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  connection_generation integer NOT NULL CHECK (connection_generation > 0),
  directory_data jsonb,
  directory_collected_at timestamptz,
  usage_data jsonb,
  usage_collected_at timestamptz,
  last_attempt_at timestamptz,
  refresh_requested_at timestamptz,
  -- A crashed collector can be replaced after this short lease expires. Every
  -- publication is fenced by its token and the live connection generation.
  lease_token uuid,
  lease_expires_at timestamptz,
  directory_status text NOT NULL DEFAULT 'never' CHECK (directory_status IN ('never', 'ready', 'stale')),
  usage_status text NOT NULL DEFAULT 'never' CHECK (usage_status IN ('never', 'ready', 'stale')),
  CHECK ((directory_data IS NULL) = (directory_collected_at IS NULL)),
  CHECK ((usage_data IS NULL) = (usage_collected_at IS NULL)),
  CONSTRAINT cloudcommand_microsoft_directory_snapshots_lease_pair
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (directory_data IS NULL OR jsonb_typeof(directory_data) = 'object'),
  CHECK (usage_data IS NULL OR jsonb_typeof(usage_data) = 'object')
);

-- Local development may have applied an earlier copy of this unshipped
-- migration. Keep the lease addition idempotent for those test databases.
ALTER TABLE cloudcommand_microsoft_directory_snapshots
  ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE cloudcommand_microsoft_directory_snapshots
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE cloudcommand_microsoft_directory_snapshots
  ADD COLUMN IF NOT EXISTS refresh_requested_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid =
    'cloudcommand_microsoft_directory_snapshots'::regclass
    AND conname = 'cloudcommand_microsoft_directory_snapshots_lease_pair') THEN
    ALTER TABLE cloudcommand_microsoft_directory_snapshots
      ADD CONSTRAINT cloudcommand_microsoft_directory_snapshots_lease_pair
      CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));
  END IF;
END $$;

ALTER TABLE cloudcommand_microsoft_directory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloudcommand_microsoft_directory_snapshots FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'cloudcommand_microsoft_directory_snapshots'
    AND policyname = 'cloudcommand_microsoft_directory_snapshots_org_access') THEN
    CREATE POLICY cloudcommand_microsoft_directory_snapshots_org_access
      ON cloudcommand_microsoft_directory_snapshots FOR ALL
      USING (breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cloudcommand_microsoft_directory_snapshots TO breeze_app;
