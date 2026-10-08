import type { Env } from '../env';
import { GameError, sha256, stableJson, validateSnapshot, type Snapshot } from './validation';
import { fortressScore } from './leaderboard';
import { applyRewardFlags } from './rewards';
export interface SaveResult { playerId: string; saveVersion: number; playtime: number; data: Record<string,string>; saveState: string; operationId: string }
interface Revision { version: number; r2_key: string; sha256: string; playtime: number; operation_id: string; payload_hash: string }
export interface PublicationOptions {
  allowPlaytimeDecrease?: boolean; legacy?: boolean; saveState?: string;
  grant?: { sourceId: string; mailId?: string };
  migration?: { cloudArchive: string; localArchive: string; winner: string };
  adminAudit?: { id: string; actorId: string; actorName: string; action: string; detail: unknown };
  migrationMail?: { id: string; rewardsJson: string };
  purchase?: {key:string;entitlements:Record<string,string>};
}
async function readRevision(env: Env, playerId: string, row: Revision, saveState: string): Promise<SaveResult> {
  const object = await env.PLAYER_SAVES.get(row.r2_key);
  if (!object) throw new GameError('save_storage_unavailable',503);
  const bytes = await object.text();
  if (await sha256(bytes) !== row.sha256) throw new GameError('save_integrity_failure',503);
  const snapshot = JSON.parse(bytes) as Snapshot;
  return {playerId,saveVersion:row.version,playtime:row.playtime,data:snapshot.data,saveState,operationId:row.operation_id};
}
export async function loadSnapshot(env: Env, playerId: string): Promise<SaveResult> {
  const player = await env.DB.prepare('SELECT save_version,save_state FROM player WHERE id=?').bind(playerId).first<{save_version:number;save_state:string}>();
  if (!player) throw new GameError('player_not_found',404);
  if (!player.save_version) throw new GameError('no_save',404,player.save_state);
  const row = await env.DB.prepare('SELECT * FROM save_revision WHERE player_id=? AND version=?').bind(playerId,player.save_version).first<Revision>();
  if (!row) throw new GameError('save_integrity_failure',503);
  return readRevision(env,playerId,row,player.save_state);
}
export async function replayOperation(env: Env, playerId: string, operationId: string, payloadHash?: string): Promise<SaveResult | null> {
  const row = await env.DB.prepare('SELECT r.* FROM save_operation o JOIN save_revision r ON r.player_id=o.player_id AND r.version=o.version WHERE o.player_id=? AND o.operation_id=?').bind(playerId,operationId).first<Revision>();
  if (!row) return null;
  if (payloadHash && payloadHash !== row.payload_hash) throw new GameError('operation_id_reused',409);
  const player = await env.DB.prepare('SELECT save_state FROM player WHERE id=?').bind(playerId).first<{save_state:string}>();
  return readRevision(env,playerId,row,player?.save_state || 'native_ready');
}
export async function publishSnapshot(env: Env, playerId: string, input: unknown, options: PublicationOptions = {}): Promise<SaveResult> {
  const original=validateSnapshot(input,options.legacy);
  let snapshot=original.snapshot;
  const payloadHash = await sha256(stableJson({snapshot,options}));
  const replay = await replayOperation(env,playerId,snapshot.operationId,payloadHash);
  if (replay) return replay;
  // The original request hash is stable across paid-flag enforcement and response-loss retries.
  if(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_entitlement'").first()) {
    const paid=await env.DB.prepare('SELECT key,value FROM purchase_entitlement WHERE player_id=?').bind(playerId).all<{key:string;value:string}>();
    if(paid.results.length)snapshot={...snapshot,data:applyRewardFlags(snapshot.data,Object.fromEntries(paid.results.map(row=>[row.key,row.value])))};
  }
  if(options.purchase) {
    const ledger=await env.DB.prepare('SELECT player_id,status FROM purchase_ledger WHERE purchase_key=?').bind(options.purchase.key).first<{player_id:string;status:string}>();
    if(!ledger||ledger.player_id!==playerId||ledger.status!=='verified_pending')throw new GameError('purchase_not_pending_or_owner_mismatch',409);
    snapshot={...snapshot,data:applyRewardFlags(snapshot.data,options.purchase.entitlements)};
  }
  const {healthy}=validateSnapshot(snapshot,options.legacy),score=fortressScore(snapshot.data);
  const player = await env.DB.prepare('SELECT save_version,playtime,save_state FROM player WHERE id=?').bind(playerId).first<{save_version:number;playtime:number;save_state:string}>();
  if (!player) throw new GameError('player_not_found',404);
  if (player.save_version !== snapshot.expectedSaveVersion) {
    if(options.grant) {
      const prior=await env.DB.prepare('SELECT operation_id FROM grant_receipt WHERE player_id=? AND source_id=?').bind(playerId,options.grant.sourceId).first<{operation_id:string}>();
      if(prior) {const canonical=await replayOperation(env,playerId,prior.operation_id);if(canonical)return canonical;}
    }
    throw new GameError('save_conflict',409);
  }
  if (player.save_version && !healthy) {
    const current=await loadSnapshot(env,playerId);
    const previous=validateSnapshot({game:'ec1',schemaVersion:1,playtime:current.playtime,data:current.data,expectedSaveVersion:current.saveVersion,operationId:current.operationId},true);
    if(previous.healthy) throw new GameError('damaged_save_rejected',409,'default_profile_cannot_replace_healthy_revision');
  }
  if (!player.save_version && !healthy && snapshot.intent !== 'new_game') throw new GameError('new_game_intent_required',409);
  if (!options.allowPlaytimeDecrease && snapshot.playtime < player.playtime) throw new GameError('playtime_regression',409);
  const bytes = stableJson(snapshot), hash = await sha256(bytes);
  const key = `ec1/${encodeURIComponent(playerId)}/${crypto.randomUUID()}/${hash}.json`;
  await env.PLAYER_SAVES.put(key,bytes,{httpMetadata:{contentType:'application/json'}});
  const staged = await env.PLAYER_SAVES.get(key);
  if (!staged || await sha256(await staged.text()) !== hash) throw new GameError('save_stage_verification_failed',503);
  const version = snapshot.expectedSaveVersion+1, now=Date.now();
  const state = options.saveState || (player.save_state==='imported_pending_auth'||player.save_state==='migrated'?player.save_state:'native_ready');
  const statements = [
    env.DB.prepare('INSERT INTO save_revision(player_id,version,r2_key,sha256,playtime,operation_id,payload_hash,created_at) SELECT id,?,?,?,?,?,?,? FROM player WHERE id=? AND save_version=?').bind(version,key,hash,snapshot.playtime,snapshot.operationId,payloadHash,now,playerId,snapshot.expectedSaveVersion),
    env.DB.prepare('INSERT INTO save_operation(player_id,operation_id,payload_hash,version) SELECT player_id,operation_id,payload_hash,version FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?').bind(playerId,version,snapshot.operationId,payloadHash),
    env.DB.prepare('UPDATE player SET save_version=?,playtime=?,save_state=?,device_id=COALESCE(?,device_id),updated_at=? WHERE id=? AND save_version=? AND EXISTS(SELECT 1 FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?)').bind(version,snapshot.playtime,state,snapshot.deviceId||null,now,playerId,snapshot.expectedSaveVersion,playerId,version,snapshot.operationId,payloadHash),
  ];
  if (options.grant) {
    statements.push(env.DB.prepare('INSERT INTO grant_receipt(player_id,source_id,operation_id,save_version,created_at) SELECT player_id,?,operation_id,version,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?').bind(options.grant.sourceId,now,playerId,version,snapshot.operationId,payloadHash));
    if (options.grant.mailId) statements.push(env.DB.prepare('UPDATE mail SET claimed_at=?,grant_id=? WHERE id=? AND player_id=? AND claimed_at IS NULL AND EXISTS(SELECT 1 FROM grant_receipt WHERE player_id=? AND source_id=? AND operation_id=?)').bind(now,options.grant.sourceId,options.grant.mailId,playerId,playerId,options.grant.sourceId,snapshot.operationId));
  }
  if (options.migration) statements.push(env.DB.prepare("INSERT INTO migration_record(player_id,status,cloud_archive,local_archive,winner,save_version,created_at,updated_at) SELECT player_id,'imported_pending_auth',?,?,?,version,?,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=? ON CONFLICT(player_id) DO UPDATE SET status=excluded.status,cloud_archive=excluded.cloud_archive,local_archive=excluded.local_archive,winner=excluded.winner,save_version=excluded.save_version,reason=NULL,updated_at=excluded.updated_at").bind(options.migration.cloudArchive,options.migration.localArchive,options.migration.winner,now,now,playerId,version,snapshot.operationId,payloadHash));
  if(options.adminAudit) statements.push(env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) SELECT ?,?,?,?,player_id,?,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?').bind(options.adminAudit.id,options.adminAudit.actorId,options.adminAudit.actorName,options.adminAudit.action,stableJson(options.adminAudit.detail),now,playerId,version,snapshot.operationId,payloadHash));
  if(options.migrationMail) statements.push(env.DB.prepare("INSERT OR IGNORE INTO mail(id,player_id,title,body,rewards_json,created_at) SELECT ?,player_id,'Legacy rewards','Unclaimed rewards preserved from your legacy account.',?,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?").bind(options.migrationMail.id,options.migrationMail.rewardsJson,now,playerId,version,snapshot.operationId,payloadHash));
  if(options.purchase) {
    statements.push(env.DB.prepare("UPDATE purchase_ledger SET status='granted',operation_id=?,save_version=?,granted_at=? WHERE purchase_key=? AND player_id=? AND status='verified_pending' AND EXISTS(SELECT 1 FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=?)").bind(snapshot.operationId,version,now,options.purchase.key,playerId,playerId,version,snapshot.operationId,payloadHash));
    for(const [entitlement,value]of Object.entries(options.purchase.entitlements))statements.push(env.DB.prepare('INSERT INTO purchase_entitlement(player_id,key,value,source_key) SELECT player_id,?,?,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=? ON CONFLICT(player_id,key) DO UPDATE SET value=excluded.value,source_key=excluded.source_key').bind(entitlement,value,options.purchase.key,playerId,version,snapshot.operationId,payloadHash));
  }
  statements.push(env.DB.prepare('INSERT INTO player_leaderboard(player_id,score,save_version,updated_at) SELECT player_id,?,version,? FROM save_revision WHERE player_id=? AND version=? AND operation_id=? AND payload_hash=? ON CONFLICT(player_id) DO UPDATE SET score=excluded.score,save_version=excluded.save_version,updated_at=excluded.updated_at WHERE excluded.score>player_leaderboard.score OR ?=1').bind(score,now,playerId,version,snapshot.operationId,payloadHash,options.adminAudit?1:0));
  try { await env.DB.batch(statements); } catch {
    const committed = await replayOperation(env,playerId,snapshot.operationId,payloadHash);
    if (committed) return committed;
    if(options.grant) {
      const granted=await env.DB.prepare('SELECT operation_id FROM grant_receipt WHERE player_id=? AND source_id=?').bind(playerId,options.grant.sourceId).first<{operation_id:string}>();
      if(granted) {const canonical=await replayOperation(env,playerId,granted.operation_id);if(canonical)return canonical;throw new GameError('save_integrity_failure',503);}
    }
    const current = await env.DB.prepare('SELECT save_version FROM player WHERE id=?').bind(playerId).first<{save_version:number}>();
    if (current?.save_version !== snapshot.expectedSaveVersion) throw new GameError('save_conflict',409);
    if (options.grant && await env.DB.prepare('SELECT 1 FROM grant_receipt WHERE player_id=? AND source_id=?').bind(playerId,options.grant.sourceId).first()) throw new GameError('already_claimed',409);
    throw new GameError('save_publication_unavailable',503);
  }
  const committed = await replayOperation(env,playerId,snapshot.operationId,payloadHash);
  if (!committed) throw new GameError('save_conflict',409);
  return committed;
}
