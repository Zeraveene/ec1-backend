-- Immutable raw source provenance and first canonical backup publication.
-- Independent from historical preference-dictionary migration records.
CREATE TABLE classic_migration (
 player_id TEXT PRIMARY KEY REFERENCES player(id),
 source_hash TEXT NOT NULL,
 archive_key TEXT NOT NULL UNIQUE,
 raw_save_hash TEXT NOT NULL,
 revision INTEGER,
 completed_at INTEGER,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(player_id,revision) REFERENCES classic_backup_revision(player_id,revision)
);
