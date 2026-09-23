-- Native admission is separate from WebRTC. Feature remains default-off.
CREATE TABLE IF NOT EXISTS portal_native_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid NOT NULL, installation_id uuid NOT NULL, rustdesk_id text NOT NULL CHECK(rustdesk_id ~ '^[0-9]{1,32}$'), public_key text NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation > 0), credential_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT portal_native_target_device_fk FOREIGN KEY(device_id,org_id) REFERENCES devices(id,org_id),
 UNIQUE(device_id), UNIQUE(id,org_id,device_id), UNIQUE(credential_hash),
 CHECK(length(public_key)=43), CHECK(length(credential_hash)=43)
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_remote_session_native_identity_idx ON portal_remote_sessions(id,org_id,portal_user_id,device_id);
CREATE TABLE IF NOT EXISTS portal_native_admissions (
 session_id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), device_id uuid NOT NULL, portal_user_id uuid NOT NULL,
 target_id uuid NOT NULL, target_generation integer NOT NULL CHECK(target_generation>0), target_public_key text NOT NULL,
 operator_public_key text NOT NULL, ticket_hash text NOT NULL UNIQUE, ticket_expires_at timestamp NOT NULL, consumed_at timestamp,
 connection_id uuid, target_challenge text, channel_binding text, lease_revision integer NOT NULL DEFAULT 0 CHECK(lease_revision>=0), lease_hash text, lease_expires_at timestamp,
 presence_until timestamp NOT NULL, operator_session_hash text NOT NULL,
 CONSTRAINT portal_native_admission_session_fk FOREIGN KEY(session_id,org_id,portal_user_id,device_id) REFERENCES portal_remote_sessions(id,org_id,portal_user_id,device_id),
 CONSTRAINT portal_native_admission_target_fk FOREIGN KEY(target_id,org_id,device_id) REFERENCES portal_native_targets(id,org_id,device_id),
 UNIQUE(target_id,connection_id), CHECK(length(target_public_key)=43), CHECK(length(operator_public_key)=43),
 CHECK(length(ticket_hash)=43), CHECK(length(operator_session_hash)=43),
 CHECK((consumed_at IS NULL AND connection_id IS NULL AND target_challenge IS NULL AND channel_binding IS NULL AND lease_hash IS NULL AND lease_expires_at IS NULL)
 OR (consumed_at IS NOT NULL AND connection_id IS NOT NULL AND length(target_challenge)=43 AND length(channel_binding)=43 AND length(lease_hash)=43 AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS portal_native_targets_org_idx ON portal_native_targets(org_id);
CREATE INDEX IF NOT EXISTS portal_native_admissions_org_idx ON portal_native_admissions(org_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['portal_native_targets','portal_native_admissions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_org_access') THEN
   EXECUTE format('CREATE POLICY %I ON %I USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))',t||'_org_access',t);
  END IF;
 END LOOP;
END $$;

-- Direct SQL maintenance must not preserve old native authority after key/state changes.
CREATE OR REPLACE FUNCTION portal_native_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.device_id <> OLD.device_id THEN
  RAISE EXCEPTION 'Native target identities cannot move' USING ERRCODE='23514', CONSTRAINT='portal_native_target_identity_guard';
 END IF;
 IF ROW(NEW.installation_id,NEW.rustdesk_id,NEW.public_key,NEW.credential_hash,NEW.enabled)
    IS DISTINCT FROM ROW(OLD.installation_id,OLD.rustdesk_id,OLD.public_key,OLD.credential_hash,OLD.enabled) THEN
  NEW.generation := OLD.generation + 1;
 ELSIF NEW.generation <> OLD.generation THEN
  RAISE EXCEPTION 'Native target generation cannot be rewritten' USING ERRCODE='23514';
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS portal_native_target_generation ON portal_native_targets;
CREATE TRIGGER portal_native_target_generation BEFORE UPDATE ON portal_native_targets FOR EACH ROW EXECUTE FUNCTION portal_native_target_guard();
