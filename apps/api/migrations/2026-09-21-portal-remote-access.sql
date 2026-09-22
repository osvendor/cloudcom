-- Customer principals remain separate from technician users. Nothing is enabled
-- by this migration. Same-org composite FKs defend every assignment/session.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'standard';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portal_users_access_mode_check') THEN
    ALTER TABLE portal_users ADD CONSTRAINT portal_users_access_mode_check CHECK (access_mode IN ('standard','remote_only'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_remote_id_org_uq ON portal_users(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_remote_id_org_uq ON devices(id, org_id);

CREATE TABLE IF NOT EXISTS portal_remote_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  webrtc_enabled boolean NOT NULL DEFAULT false,
  rustdesk_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal_remote_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  portal_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamp,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT portal_remote_assignment_user_org_fk FOREIGN KEY (portal_user_id, org_id) REFERENCES portal_users(id, org_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_remote_assignment_device_org_fk FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id) DEFERRABLE INITIALLY IMMEDIATE,
  UNIQUE (portal_user_id, device_id),
  UNIQUE (id, org_id, portal_user_id, device_id)
);
CREATE INDEX IF NOT EXISTS portal_remote_assignments_org_idx ON portal_remote_assignments(org_id);
CREATE TABLE IF NOT EXISTS portal_remote_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  portal_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  assignment_version integer NOT NULL CHECK (assignment_version > 0),
  auth_epoch integer NOT NULL CHECK (auth_epoch > 0),
  transport text NOT NULL CHECK (transport IN ('webrtc','rustdesk')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connecting','active','disconnected','failed','denied')),
  webrtc_offer text,
  webrtc_answer text,
  desktop_start_command_id text,
  desktop_start_generation bigint NOT NULL DEFAULT 0,
  terminal_generation bigint,
  termination_phase text NOT NULL DEFAULT 'none' CHECK (termination_phase IN ('none','pending','confirmed')),
  hard_deadline timestamp NOT NULL,
  ended_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT portal_remote_session_assignment_fk FOREIGN KEY (assignment_id, org_id, portal_user_id, device_id)
    REFERENCES portal_remote_assignments(id, org_id, portal_user_id, device_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_remote_session_terminal_check CHECK ((termination_phase = 'none' AND terminal_generation IS NULL) OR (termination_phase <> 'none' AND terminal_generation IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS portal_remote_sessions_org_idx ON portal_remote_sessions(org_id);
CREATE INDEX IF NOT EXISTS portal_remote_sessions_owner_idx ON portal_remote_sessions(portal_user_id, created_at);
-- Any edit invalidates already issued tickets/leases, including direct SQL
-- administration. Never let a caller pick or roll back a grant generation.
CREATE OR REPLACE FUNCTION portal_remote_assignment_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.portal_user_id <> OLD.portal_user_id OR NEW.device_id <> OLD.device_id THEN
    RAISE EXCEPTION 'Remote assignments cannot be moved; revoke and create a new assignment' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS portal_remote_assignment_version ON portal_remote_assignments;
CREATE TRIGGER portal_remote_assignment_version BEFORE UPDATE ON portal_remote_assignments
  FOR EACH ROW EXECUTE FUNCTION portal_remote_assignment_bump_version();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['portal_remote_settings','portal_remote_assignments','portal_remote_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_org_access') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))', t || '_org_access', t);
    END IF;
  END LOOP;
END $$;
