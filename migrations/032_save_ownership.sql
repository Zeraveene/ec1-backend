-- A lineage is claimed only by the same atomic batch that publishes its first revision.
CREATE TABLE classic_save_owner (
 save_id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id), claimed_at INTEGER NOT NULL
);
ALTER TABLE classic_backup_revision ADD COLUMN save_id TEXT;
CREATE INDEX classic_backup_save_id ON classic_backup_revision(save_id);
