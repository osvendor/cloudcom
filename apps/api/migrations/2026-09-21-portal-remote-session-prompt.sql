ALTER TABLE portal_remote_sessions ADD COLUMN IF NOT EXISTS desktop_prompt_mode text NOT NULL DEFAULT 'notify';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portal_remote_sessions_prompt_mode_check') THEN
    ALTER TABLE portal_remote_sessions ADD CONSTRAINT portal_remote_sessions_prompt_mode_check CHECK (desktop_prompt_mode IN ('off','notify','consent'));
  END IF;
END $$;
