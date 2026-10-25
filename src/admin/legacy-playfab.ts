import type { Env } from '../env';
import { GameError } from '../game/validation';
import { loadLegacyRevision } from './legacy-edit-storage';
import { inspectLegacySave } from './legacy-save';
const idPattern = /^[A-Fa-f0-9]{8,64}$/;
const str = (v: unknown): string | null => typeof v === 'string' && v.length <= 512 ? v : null;
// Separate admin reads from player migration activation. These two endpoints are immutable.
async function call(env: Env, endpoint: 'Admin/GetUserAccountInfo' | 'Server/GetUserData', body: Record<string, unknown>) {
  if (!env.PLAYFAB_TITLE_ID || !/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID) || !env.PLAYFAB_SECRET_KEY) throw new GameError('legacy_viewer_not_configured', 503);
  try {
    const response = await fetch(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/${endpoint}`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-SecretKey': env.PLAYFAB_SECRET_KEY }, body: JSON.stringify(body) });
    const result = await response.json() as Record<string, any>;
    if (response.status === 400 && ['AccountNotFound','UserNotFound'].includes(result.error)) return null;
    if (!response.ok || result.error || !result.data || typeof result.data !== 'object') throw new Error('unavailable');
    return result.data as Record<string, any>;
  } catch { throw new GameError('legacy_source_unavailable', 503); }
}
function account(info: any) {
  if (!info || typeof info.PlayFabId !== 'string' || !idPattern.test(info.PlayFabId)) throw new GameError('legacy_source_unavailable', 503);
  return { id: info.PlayFabId, username: str(info.Username), displayName: str(info.TitleInfo?.DisplayName), email: str(info.PrivateInfo?.Email), createdAt: str(info.Created), lastLogin: str(info.TitleInfo?.LastLogin) };
}
export async function searchLegacy(env: Env, query: string) {
  const selectors = query.includes('@') ? [{ Email: query }] : [...(idPattern.test(query) ? [{ PlayFabId: query }] : []), ...(query.length >= 3 && query.length <= 20 ? [{ Username: query }] : []), { TitleDisplayName: query }];
  const results = new Map<string, ReturnType<typeof account>>();
  // A failed selector is an outage, never a false empty result.
  for (const selector of selectors) { const result = await call(env, 'Admin/GetUserAccountInfo', selector); if (result) { const row = account(result.UserInfo); results.set(row.id, row); } }
  return { results: [...results.values()] };
}
export async function readLegacySource(env: Env, id: string) {
  const result = await call(env, 'Admin/GetUserAccountInfo', { PlayFabId: id });
  if (!result) throw new GameError('legacy_account_not_found', 404);
  const profile = account(result.UserInfo);
  if (profile.id.toUpperCase() !== id.toUpperCase()) throw new GameError('legacy_source_unavailable', 503);
  const resultData = await call(env, 'Server/GetUserData', { PlayFabId: profile.id, Keys: ['CLOUD_ALL_DATA', 'Playtime'] });
  if (!resultData?.Data || typeof resultData.Data !== 'object') throw new GameError('legacy_source_unavailable', 503);
  return { profile, savedAt: str(resultData.Data.CLOUD_ALL_DATA?.LastUpdated), data: { ...(typeof resultData.Data.CLOUD_ALL_DATA?.Value === 'string' ? {CLOUD_ALL_DATA:resultData.Data.CLOUD_ALL_DATA.Value} : {}), ...(typeof resultData.Data.Playtime?.Value === 'string' ? {Playtime:resultData.Data.Playtime.Value} : {}) } };
}
export async function viewLegacy(env: Env, id: string) {
  const saved=await loadLegacyRevision(env,id);
  const source=saved?.source??await readLegacySource(env,id);
  return {profile:source.profile,savedAt:source.savedAt,revision:saved?.row.revision??0,source:saved?'backend_revision':'playfab',...inspectLegacySave(source.data.CLOUD_ALL_DATA,source.data.Playtime)};
}

export async function auditLegacyRead(env: Env, actor: { id: string; name: string }, operation: string, args: Record<string, unknown>) {
  try {
    await env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), actor.id, actor.name, operation, operation === 'legacy-player' && typeof args.id === 'string' && idPattern.test(args.id) ? args.id : null, '{}', Date.now()).run();
  } catch { throw new GameError('audit_unavailable', 503); }
}
