-- Global immutable source claims shared by recovery and historical publishers.
CREATE TABLE legacy_recovery_claim (
 source_key TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id), claimed_at INTEGER NOT NULL
);
CREATE TABLE legacy_recovery_receipt (
 player_id TEXT NOT NULL REFERENCES player(id), operation_id TEXT NOT NULL,
 source_key TEXT NOT NULL, archive_key TEXT NOT NULL, archive_hash TEXT NOT NULL,
 response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(player_id,operation_id)
);
CREATE TABLE legacy_recovery_guard (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO legacy_recovery_claim SELECT 'playfab:'||upper(player_id),player_id,created_at FROM classic_migration WHERE revision IS NOT NULL;
INSERT OR IGNORE INTO legacy_recovery_claim SELECT 'playfab:'||upper(player_id),player_id,created_at FROM migration_record WHERE save_version IS NOT NULL;
-- An attempted foreign claim deliberately violates the primary key and rolls back
-- the complete D1 batch, including a historical/admin publisher's save and login.
CREATE TRIGGER classic_recovery_claim_insert AFTER INSERT ON classic_migration WHEN NEW.revision IS NOT NULL BEGIN
 INSERT INTO legacy_recovery_claim VALUES('playfab:'||upper(NEW.player_id),NEW.player_id,NEW.created_at)
 ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END;
END;
CREATE TRIGGER classic_recovery_claim_update AFTER UPDATE OF revision ON classic_migration WHEN NEW.revision IS NOT NULL BEGIN
 INSERT INTO legacy_recovery_claim VALUES('playfab:'||upper(NEW.player_id),NEW.player_id,NEW.created_at)
 ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END;
END;
CREATE TRIGGER old_recovery_claim_insert AFTER INSERT ON migration_record WHEN NEW.save_version IS NOT NULL BEGIN
 INSERT INTO legacy_recovery_claim VALUES('playfab:'||upper(NEW.player_id),NEW.player_id,NEW.created_at)
 ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END;
END;
CREATE TRIGGER old_recovery_claim_update AFTER UPDATE OF save_version ON migration_record WHEN NEW.save_version IS NOT NULL BEGIN
 INSERT INTO legacy_recovery_claim VALUES('playfab:'||upper(NEW.player_id),NEW.player_id,NEW.created_at)
 ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END;
END;
