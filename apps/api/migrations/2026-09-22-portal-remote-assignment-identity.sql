-- Preserve a stable error identity when an organization-move cascade attempts
-- to reparent a customer's grant. Never carry an old customer's authorization
-- into another organization, and never erase the history implicitly.
CREATE OR REPLACE FUNCTION portal_remote_assignment_bump_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id OR NEW.portal_user_id <> OLD.portal_user_id OR NEW.device_id <> OLD.device_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'portal_remote_assignment_identity_guard',
      MESSAGE = 'Remote access assignments and history cannot change ownership';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
