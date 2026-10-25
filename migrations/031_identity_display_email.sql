ALTER TABLE auth_identity ADD COLUMN display_email TEXT;
ALTER TABLE auth_challenge ADD COLUMN verified_email TEXT;
