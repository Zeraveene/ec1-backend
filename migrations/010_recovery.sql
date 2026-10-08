CREATE TABLE password_recovery (
 token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id),
 old_password_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', used_at INTEGER, fingerprint TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX password_recovery_expiry ON password_recovery(expires_at);
CREATE TABLE recovery_rate (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE recovery_event (id TEXT PRIMARY KEY,player_id TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);
