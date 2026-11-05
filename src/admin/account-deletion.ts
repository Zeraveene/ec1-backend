import type { Env } from '../env';
import { AdminActionError, requireWriter, type AdminActor } from './action-types';
import { sha256, stableJson } from '../game/validation';

type Receipt = { player_id: string; operation_id: string; actor_id: string; reason: string; request_hash: string; state: 'cleanup_pending' | 'complete' };
export async function accountDeletionAvailable(env: Env) {
  return !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_deletion'").first();
}
async function receipt(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM account_deletion WHERE player_id=?').bind(id).first<Receipt>();
}
export async function accountDeletionStatus(env: Env, actor: AdminActor, id: string) {
  requireWriter(actor);
  if (!await accountDeletionAvailable(env)) throw new AdminActionError('account_deletion_unavailable', 503);
  const row = await receipt(env, id);
  return row ? { state: row.state, operationId: row.operation_id, reason: row.reason } : { state: 'none' };
}

/** Native EC1 deletion only. No PlayFab requests, ledger erasure or device-save changes. */
export async function deleteAccount(env: Env, actor: AdminActor, id: string, args: Record<string, unknown>) {
  requireWriter(actor);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || args.confirmation !== id || args.acknowledged !== true ||
      typeof args.reason !== 'string' || args.reason.trim().length < 3 || args.reason.length > 1000 ||
      typeof args.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(args.operationId))
    throw new AdminActionError('invalid_deletion_request');
  if (!await accountDeletionAvailable(env)) throw new AdminActionError('account_deletion_unavailable', 503);
  const reason = args.reason.trim(), operationId = args.operationId;
  const requestHash = await sha256(stableJson({ id, reason, operationId }));
  let prior = await receipt(env, id);
  if (prior && prior.request_hash !== requestHash) throw new AdminActionError('deletion_in_progress', 409);
  if (!prior) {
    const player = await env.DB.prepare('SELECT id FROM player WHERE id=? AND save_state!=?').bind(id, 'deleted').first();
    if (!player) throw new AdminActionError('player_not_found', 404);
    const now = Date.now();
    // The receipt and write guards become visible atomically with revoked access.
    const sql = (query: string, ...values: (string | number)[]) => env.DB.prepare(query).bind(...values);
    try {
      await env.DB.batch([
        sql("INSERT INTO account_deletion(player_id,operation_id,actor_id,reason,request_hash,state,created_at) VALUES(?,?,?,?,?,'cleanup_pending',?)", id, operationId, actor.id, reason, requestHash, now),
        ...['save_revision', 'classic_backup_revision', 'legacy_admin_revision'].map(table => sql(`INSERT OR IGNORE INTO account_deletion_blob SELECT ?,r2_key FROM ${table} WHERE player_id=?`, id, id)),
        sql('UPDATE auth_session SET revoked_at=? WHERE player_id=? AND revoked_at IS NULL', Math.floor(now / 1000), id),
        sql('UPDATE auth_device_credential SET revoked_at=? WHERE player_id=? AND revoked_at IS NULL', Math.floor(now / 1000), id),
        sql('DELETE FROM auth_refresh WHERE session_id IN (SELECT id FROM auth_session WHERE player_id=?)', id),
        ...['auth_identity', 'auth_bootstrap', 'auth_challenge', 'classic_auth_proof', 'password_recovery', 'purchase_guest', 'classic_migration_email'].map(table => sql(`DELETE FROM ${table} WHERE player_id=?`, id)),
        sql("INSERT INTO player_ban(player_id,reason,created_at,expires_at,revoked_at) VALUES(?,'account_deleted',?,NULL,NULL) ON CONFLICT(player_id) DO UPDATE SET reason='account_deleted',created_at=excluded.created_at,expires_at=NULL,revoked_at=NULL", id, Math.floor(now / 1000)),
        sql("UPDATE player SET display_name=NULL,device_id=NULL,playtime=0,save_version=0,save_state='deleted',migrated_at=NULL,updated_at=? WHERE id=?", now, id),
        sql("INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES(?,?,?,'account.delete.started',?,?,?)", `delete-start:${operationId}`, actor.id, actor.name, id, stableJson({ operationId, reason }), now),
      ]);
    } catch {
      prior = await receipt(env, id);
      if (!prior || prior.request_hash !== requestHash) throw new AdminActionError(prior ? 'deletion_in_progress' : 'deletion_start_failed', prior ? 409 : 503);
    }
  }
  prior = await receipt(env, id);
  if (prior?.state === 'complete') return { deleted: true, playerId: id };
  // Keep the manifest and blocked account until every committed snapshot is removed.
  try {
    for (;;) {
      const rows = await env.DB.prepare('SELECT r2_key FROM account_deletion_blob WHERE player_id=? LIMIT 100').bind(id).all<{ r2_key: string }>();
      if (!rows.results.length) break;
      await env.PLAYER_SAVES.delete(rows.results.map(row => row.r2_key));
      await env.DB.batch(rows.results.map(row => env.DB.prepare('DELETE FROM account_deletion_blob WHERE player_id=? AND r2_key=?').bind(id, row.r2_key)));
    }
    // Child rows precede their referenced snapshots. Financial facts, grant replay
    // protection, immutable source archives and the minimal blocked player remain.
    const tables = ['auth_session', 'auth_device_credential', 'liveops_grant_ack', 'liveops_coupon_claim', 'liveops_mail', 'liveops_news_read',
      'classic_leaderboard_submission', 'classic_leaderboard_entry', 'player_leaderboard', 'grant_receipt', 'save_operation',
      'classic_migration', 'classic_backup_head', 'classic_backup_revision', 'save_revision', 'legacy_admin_head', 'legacy_admin_revision',
      'classic_save_owner', 'mail', 'migration_identity_proof', 'migration_record', 'recovery_event'];
    await env.DB.batch([
      ...tables.map(table => env.DB.prepare(`DELETE FROM ${table} WHERE player_id=?`).bind(id)),
      env.DB.prepare("UPDATE account_deletion SET state='complete',completed_at=? WHERE player_id=? AND request_hash=?").bind(Date.now(), id, requestHash),
      env.DB.prepare("INSERT OR IGNORE INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES(?,?,?,'account.delete.completed',?,?,?)").bind(`delete-end:${operationId}`, actor.id, actor.name, id, stableJson({ operationId }), Date.now()),
    ]);
  } catch { throw new AdminActionError('deletion_incomplete_retry', 503); }
  return { deleted: true, playerId: id };
}
