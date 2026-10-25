import type { Env } from '../env';
import { mac } from '../auth/crypto';
import { GameError, sha256, stableJson } from './validation';

export interface SaveOwnership { saveId:string; playerId:string; displayName:string; proof:string }
export function validateOwnership(value:unknown): SaveOwnership | null {
 if(value===undefined||value===null)return null;
 const o=value as SaveOwnership;
 if(typeof o!=='object'||Array.isArray(o)||typeof o.saveId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(o.saveId)||
    typeof o.playerId!=='string'||o.playerId.length>128||typeof o.displayName!=='string'||o.displayName.length>256||typeof o.proof!=='string'||o.proof.length>256)
  throw new GameError('malformed_snapshot',400,'ownership');
 if(!o.playerId&&o.proof)throw new GameError('invalid_ownership_proof');
 return o;
}
async function proof(env:Env,saveId:string,playerId:string){
 if(!env.PLAYER_TOKEN_SECRET)throw new GameError('ownership_signing_unavailable',503);
 return mac(env.PLAYER_TOKEN_SECRET,JSON.stringify(['ec1-save-ownership-v1',saveId,playerId]));
}
async function legacySaveId(playerId:string){return 'legacy_'+await sha256('ec1-legacy-save-v1:'+playerId);}
export async function ownershipEnvelope(env:Env,playerId:string,saveId?:string|null):Promise<SaveOwnership>{
 const lineage=saveId||await legacySaveId(playerId);
 const player=await env.DB.prepare('SELECT display_name FROM player WHERE id=?').bind(playerId).first<{display_name:string|null}>();
 return {saveId:lineage,playerId,displayName:player?.display_name||playerId,proof:await proof(env,lineage,playerId)};
}
export async function checkOwnership(env:Env,playerId:string,o:SaveOwnership):Promise<void>{
 // Historical envelopes are reserved to their account even before a subsequent upload registers them.
 if(o.saveId.startsWith('legacy_')&&o.saveId!==await legacySaveId(playerId))throw new GameError('account_mismatch',409);
 if(o.playerId&&o.playerId!==playerId){
  // Only disclose the name when the supplied signed ownership establishes its source.
  const valid=o.proof===await proof(env,o.saveId,o.playerId);
  throw new GameError('account_mismatch',409,undefined,valid?{owner:publicOwner(await ownershipEnvelope(env,o.playerId,o.saveId))}:undefined);
 }
 if(o.playerId&&o.proof!==await proof(env,o.saveId,playerId))throw new GameError('invalid_ownership_proof');
 const registered=await env.DB.prepare('SELECT player_id FROM classic_save_owner WHERE save_id=?').bind(o.saveId).first<{player_id:string}>();
 if(registered&&registered.player_id!==playerId)throw new GameError('account_mismatch',409,undefined,{owner:publicOwner(await ownershipEnvelope(env,registered.player_id,o.saveId))});
}
function publicOwner(o:SaveOwnership){return {saveId:o.saveId,playerId:o.playerId,displayName:o.displayName};}
export async function prepareOwnership(env:Env,playerId:string,json:string){
 const supplied=validateOwnership(JSON.parse(json).ownership);
 const legacy={...JSON.parse(json)};delete legacy.ownership;
 const ownership=await ownershipEnvelope(env,playerId,supplied?.saveId||'unbound_'+await sha256(stableJson(legacy)));
 await checkOwnership(env,playerId,supplied||{...ownership,playerId:'',proof:''});
 return {ownership,json:JSON.stringify({...JSON.parse(json),ownership})};
}
