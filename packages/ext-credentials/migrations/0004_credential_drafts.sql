ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS is_administration boolean NOT NULL DEFAULT false;
ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false;
ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS temporary_password boolean NOT NULL DEFAULT false;
ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS creation_state text NOT NULL DEFAULT 'none';
ALTER TABLE credentials_records ADD COLUMN IF NOT EXISTS provider_user_id text;
