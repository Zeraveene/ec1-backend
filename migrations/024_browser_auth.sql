ALTER TABLE auth_challenge ADD COLUMN browser_transport INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_challenge ADD COLUMN browser_subject TEXT;
ALTER TABLE auth_challenge ADD COLUMN browser_ticket_hash TEXT;
ALTER TABLE auth_challenge ADD COLUMN browser_callback_claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_challenge ADD COLUMN browser_error TEXT;
