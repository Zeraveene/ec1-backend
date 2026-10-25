import type { Env } from '../env';
import { AdminActionError } from './action-types';
import { sha256 } from '../game/validation';
export interface LegacySource { profile: {id:string;username:string|null;displayName:string|null;email:string|null;createdAt:string|null;lastLogin:string|null}; savedAt:string|null; data:Record<string,string> }
export type LegacyRow={player_id:string;revision:number;r2_key:string;sha256:string;original_key:string;playtime:number|null;actor_id:string;operation_id:string;request_hash:string;created_at:number};
export async function legacyEditsAvailable(env:Env){return !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_admin_revision'").first();}
export async function loadLegacyRevision(env:Env,id:string):Promise<{row:LegacyRow;source:LegacySource}|null>{
 if(!await legacyEditsAvailable(env))return null;
 const row=await env.DB.prepare('SELECT r.* FROM legacy_admin_head h JOIN legacy_admin_revision r ON r.player_id=h.player_id AND r.revision=h.revision WHERE h.player_id=?').bind(id.toUpperCase()).first<LegacyRow>();
 if(!row)return null;
 const object=await env.PLAYER_SAVES.get(row.r2_key);if(!object)throw new AdminActionError('revision_integrity_unavailable',503);
 const text=await object.text();if(await sha256(text)!==row.sha256)throw new AdminActionError('revision_integrity_unavailable',503);
 const source=JSON.parse(text) as LegacySource;
 if(source.profile.id.toUpperCase()!==id.toUpperCase()||typeof source.data?.CLOUD_ALL_DATA!=='string')throw new AdminActionError('revision_integrity_unavailable',503);
 return {row,source};
}
