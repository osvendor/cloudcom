CREATE TABLE IF NOT EXISTS credentials_companion_script_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  preview_id uuid REFERENCES credentials_companion_script_runs(id),
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  command_id uuid REFERENCES device_commands(id) ON DELETE SET NULL,
  script_id text NOT NULL CHECK (script_id='clear-print-spool'),
  mode text NOT NULL CHECK (mode IN ('preview','execute')),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  fingerprint text NOT NULL,
  result jsonb,
  error text,
  noted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_id),
  UNIQUE(preview_id)
);
CREATE INDEX IF NOT EXISTS credentials_companion_script_runs_org_idx ON credentials_companion_script_runs(org_id,device_id,created_at DESC);
CREATE INDEX IF NOT EXISTS credentials_companion_script_runs_pending_idx ON credentials_companion_script_runs(status) WHERE status IN ('queued','running');
ALTER TABLE credentials_companion_script_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials_companion_script_runs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='credentials_companion_script_runs' AND policyname='credentials_companion_script_runs_org_access') THEN
  CREATE POLICY credentials_companion_script_runs_org_access ON credentials_companion_script_runs USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON credentials_companion_script_runs TO breeze_app;
CREATE OR REPLACE FUNCTION credentials_companion_script_run_scope() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.device_id,NEW.actor_id,NEW.request_id,NEW.preview_id,NEW.script_id,NEW.mode,NEW.fingerprint)
     IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.device_id,OLD.actor_id,OLD.request_id,OLD.preview_id,OLD.script_id,OLD.mode,OLD.fingerprint) THEN
   RAISE EXCEPTION 'Script run scope and submission cannot be changed';
  END IF;
  IF (NEW.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id)
     OR (NEW.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id) THEN
   RAISE EXCEPTION 'Script run associations cannot be changed';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device_id AND org_id=NEW.org_id)
     OR (NEW.ticket_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tickets WHERE id=NEW.ticket_id AND org_id=NEW.org_id))
     OR (NEW.command_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM device_commands WHERE id=NEW.command_id AND device_id=NEW.device_id AND submitted_org_id=NEW.org_id)) THEN
   RAISE EXCEPTION 'Script run associations must belong to the same client and device';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS credentials_companion_script_run_scope_guard ON credentials_companion_script_runs;
CREATE TRIGGER credentials_companion_script_run_scope_guard BEFORE INSERT OR UPDATE ON credentials_companion_script_runs
FOR EACH ROW EXECUTE FUNCTION credentials_companion_script_run_scope();
