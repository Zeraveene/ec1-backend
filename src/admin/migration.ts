import type { Env } from '../env';
import { AdminActionError, requireWriter, type AdminActor } from './action-types';
import { sha256, stableJson } from '../game/validation';
import { convertLegacyCloud } from '../migration/legacy-conversion';
import { loadLegacyRevision } from './legacy-edit-storage';
import { migrationPassword, migrationEmailStatus } from './migration-email';

const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function playerId(v: unknown) { if (typeof v !== 'string' || !/^[A-Fa-f0-9]{8,64}$/.test(v)) throw new AdminActionError('invalid_player_id'); return v.toUpperCase(); }
async function stage(bucket: R2Bucket, key: string, text: string) {
  const hash = await sha256(text); await bucket.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  const check = await bucket.get(key); if (!check || await sha256(await check.text()) !== hash) throw new AdminActionError('migration_stage_unavailable', 503);
  return hash;
}
async function read(env: Env, method: string, id: string) {
  if (!['GetUserAccountInfo', 'GetUserData', 'GetUserInventory', 'GetUserBans'].includes(method)) throw new AdminActionError('legacy_mutation_forbidden', 403);
  if (!env.PLAYFAB_TITLE_ID || !/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID) || !env.PLAYFAB_SECRET_KEY) throw new AdminActionError('migration_not_configured', 503);
  try {
    const response = await fetch(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Admin/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SecretKey': env.PLAYFAB_SECRET_KEY }, body: JSON.stringify({ PlayFabId: id }), signal: AbortSignal.timeout(10000) });
    const result: any = await response.json();
    if (response.status === 400 && ['AccountNotFound', 'UserNotFound'].includes(result.error)) throw new AdminActionError('legacy_account_not_found', 404);
    if (!response.ok || result.error || !object(result.data)) throw new Error('unavailable'); return result.data;
  } catch (e) { if (e instanceof AdminActionError) throw e; throw new AdminActionError('legacy_source_unavailable', 503); }
}
// One serialized snapshot binds the review and transaction to all target state.
const stateSql = `WITH target(id) AS (SELECT ?) SELECT json_object('player',json((SELECT json_object('saveVersion',save_version,'migratedAt',migrated_at,'state',save_state,'name',display_name) FROM player WHERE id=(SELECT id FROM target))),
 'revisions',(SELECT count(*) FROM classic_backup_revision WHERE player_id=(SELECT id FROM target)),'oldRevisions',(SELECT count(*) FROM save_revision WHERE player_id=(SELECT id FROM target)),
 'migration',(SELECT count(*) FROM classic_migration WHERE player_id=(SELECT id FROM target)),
 'legacyRevision',COALESCE((SELECT revision FROM legacy_admin_head WHERE player_id=(SELECT id FROM target)),0),
 'identities',json((SELECT json_group_array(json_object('provider',provider,'subject',subject,'hash',password_hash,'salt',salt)) FROM (SELECT * FROM auth_identity WHERE player_id=(SELECT id FROM target) ORDER BY provider,subject)))) state`;
async function target(env: Env, id: string) {
  const row = await env.DB.prepare(stateSql).bind(id).first<{ state: string }>(); if (!row) throw new AdminActionError('storage_unavailable', 503);
  const parsed = JSON.parse(row.state);
  if (parsed.revisions || parsed.oldRevisions || parsed.player?.saveVersion || parsed.player?.migratedAt) throw new AdminActionError('backend_save_already_exists', 409);
  if (parsed.migration) throw new AdminActionError('migration_in_progress', 409);
  return { raw: row.state, value: parsed };
}
async function source(env: Env, actor: AdminActor, id: string) {
  if (env.LEGACY_MIGRATION_ENABLED !== 'true') throw new AdminActionError('migration_disabled', 503);
  const current = await target(env, id);
  const [account, userData, inventory, bans, edited] = await Promise.all([
    read(env, 'GetUserAccountInfo', id), read(env, 'GetUserData', id), read(env, 'GetUserInventory', id), read(env, 'GetUserBans', id), loadLegacyRevision(env, id),
  ]);
  const info = account.UserInfo;
  if (!object(info) || info.PlayFabId !== id || !object(userData.Data) || !Array.isArray(inventory.Inventory) || !Array.isArray(bans.BanData)) throw new AdminActionError('invalid_legacy_response', 409);
  // Preserve live source and selected backend edit before parsing/converting.
  const effectiveUserData = edited ? { ...userData, Data: { ...userData.Data, ...Object.fromEntries(Object.entries(edited.source.data).map(([k, Value]) => [k, { Value }])) } } : userData;
  const archive = stableJson({ game: 'ec1', playerId: id, account, userData: effectiveUserData, originalUserData: userData, inventory, bans, backendRevision: edited ? { revision: edited.row.revision, source: edited.source } : null });
  const archiveHash = await sha256(archive), archiveKey = `ec1/admin-migration/${id}/${crypto.randomUUID()}/${archiveHash}.json`;
  await stage(env.LEGACY_ARCHIVE, archiveKey, archive);
  if (inventory.Inventory.length || Object.keys(inventory.VirtualCurrency ?? {}).length) throw new AdminActionError('migration_entitlement_review_required', 409);
  const data = Object.fromEntries(Object.entries(userData.Data).map(([k, v]) => {
    if (!object(v) || typeof v.Value !== 'string') throw new AdminActionError('invalid_legacy_response', 409); return [k, v.Value];
  }));
  // Staff edits are already immutable backend revisions; retain their original
  // provenance and migrate the latest reviewed revision, rather than losing it.
  const selected = edited?.source.data ?? data;
  if (data.EC_MAIL_REWARDS) {
    let mail: any; try { mail = JSON.parse(data.EC_MAIL_REWARDS); } catch { throw new AdminActionError('migration_mail_review_required', 409); }
    if (!Array.isArray(mail) || mail.length) throw new AdminActionError('migration_mail_review_required', 409);
  }
  const snapshot = convertLegacyCloud(selected.CLOUD_ALL_DATA, selected.Playtime);
  const google = info.GoogleInfo?.GoogleId;
  if (google !== undefined && (typeof google !== 'string' || !google || google.length > 256)) throw new AdminActionError('invalid_legacy_google', 409);
  const email = typeof info.PrivateInfo?.Email === 'string' && info.PrivateInfo.Email.trim().length <= 254 && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(info.PrivateInfo.Email.trim()) ? info.PrivateInfo.Email.trim().toLowerCase() : null;
  const native = current.value.identities as { provider: string; subject: string; hash: string | null }[];
  const links: { provider: string; subject: string; email?: string }[] = [];
  const conflicts: { provider: string; playerId: string }[] = [];
  for (const [provider, subject] of [['google', google], ['email', email]]) {
    if (!subject) continue;
    const owner = await env.DB.prepare('SELECT player_id FROM auth_identity WHERE provider=? AND subject=?').bind(provider, subject).first<{ player_id: string }>();
    const existing = native.find(i => i.provider === provider);
    if (owner && owner.player_id !== id) conflicts.push({ provider, playerId: owner.player_id });
    else if (existing && existing.subject !== subject) conflicts.push({ provider, playerId: id });
    else if (!existing) links.push({ provider, subject, ...(provider === 'google' && typeof info.GoogleInfo?.GoogleEmail === 'string' ? { email: info.GoogleInfo.GoogleEmail } : {}) });
  }
  if (!links.length && !conflicts.length && !native.some(i => ['google', 'apple', 'discord'].includes(i.provider) || i.provider === 'email' && i.hash)) throw new AdminActionError('legacy_login_unavailable', 409);
  const active: { expires: number | null }[] = [];
  const seen = new Set<string>();
  for (const ban of bans.BanData) {
    if (!object(ban) || typeof ban.BanId !== 'string' || !ban.BanId || ban.BanId.length > 128 || seen.has(ban.BanId) || typeof ban.Active !== 'boolean' || ban.PlayFabId !== undefined && ban.PlayFabId !== id || ban.Expires != null && ban.Expires !== '' && (typeof ban.Expires !== 'string' || !Number.isFinite(Date.parse(ban.Expires)))) throw new AdminActionError('invalid_legacy_bans', 409);
    seen.add(ban.BanId);
    if (ban.Active && (!ban.Expires || Date.parse(ban.Expires) > Date.now())) active.push({ expires: ban.Expires ? Math.ceil(Date.parse(ban.Expires) / 1000) : null });
  }
  const reviewSha256 = await sha256(stableJson({ actor: actor.id, id, info, data: userData.Data, inventory: inventory.Inventory, currency: inventory.VirtualCurrency, bans: bans.BanData, edited: edited ? { revision: edited.row.revision, hash: edited.row.sha256 } : null, state: current.raw, links, conflicts }));
  return { id, current, snapshot, archiveKey, archiveHash, rawHash: await sha256(selected.CLOUD_ALL_DATA), links, conflicts, email, native, active, reviewSha256, displayName: typeof info.TitleInfo?.DisplayName === 'string' ? info.TitleInfo.DisplayName : null, sourceRevision: edited?.row.revision ?? 0 };
}
export async function previewMigration(env: Env, actor: AdminActor, value: unknown) {
  requireWriter(actor); const id = playerId(value), s = await source(env, actor, id);
  return { id, displayName: s.displayName, playtime: s.snapshot.playtime, sourceRevision: s.sourceRevision, reviewSha256: s.reviewSha256, email: s.email, googleLinked: s.links.some(i => i.provider === 'google') || s.native.some(i => i.provider === 'google'), conflicts: s.conflicts, activeBanCount: s.active.length, existingLogins: s.native.map(i => i.provider), passwordEmail: s.links.some(i => i.provider === 'email') };
}
export async function applyMigration(env: Env, actor: AdminActor, value: unknown, args: Record<string, unknown>) {
  requireWriter(actor); const id = playerId(value);
  if (typeof args.operationId !== 'string' || !/^[-A-Za-z0-9_]{8,128}$/.test(args.operationId) || typeof args.reviewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.reviewSha256)) throw new AdminActionError('invalid_migration_review');
  const operation = args.operationId, review = args.reviewSha256;
  const replay = async () => {
    const row = await env.DB.prepare('SELECT * FROM admin_classic_migration WHERE operation_id=?').bind(operation).first<{ player_id: string; actor_id: string; review_sha256: string; response_json: string }>();
    if (row && (row.player_id !== id || row.actor_id !== actor.id || row.review_sha256 !== review)) throw new AdminActionError('operation_id_reused', 409);
    return row ? JSON.parse(row.response_json) : null;
  };
  const resultWithEmail = async (result: any) => { const email = await migrationEmailStatus(env, id); return { ...result, emailStatus: email.status === 'no_email' ? result.emailStatus : email.status }; };
  const prior = await replay(); if (prior) return resultWithEmail(prior);
  const s = await source(env, actor, id);
  if (s.reviewSha256 !== review) throw new AdminActionError('legacy_changed_refresh_preview', 409);
  if (s.conflicts.length) throw new AdminActionError('migration_identity_conflict', 409);
  const password = s.links.some(i => i.provider === 'email') ? await migrationPassword(env, id) : null;
  const hash = await sha256(s.snapshot.json), key = `ec1/manual/${id}/${crypto.randomUUID()}/${hash}.json`, time = Date.now(), seconds = Math.floor(time / 1000);
  await stage(env.PLAYER_SAVES, key, s.snapshot.json);
  const response = { migrated: true, playerId: id, revision: 1, sourceRevision: s.sourceRevision, loginStatus: s.links.some(i => i.provider === 'google') || s.native.some(i => i.provider === 'google') ? 'google_ready' : password ? 'email_ready' : 'native_ready', emailStatus: password ? 'pending' : 'existing_login' };
  const statements = [
    env.DB.prepare(`INSERT INTO admin_identity_guard(operation_id,valid) VALUES(?,CASE WHEN (${stateSql})=? THEN 1 ELSE 0 END)`).bind(operation, id, s.current.raw),
    env.DB.prepare("INSERT INTO player(id,display_name,save_state,playtime,created_at,updated_at,migrated_at) VALUES(?,?,'migrated',?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=COALESCE(player.display_name,excluded.display_name),save_state='migrated',playtime=excluded.playtime,updated_at=excluded.updated_at,migrated_at=excluded.migrated_at").bind(id, s.displayName, s.snapshot.playtime, seconds, seconds, seconds),
    env.DB.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash,source) VALUES(?,1,?,?,?,1,?,?,?,?,'playfab_migration')").bind(id, key, hash, s.snapshot.bytes, s.snapshot.playtime, time, operation, review),
    env.DB.prepare('INSERT INTO classic_backup_head(player_id,revision) VALUES(?,1)').bind(id),
    env.DB.prepare('INSERT INTO classic_migration(player_id,source_hash,archive_key,raw_save_hash,revision,completed_at,created_at) VALUES(?,?,?,?,1,?,?)').bind(id, s.archiveHash, s.archiveKey, s.rawHash, time, time),
  ];
  // Explicit SQL assertions plus uniqueness make native-login races roll back
  // the save, provenance, credentials, bans, audit and receipt together.
  for (const link of s.links) statements.push(env.DB.prepare('INSERT INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at,display_email) VALUES(?,?,?,?,?,?,?)').bind(link.provider, link.subject, id, link.provider === 'email' ? password!.digest : null, link.provider === 'email' ? password!.salt : null, seconds, link.email ?? (link.provider === 'email' ? link.subject : null)));
  if (password) statements.push(env.DB.prepare("INSERT INTO classic_migration_email(player_id,recipient,password_hash,encrypted_password,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)").bind(id, s.email, password.digest, password.encrypted, time, time));
  if (s.active.length) {
    const expiry = s.active.some(b => b.expires === null) ? null : Math.max(...s.active.map(b => b.expires!));
    statements.push(env.DB.prepare("INSERT INTO player_ban(player_id,reason,created_at,expires_at) VALUES(?,'Preserved legacy account ban',?,?) ON CONFLICT(player_id) DO UPDATE SET revoked_at=NULL,expires_at=CASE WHEN player_ban.revoked_at IS NULL AND (player_ban.expires_at IS NULL OR excluded.expires_at IS NULL) THEN NULL WHEN player_ban.revoked_at IS NOT NULL THEN excluded.expires_at ELSE MAX(player_ban.expires_at,excluded.expires_at) END").bind(id, seconds, expiry));
  }
  statements.push(
    env.DB.prepare("UPDATE auth_session SET revoked_at=? WHERE player_id=? AND scope='migration' AND revoked_at IS NULL").bind(seconds, id),
    env.DB.prepare("INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES(?,?,?,'legacy.migrate',?,?,?)").bind('classic-migration:' + operation, actor.id, actor.name, id, stableJson({ operation, revision: 1, sourceRevision: s.sourceRevision, archiveHash: s.archiveHash, reviewSha256: review, loginStatus: response.loginStatus, activeBans: s.active.length }), time),
    env.DB.prepare('INSERT INTO admin_classic_migration(operation_id,player_id,actor_id,review_sha256,response_json,created_at) VALUES(?,?,?,?,?,?)').bind(operation, id, actor.id, review, JSON.stringify(response), time),
    env.DB.prepare('DELETE FROM admin_identity_guard WHERE operation_id=?').bind(operation),
  );
  try { await env.DB.batch(statements); }
  catch {
    const committed = await replay(); if (committed) return resultWithEmail(committed);
    const fresh = await target(env, id); if (fresh.raw !== s.current.raw) throw new AdminActionError('migration_state_changed', 409);
    throw new AdminActionError('migration_publication_unavailable', 503);
  }
  return response;
}
