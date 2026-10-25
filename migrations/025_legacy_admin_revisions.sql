-- Admin recovery history for legacy saves. No player account or migration is created.
CREATE TABLE legacy_admin_revision (
 player_id TEXT NOT NULL, revision INTEGER NOT NULL, r2_key TEXT NOT NULL,
 sha256 TEXT NOT NULL, original_key TEXT NOT NULL, playtime REAL,
 actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(player_id,revision), UNIQUE(player_id,operation_id)
);
CREATE TABLE legacy_admin_head (
 player_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
 FOREIGN KEY(player_id,revision) REFERENCES legacy_admin_revision(player_id,revision)
);
