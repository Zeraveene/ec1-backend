CREATE TABLE auth_device_credential (
 id TEXT PRIMARY KEY,
 player_id TEXT NOT NULL REFERENCES player(id),
 secret_hash TEXT NOT NULL UNIQUE,
 device_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 last_used_at INTEGER,
 revoked_at INTEGER
);
CREATE INDEX auth_device_player ON auth_device_credential(player_id,revoked_at);
ALTER TABLE auth_session ADD COLUMN device_credential_id TEXT REFERENCES auth_device_credential(id);
