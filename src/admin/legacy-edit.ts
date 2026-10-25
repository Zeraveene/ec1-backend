import type { Env } from '../env';
import { AdminActionError, requireWriter, type AdminActor } from './action-types';
import { readLegacySource } from './legacy-playfab';
import { legacyEditsAvailable, loadLegacyRevision, type LegacyRow, type LegacySource } from './legacy-edit-storage';
import { validateLegacyPatch, patchLegacyData } from './legacy-edit-patch';
import { inspectLegacySave } from './legacy-save';
import { sha256, stableJson } from '../game/validation';
const id=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Fa-f0-9]{8,64}$/.test(v))throw new AdminActionError('invalid_player_id');return v.toUpperCase();};
const projection=(source:LegacySource,revision:number)=>({profile:source.profile,savedAt:source.savedAt,revision,source:revision?'backend_revision':'playfab',...inspectLegacySave(source.data.CLOUD_ALL_DATA,source.data.Playtime)});
interface Review {actorId:string;playerId:string;revision:number;sourceHash:string;source:LegacySource;createdAt:number}
async function ready(env:Env){if(!await legacyEditsAvailable(env))throw new AdminActionError('legacy_edits_not_configured',503);}
async function stage(bucket:R2Bucket,key:string,text:string){const hash=await sha256(text);await bucket.put(key,text,{httpMetadata:{contentType:'application/json'}});const check=await bucket.get(key);if(!check||await sha256(await check.text())!==hash)throw new AdminActionError('save_stage_verification_failed',503);return hash;}
export async function legacyEditor(env:Env,actor:AdminActor,args:Record<string,unknown>){
 requireWriter(actor);const playerId=id(args.id);await ready(env);
 const latest=await loadLegacyRevision(env,playerId),source=latest?.source??await readLegacySource(env,playerId);
 if(typeof source.data.CLOUD_ALL_DATA!=='string')throw new AdminActionError('source_not_editable',409);
 const reviewId=crypto.randomUUID(),review:Review={actorId:actor.id,playerId,revision:latest?.row.revision??0,sourceHash:await sha256(stableJson(source.data)),source:source as LegacySource,createdAt:Date.now()};
 // Archive the untouched full source before parsing or editing; never delete this original.
 await stage(env.LEGACY_ARCHIVE,`ec1/admin-edit/${playerId}/${reviewId}.json`,stableJson(review));
 await env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(),actor.id,actor.name,'legacy.edit_review',playerId,'{}',Date.now()).run();
 return {...projection(review.source,review.revision),edit:{reviewId,expectedRevision:review.revision}};
}
export async function legacySaveEdit(env:Env,actor:AdminActor,args:Record<string,unknown>){
 requireWriter(actor);const playerId=id(args.id);await ready(env);
 if(Object.keys(args).some(k=>!['id','reviewId','expectedRevision','patch','operationId'].includes(k))||typeof args.reviewId!=='string'||!/^[-a-f0-9]{36}$/.test(args.reviewId)||!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<0||typeof args.operationId!=='string'||!/^[-A-Za-z0-9_]{8,128}$/.test(args.operationId))throw new AdminActionError('invalid_save_edit');
 const patch=validateLegacyPatch(args.patch),operationId=args.operationId,expected=Number(args.expectedRevision);
 const requestHash=await sha256(stableJson({actorId:actor.id,playerId,reviewId:args.reviewId,expectedRevision:expected,patch,operationId}));
 const result=(r:LegacyRow)=>({playerId,revision:r.revision,operationId:r.operation_id,createdAt:r.created_at});
 const replay=async()=>{const row=await env.DB.prepare('SELECT * FROM legacy_admin_revision WHERE player_id=? AND operation_id=?').bind(playerId,operationId).first<LegacyRow>();if(row&&(row.actor_id!==actor.id||row.request_hash!==requestHash))throw new AdminActionError('operation_id_reused',409);return row;};
 const prior=await replay();if(prior)return result(prior);
 const originalKey=`ec1/admin-edit/${playerId}/${args.reviewId}.json`,archived=await env.LEGACY_ARCHIVE.get(originalKey);
 if(!archived)throw new AdminActionError('edit_review_unavailable',409);
 const review=JSON.parse(await archived.text()) as Review;
 if(review.actorId!==actor.id||review.playerId!==playerId)throw new AdminActionError('edit_review_forbidden',403);
 if(review.revision!==expected||Date.now()-review.createdAt>86400000||await sha256(stableJson(review.source.data))!==review.sourceHash)throw new AdminActionError('edit_review_expired',409);
 const head=await loadLegacyRevision(env,playerId);
 if((head?.row.revision??0)!==expected)throw new AdminActionError('save_conflict',409);
 const current=head?.source??await readLegacySource(env,playerId);
 if(await sha256(stableJson(current.data))!==review.sourceHash)throw new AdminActionError('save_conflict',409);
 const data=patchLegacyData(review.source.data,patch);
 if(data.CLOUD_ALL_DATA===review.source.data.CLOUD_ALL_DATA)throw new AdminActionError('no_save_changes');
 const now=Date.now(),source:LegacySource={...review.source,data,savedAt:new Date(now).toISOString()},bytes=stableJson(source),n=expected+1;
 const key=`ec1/admin-edits/${playerId}/${crypto.randomUUID()}.json`,hash=await stage(env.PLAYER_SAVES,key,bytes);
 const playtime=inspectLegacySave(data.CLOUD_ALL_DATA,data.Playtime).account.playtime;
 const owns='player_id=? AND revision=? AND operation_id=? AND request_hash=?';
 try{await env.DB.batch([
  env.DB.prepare('INSERT INTO legacy_admin_revision(player_id,revision,r2_key,sha256,original_key,playtime,actor_id,operation_id,request_hash,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM legacy_admin_head WHERE player_id=?),0)=?').bind(playerId,n,key,hash,originalKey,playtime,actor.id,operationId,requestHash,now,playerId,expected),
  env.DB.prepare(`INSERT INTO legacy_admin_head(player_id,revision) SELECT player_id,revision FROM legacy_admin_revision WHERE ${owns} ON CONFLICT(player_id) DO UPDATE SET revision=excluded.revision WHERE legacy_admin_head.revision=?`).bind(playerId,n,operationId,requestHash,expected),
  env.DB.prepare(`INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) SELECT ?,?,?,'legacy.save_edit',player_id,?,? FROM legacy_admin_revision WHERE ${owns}`).bind(`legacy-save:${playerId}:${operationId}`,actor.id,actor.name,stableJson({revision:n,parentRevision:expected,accountFields:Object.keys(patch.account??{}),amountChanges:patch.amounts?.length??0,removals:patch.removals?.length??0}),now,playerId,n,operationId,requestHash),
 ]);}catch{const committed=await replay();if(committed)return result(committed);if(((await loadLegacyRevision(env,playerId))?.row.revision??0)!==expected)throw new AdminActionError('save_conflict',409);throw new AdminActionError('save_publication_unavailable',503);}
 const committed=await replay();if(!committed)throw new AdminActionError('save_conflict',409);return result(committed);
}
