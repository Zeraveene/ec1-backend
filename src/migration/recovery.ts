import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { GameError, sha256, stableJson } from '../game/validation';
import { ownershipEnvelope } from '../game/ownership';
import { validateCanonicalSnapshot } from '../game/backups';
import { rateLimit } from '../auth/maintenance';
import { readPlayFab } from './playfab';
import { convertLegacyCloud } from './legacy-conversion';
import { recoveryIdentity, issueRecoveryProof, verifyRecoveryProof, type RecoveryProof } from './recovery-proof';

const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
async function stage(bucket:R2Bucket,key:string,text:string){const hash=await sha256(text);await bucket.put(key,text,{httpMetadata:{contentType:'application/json'}});const read=await bucket.get(key);if(!read||await sha256(await read.text())!==hash)throw new GameError('legacy_recovery_stage_failed',503);return hash;}
export async function archiveRecoverySource(env:Env,id:string,value:unknown){const text=stableJson(value),hash=await sha256(text),key=`ec1/legacy-recovery/${encodeURIComponent(id)}/${crypto.randomUUID()}/${hash}.json`;await stage(env.LEGACY_ARCHIVE,key,text);return {archiveKey:key,archiveHash:hash};}
async function replay(env:Env,id:string,operation:string){const r=await env.DB.prepare('SELECT response_json FROM legacy_recovery_receipt WHERE player_id=? AND operation_id=?').bind(id,operation).first<{response_json:string}>();return r?JSON.parse(r.response_json):null;}
const emptySql=`EXISTS(SELECT 1 FROM player WHERE id=? AND save_version=0)
 AND NOT EXISTS(SELECT 1 FROM classic_backup_head WHERE player_id=?)
 AND NOT EXISTS(SELECT 1 FROM classic_backup_revision WHERE player_id=?)
 AND NOT EXISTS(SELECT 1 FROM save_revision WHERE player_id=?)`;
async function empty(env:Env,id:string){const r=await env.DB.prepare(`SELECT (${emptySql}) AS empty`).bind(id,id,id,id).first<{empty:number}>();if(!r?.empty)throw new GameError('cloud_backup_already_exists',409);}
function aliases(p:Pick<RecoveryProof,'gpgsId'|'playFabId'>){return ['gpgs:'+p.gpgsId,...(p.playFabId?['playfab:'+p.playFabId]:[])];}
async function unclaimed(env:Env,id:string,keys:string[]){for(const key of keys){const row=await env.DB.prepare('SELECT player_id FROM legacy_recovery_claim WHERE source_key=?').bind(key).first<{player_id:string}>();if(row)throw new GameError(row.player_id===id?'legacy_source_already_recovered':'legacy_source_claimed',409);}}
export function recoveryOperation(b:any){if(!object(b)||typeof b.operationId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(b.operationId))throw new GameError('invalid_recovery_request');return b.operationId as string;}
export async function publishRecovery(env:Env,id:string,op:string,p:Pick<RecoveryProof,'gpgsId'|'playFabId'>,raw:string,playtime:string|undefined,original:{archiveKey:string;archiveHash:string},source:string,createGpgsIdentity=false){
  const keys=aliases(p);
  if(!createGpgsIdentity||await env.DB.prepare('SELECT 1 FROM player WHERE id=?').bind(id).first())await empty(env,id);
  await unclaimed(env,id,keys);
  let converted;try{converted=convertLegacyCloud(raw,playtime);}catch{throw new GameError('legacy_save_invalid',409);}
  // Imported data belongs to the authenticated destination; no client owner or
  // current local snapshot participates in conversion or publication.
  const ownership=await ownershipEnvelope(env,id,'recovered_'+await sha256(keys[0]));
  const stamped=validateCanonicalSnapshot(JSON.stringify({...JSON.parse(converted.json),ownership}));
  const json=stamped.json,hash=await sha256(json),now=Date.now(),guard=crypto.randomUUID();
  const key=`ec1/manual/${encodeURIComponent(id)}/${crypto.randomUUID()}/${hash}.json`;
  await stage(env.PLAYER_SAVES,key,json);
  const result={playerId:id,status:'recovered',exists:true,revision:1,playtime:converted.playtime,schemaVersion:1,sha256:hash,bytes:new TextEncoder().encode(json).length,createdAt:now,operationId:op,ownership};
  try{await env.DB.batch([
    ...(createGpgsIdentity?[
      env.DB.prepare("INSERT OR IGNORE INTO player(id,save_state,created_at,updated_at) VALUES(?,'migrated',?,?)").bind(id,Math.floor(now/1000),Math.floor(now/1000)),
      env.DB.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('gpgs',?,?,?)").bind(p.gpgsId,id,Math.floor(now/1000)),
    ]:[]),
    env.DB.prepare(`INSERT INTO legacy_recovery_guard(id,valid) VALUES(?,CASE WHEN ${emptySql} THEN 1 ELSE 0 END)`).bind(guard,id,id,id,id),
    env.DB.prepare('INSERT INTO legacy_recovery_guard(id,valid) VALUES(?,CASE WHEN NOT EXISTS(SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)) THEN 1 ELSE 0 END)').bind(guard+'-ban',id,Math.floor(now/1000)),
    ...keys.map(k=>env.DB.prepare('INSERT INTO legacy_recovery_claim(source_key,player_id,claimed_at) VALUES(?,?,?)').bind(k,id,now)),
    env.DB.prepare('INSERT INTO classic_save_owner(save_id,player_id,claimed_at) VALUES(?,?,?)').bind(ownership.saveId,id,now),
    env.DB.prepare('INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash,source,save_id) VALUES(?,1,?,?,?,1,?,?,?,?,?,?)').bind(id,key,hash,result.bytes,converted.playtime,now,op,original.archiveHash,source,ownership.saveId),
    env.DB.prepare('INSERT INTO classic_backup_head(player_id,revision) VALUES(?,1)').bind(id),
    ...(createGpgsIdentity?[env.DB.prepare("UPDATE player SET save_state='migrated',playtime=?,migrated_at=COALESCE(migrated_at,?),updated_at=? WHERE id=?").bind(converted.playtime,Math.floor(now/1000),Math.floor(now/1000),id)]:[]),
    env.DB.prepare('INSERT INTO legacy_recovery_receipt(player_id,operation_id,source_key,archive_key,archive_hash,response_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,op,keys[0],original.archiveKey,original.archiveHash,JSON.stringify(result),now),
    env.DB.prepare('DELETE FROM legacy_recovery_guard WHERE id=?').bind(guard),
    env.DB.prepare('DELETE FROM legacy_recovery_guard WHERE id=?').bind(guard+'-ban'),
  ]);}catch{const previous=await replay(env,id,op);if(previous)return previous;if(await env.DB.prepare('SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').bind(id,Math.floor(Date.now()/1000)).first())throw new GameError('player_banned',403);if(!createGpgsIdentity||await env.DB.prepare('SELECT 1 FROM player WHERE id=?').bind(id).first())await empty(env,id);await unclaimed(env,id,keys);throw new GameError('legacy_recovery_publication_failed',503);}
  return result;
}
export async function readRecoverySource(env:Env,id:string,identity:{gpgsId:string;playFabId:string|null;account:any}){
  let userData:any=null,inventory:any=null;
  if(identity.playFabId)[userData,inventory]=await Promise.all([readPlayFab(env,'Server/GetUserData',{PlayFabId:identity.playFabId}),readPlayFab(env,'Server/GetUserInventory',{PlayFabId:identity.playFabId})]);
  const preserved=await archiveRecoverySource(env,id,{game:'ec1',source:'playfab',gpgsId:identity.gpgsId,playFabId:identity.playFabId,account:identity.account,userData,inventory});
  if(identity.playFabId){
    if(!object(userData?.Data)||!Array.isArray(inventory?.Inventory)||!object(inventory?.VirtualCurrency??{}))throw new GameError('invalid_legacy_response',409);
    if(inventory.Inventory.length||Object.keys(inventory.VirtualCurrency??{}).length)throw new GameError('migration_entitlement_review_required',409);
    const mail=userData.Data.EC_MAIL_REWARDS?.Value;
    if(mail){let parsed:any;try{parsed=JSON.parse(mail);}catch{throw new GameError('migration_mail_review_required',409);}if(!Array.isArray(parsed)||parsed.length)throw new GameError('migration_mail_review_required',409);}
    // Missing core is absence; present empty/malformed core is damaged data.
    if(Object.prototype.hasOwnProperty.call(userData.Data,'CLOUD_ALL_DATA')){
      const raw=userData.Data.CLOUD_ALL_DATA?.Value;if(typeof raw!=='string'||!raw.trim())throw new GameError('legacy_save_invalid',409);
      return {...preserved,rawSaveJson:raw,legacyPlaytime:userData.Data.Playtime?.Value as string|undefined};
    }
  }
  return {...preserved,rawSaveJson:null,legacyPlaytime:undefined};
}
export async function preserveGoogleRecovery(env:Env,id:string,proof:RecoveryProof,b:any){
  if(typeof b.rawSaveJson!=='string'||!b.rawSaveJson.trim()||b.rawSaveJson.length>2_000_000||b.legacyPlaytime!=null&&(typeof b.legacyPlaytime!=='number'||!Number.isFinite(b.legacyPlaytime)||b.legacyPlaytime<0))throw new GameError('invalid_recovery_request');
  const original=await env.LEGACY_ARCHIVE.get(proof.archiveKey);if(!original||await sha256(await original.text())!==proof.archiveHash)throw new GameError('legacy_archive_integrity_failure',503);
  return archiveRecoverySource(env,id,{game:'ec1',source:'google_saved_games',slot:'savegame',gpgsId:proof.gpgsId,playFabId:proof.playFabId,priorArchive:proof.archiveKey,priorHash:proof.archiveHash,rawSaveJson:b.rawSaveJson,legacyPlaytime:b.legacyPlaytime??null});
}
export function createLegacyRecoveryApp(){
  const app=new Hono<AppEnv>();
  app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');if(c.get('player').scope!=='player')throw new GameError('insufficient_scope',403);if(c.env.EC1_MANUAL_BACKUPS_ENABLED!=='true'||c.env.LEGACY_MIGRATION_ENABLED!=='true')throw new GameError('legacy_recovery_disabled',503);await next();});
  app.post('/',async c=>{
    let b:any;try{b=await c.req.json();}catch{throw new GameError('invalid_request');}
    const id=c.get('player').playerId,op=recoveryOperation(b),prior=await replay(c.env,id,op);if(prior)return c.json(prior);
    await empty(c.env,id);await rateLimit(c.env,'legacy-recovery',id,10,300);
    const identity=await recoveryIdentity(c.env,b);await unclaimed(c.env,id,aliases(identity));
    const preserved=await readRecoverySource(c.env,id,identity);
    if(preserved.rawSaveJson!==null)return c.json(await publishRecovery(c.env,id,op,identity,preserved.rawSaveJson,preserved.legacyPlaytime,preserved,'playfab_recovery'));
    const recoveryToken=await issueRecoveryProof(c.env,{playerId:id,gpgsId:identity.gpgsId,playFabId:identity.playFabId,operationId:op,...preserved,expires:Date.now()+10*60*1000});
    return c.json({playerId:id,status:'google_saved_games_required',recoveryToken});
  });
  app.post('/google',async c=>{
    let b:any;try{b=await c.req.json();}catch{throw new GameError('invalid_request');}
    const id=c.get('player').playerId,op=recoveryOperation(b),proof=await verifyRecoveryProof(c.env,b.recoveryToken,id,op);
    const prior=await replay(c.env,id,op);if(prior)return c.json(prior);
    await empty(c.env,id);await unclaimed(c.env,id,aliases(proof));
    const preserved=await preserveGoogleRecovery(c.env,id,proof,b);
    return c.json(await publishRecovery(c.env,id,op,proof,b.rawSaveJson,b.legacyPlaytime==null?undefined:String(b.legacyPlaytime),preserved,'google_saved_games_recovery'));
  });return app;
}


