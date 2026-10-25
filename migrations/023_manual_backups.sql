-- Canonical Unity backups are separate from historical preference-dictionary saves.
CREATE TABLE classic_backup_revision (
 player_id TEXT NOT NULL REFERENCES player(id), revision INTEGER NOT NULL,
 r2_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
 schema_version INTEGER NOT NULL, playtime REAL NOT NULL, created_at INTEGER NOT NULL,
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'manual_upload', restored_from INTEGER,
 PRIMARY KEY(player_id,revision), UNIQUE(player_id,operation_id)
);
CREATE TABLE classic_backup_head (
 player_id TEXT PRIMARY KEY REFERENCES player(id), revision INTEGER NOT NULL,
 FOREIGN KEY(player_id,revision) REFERENCES classic_backup_revision(player_id,revision)
);
