CREATE TABLE classic_auth_proof (
 id TEXT PRIMARY KEY,
 player_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('google','email')),
 subject TEXT NOT NULL,
 password_hash TEXT,
 salt TEXT,
 session_id TEXT UNIQUE,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX classic_auth_proof_expiry ON classic_auth_proof(expires_at);
