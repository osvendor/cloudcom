-- Staff sessions have independent ownership. Customer assignments remain mandatory
-- in the unchanged portal tables. This migration is additive and default-off.
CREATE TABLE IF NOT EXISTS staff_native_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid NOT NULL, staff_user_id uuid NOT NULL REFERENCES users(id),
 target_id uuid NOT NULL, target_generation integer NOT NULL CHECK(target_generation > 0),
 target_public_key text NOT NULL CHECK(length(target_public_key)=43),
 operator_public_key text NOT NULL CHECK(length(operator_public_key)=43),
 operator_session_hash text NOT NULL CHECK(length(operator_session_hash)=43),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disconnected')),
 hard_deadline timestamp NOT NULL, created_at timestamp NOT NULL DEFAULT now(), ended_at timestamp,
 ticket_hash text NOT NULL UNIQUE CHECK(length(ticket_hash)=43), ticket_expires_at timestamp NOT NULL,
 consumed_at timestamp, connection_id uuid, target_challenge text, channel_binding text,
 lease_revision integer NOT NULL DEFAULT 0 CHECK(lease_revision>=0), lease_hash text,
 lease_expires_at timestamp, presence_until timestamp NOT NULL,
 CONSTRAINT staff_native_target_fk FOREIGN KEY(target_id,org_id,device_id)
   REFERENCES portal_native_targets(id,org_id,device_id),
 UNIQUE(target_id,connection_id),
 CHECK(hard_deadline > created_at),
 CHECK((consumed_at IS NULL AND connection_id IS NULL AND target_challenge IS NULL AND channel_binding IS NULL AND lease_hash IS NULL AND lease_expires_at IS NULL)
   OR (consumed_at IS NOT NULL AND connection_id IS NOT NULL AND length(target_challenge)=43 AND length(channel_binding)=43 AND length(lease_hash)=43 AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS staff_native_sessions_org_idx ON staff_native_sessions(org_id);
CREATE INDEX IF NOT EXISTS staff_native_sessions_owner_idx ON staff_native_sessions(staff_user_id,operator_session_hash);
ALTER TABLE staff_native_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_native_sessions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_native_sessions' AND policyname='staff_native_sessions_org_access') THEN
  CREATE POLICY staff_native_sessions_org_access ON staff_native_sessions
   USING(breeze_has_org_access(org_id)) WITH CHECK(breeze_has_org_access(org_id));
 END IF;
END $$;
