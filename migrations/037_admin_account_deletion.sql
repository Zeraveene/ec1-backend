-- Durable deletion receipts also prevent a deleted native ID from being revived.
CREATE TABLE account_deletion (
 player_id TEXT PRIMARY KEY REFERENCES player(id), operation_id TEXT NOT NULL UNIQUE,
 actor_id TEXT NOT NULL, reason TEXT NOT NULL, request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('cleanup_pending','complete')),
 created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE TABLE account_deletion_blob (
 player_id TEXT NOT NULL REFERENCES account_deletion(player_id), r2_key TEXT NOT NULL,
 PRIMARY KEY(player_id,r2_key)
);
CREATE TRIGGER deleted_player_immutable BEFORE UPDATE ON player WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=OLD.id) AND (OLD.save_state='deleted' OR NEW.save_state!='deleted') BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_player_ban_keep BEFORE DELETE ON player_ban WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=OLD.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_player_ban_locked BEFORE UPDATE ON player_ban WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=OLD.player_id) AND (NEW.revoked_at IS NOT NULL OR NEW.expires_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_identity_insert BEFORE INSERT ON auth_identity WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_identity_update BEFORE UPDATE ON auth_identity WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_bootstrap_insert BEFORE INSERT ON auth_bootstrap WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_bootstrap_update BEFORE UPDATE ON auth_bootstrap WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_session_insert BEFORE INSERT ON auth_session WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) AND NEW.revoked_at IS NULL BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_session_update BEFORE UPDATE ON auth_session WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) AND NEW.revoked_at IS NULL BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_device_credential_insert BEFORE INSERT ON auth_device_credential WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) AND NEW.revoked_at IS NULL BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_device_credential_update BEFORE UPDATE ON auth_device_credential WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) AND NEW.revoked_at IS NULL BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_challenge_insert BEFORE INSERT ON auth_challenge WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_auth_challenge_update BEFORE UPDATE ON auth_challenge WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_auth_proof_insert BEFORE INSERT ON classic_auth_proof WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_auth_proof_update BEFORE UPDATE ON classic_auth_proof WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_backup_revision_insert BEFORE INSERT ON classic_backup_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_backup_revision_update BEFORE UPDATE ON classic_backup_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_backup_head_insert BEFORE INSERT ON classic_backup_head WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_backup_head_update BEFORE UPDATE ON classic_backup_head WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_save_owner_insert BEFORE INSERT ON classic_save_owner WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_save_owner_update BEFORE UPDATE ON classic_save_owner WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_save_revision_insert BEFORE INSERT ON save_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_save_revision_update BEFORE UPDATE ON save_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_save_operation_insert BEFORE INSERT ON save_operation WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_save_operation_update BEFORE UPDATE ON save_operation WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_legacy_admin_revision_insert BEFORE INSERT ON legacy_admin_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_legacy_admin_revision_update BEFORE UPDATE ON legacy_admin_revision WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_legacy_admin_head_insert BEFORE INSERT ON legacy_admin_head WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_legacy_admin_head_update BEFORE UPDATE ON legacy_admin_head WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_mail_insert BEFORE INSERT ON mail WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_mail_update BEFORE UPDATE ON mail WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_liveops_mail_insert BEFORE INSERT ON liveops_mail WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_liveops_mail_update BEFORE UPDATE ON liveops_mail WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_liveops_grant_insert BEFORE INSERT ON liveops_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_liveops_grant_update BEFORE UPDATE ON liveops_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_guest_insert BEFORE INSERT ON purchase_guest WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_guest_update BEFORE UPDATE ON purchase_guest WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_grant_insert BEFORE INSERT ON purchase_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_grant_update BEFORE UPDATE ON purchase_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_editor_grant_insert BEFORE INSERT ON purchase_editor_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_editor_grant_update BEFORE UPDATE ON purchase_editor_grant WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_entitlement_insert BEFORE INSERT ON purchase_entitlement WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_purchase_entitlement_update BEFORE UPDATE ON purchase_entitlement WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_password_recovery_insert BEFORE INSERT ON password_recovery WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_password_recovery_update BEFORE UPDATE ON password_recovery WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_migration_insert BEFORE INSERT ON classic_migration WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_migration_update BEFORE UPDATE ON classic_migration WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_migration_email_insert BEFORE INSERT ON classic_migration_email WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_migration_email_update BEFORE UPDATE ON classic_migration_email WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_migration_record_insert BEFORE INSERT ON migration_record WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_migration_record_update BEFORE UPDATE ON migration_record WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_migration_identity_proof_insert BEFORE INSERT ON migration_identity_proof WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_migration_identity_proof_update BEFORE UPDATE ON migration_identity_proof WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_player_reinsert BEFORE INSERT ON player WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_player_ban_insert BEFORE INSERT ON player_ban WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) AND (NEW.reason!='account_deleted' OR NEW.revoked_at IS NOT NULL OR NEW.expires_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_leaderboard_entry_insert BEFORE INSERT ON classic_leaderboard_entry WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_leaderboard_entry_update BEFORE UPDATE ON classic_leaderboard_entry WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
CREATE TRIGGER deleted_classic_leaderboard_submission_insert BEFORE INSERT ON classic_leaderboard_submission WHEN EXISTS(SELECT 1 FROM account_deletion WHERE player_id=NEW.player_id) BEGIN SELECT RAISE(ABORT,'account_deleted'); END;
