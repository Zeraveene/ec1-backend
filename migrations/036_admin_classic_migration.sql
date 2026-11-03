CREATE TABLE admin_classic_migration (
 operation_id TEXT PRIMARY KEY, player_id TEXT NOT NULL UNIQUE REFERENCES player(id),
 actor_id TEXT NOT NULL, review_sha256 TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE classic_migration_email (
 player_id TEXT PRIMARY KEY REFERENCES player(id), recipient TEXT NOT NULL,
 password_hash TEXT NOT NULL, encrypted_password TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','superseded')),
 attempt_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
