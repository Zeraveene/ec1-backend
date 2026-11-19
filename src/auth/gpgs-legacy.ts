import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from '../env';
import { GameError, sha256 } from '../game/validation';
import { verifyGpgsIdentity, legacyGpgsIdentity, issueRecoveryProof, verifyRecoveryProof } from '../migration/recovery-proof';
import { recoveryOperation, readRecoverySource, publishRecovery, preserveGoogleRecovery } from '../migration/recovery';
import { rateLimit } from './maintenance';

const proofDomain='ec1-gpgs-signin-v1';
type Source={gpgsId:string;playFabId:string|null};
type OpenSession=(env:Env,id:string,subject:string,seed:string)=>Promise<object>;
async function knownOwner(env:Env,p:Source){
 const keys=['gpgs:'+p.gpgsId,...(p.playFabId?['playfab:'+p.playFabId]:[])];
 const identity=await env.DB.prepare("SELECT player_id FROM auth_identity WHERE provider='gpgs' AND subject=?").bind(p.gpgsId).first<{player_id:string}>();
 const owners=new Set<string>(identity?[identity.player_id]:[]);
 for(const key of keys){const claim=await env.DB.prepare('SELECT player_id FROM legacy_recovery_claim WHERE source_key=?').bind(key).first<{player_id:string}>();if(claim)owners.add(claim.player_id);}
 // An old native player with this proven PlayFab ID may already own a manual
 // backup even if no migration receipt was generated. Never replace that save.
 if(p.playFabId){const existing=await env.DB.prepare('SELECT 1 FROM classic_backup_head WHERE player_id=? UNION ALL SELECT 1 FROM save_revision WHERE player_id=? LIMIT 1').bind(p.playFabId,p.playFabId).first();if(existing)owners.add(p.playFabId);}
 if(owners.size>1)throw new GameError('legacy_identity_conflict',409);
 return owners.size?[...owners][0]:null;
}
async function bindOwner(env:Env,id:string,p:Source){
 const guard=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
 const ban=await env.DB.prepare('SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').bind(id,now).first();if(ban)throw new GameError('player_banned',403);
 // Verify the currently owning row again inside the identity transaction. A
 // historical claim is proof of which destination received this exact source.
 const authorized=`EXISTS(SELECT 1 FROM auth_identity WHERE provider='gpgs' AND subject=? AND player_id=?) OR EXISTS(SELECT 1 FROM legacy_recovery_claim WHERE source_key IN (?,?) AND player_id=?) OR (?=? AND (EXISTS(SELECT 1 FROM classic_backup_head WHERE player_id=?) OR EXISTS(SELECT 1 FROM save_revision WHERE player_id=?)))`;
 try{await env.DB.batch([
  env.DB.prepare(`INSERT INTO legacy_recovery_guard(id,valid) VALUES(?,CASE WHEN (${authorized}) AND NOT EXISTS(SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)) THEN 1 ELSE 0 END)`).bind(guard,p.gpgsId,id,'gpgs:'+p.gpgsId,p.playFabId?'playfab:'+p.playFabId:'',id,p.playFabId,id,id,id,id,now),
  env.DB.prepare("INSERT INTO legacy_recovery_claim(source_key,player_id,claimed_at) VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END").bind('gpgs:'+p.gpgsId,id,Date.now()),
  ...(p.playFabId?[env.DB.prepare("INSERT INTO legacy_recovery_claim(source_key,player_id,claimed_at) VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END").bind('playfab:'+p.playFabId,id,Date.now())]:[]),
  env.DB.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('gpgs',?,?,?) ON CONFLICT(provider,subject) DO UPDATE SET player_id=CASE WHEN player_id=excluded.player_id THEN player_id ELSE NULL END").bind(p.gpgsId,id,now),
  env.DB.prepare('DELETE FROM legacy_recovery_guard WHERE id=?').bind(guard),
 ]);}catch{
  if(await env.DB.prepare('SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').bind(id,Math.floor(Date.now()/1000)).first())throw new GameError('player_banned',403);
  const conflict=await env.DB.prepare("SELECT 1 FROM auth_identity WHERE provider='gpgs' AND ((subject=? AND player_id<>?) OR (player_id=? AND subject<>?))").bind(p.gpgsId,id,id,p.gpgsId).first();
  const owner=await knownOwner(env,p);
  if(conflict||owner&&owner!==id)throw new GameError('legacy_identity_conflict',409);
  throw new GameError('legacy_identity_publication_unavailable',503);
 }
}
async function json(c:any){try{const b=await c.req.json();recoveryOperation(b);return b;}catch(e){if(e instanceof GameError)throw e;throw new GameError('invalid_request');}}
export function createGpgsLegacyApp(openSession:OpenSession){
 const app=new Hono<AppEnv>();
 app.use('*',bodyLimit({maxSize:2_100_000,onError:c=>c.json({error:'request_too_large'},413)}));
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 const session=async(env:Env,id:string,p:Source,op:string)=>{await bindOwner(env,id,p);return {status:'authenticated',...await openSession(env,id,p.gpgsId,'gpgs/'+id+'/'+p.gpgsId+'/'+op)};};
 const enabled=(env:Env)=>{if(env.LEGACY_MIGRATION_ENABLED!=='true'||env.EC1_MANUAL_BACKUPS_ENABLED!=='true')throw new GameError('legacy_recovery_disabled',503);};
 app.post('/',async c=>{
  const b=await json(c),op=recoveryOperation(b);
  const gpgsId=await verifyGpgsIdentity(c.env,b.serverAuthCode);
  await rateLimit(c.env,'gpgs-signin-subject',gpgsId,20,300);
  const existing=await knownOwner(c.env,{gpgsId,playFabId:null});
  if(existing)return c.json(await session(c.env,existing,{gpgsId,playFabId:null},op));
  enabled(c.env);
  if(b.serverAuthCode===b.playFabServerAuthCode)throw new GameError('legacy_proof_invalid',401);
  const p=await legacyGpgsIdentity(c.env,gpgsId,b.playFabServerAuthCode),owner=await knownOwner(c.env,p);
  if(owner)return c.json(await session(c.env,owner,p,op));
  const id=p.playFabId??'EC1G'+(await sha256(gpgsId)).slice(0,40).toUpperCase();
  const original=await readRecoverySource(c.env,id,p);
  if(original.rawSaveJson===null){
   const recoveryToken=await issueRecoveryProof(c.env,{playerId:id,gpgsId,playFabId:p.playFabId,operationId:op,archiveKey:original.archiveKey,archiveHash:original.archiveHash,expires:Date.now()+600000},proofDomain);
   return c.json({status:'google_saved_games_required',recoveryToken});
  }
  try{await publishRecovery(c.env,id,op,p,original.rawSaveJson,original.legacyPlaytime,original,'gpgs_signin_playfab',true);}
  catch(e){const winner=await knownOwner(c.env,p);if(winner)return c.json(await session(c.env,winner,p,op));throw e;}
  return c.json(await session(c.env,id,p,op));
 });
 app.post('/google',async c=>{
  const b=await json(c),op=recoveryOperation(b),p=await verifyRecoveryProof(c.env,b.recoveryToken,null,op,proofDomain);
  await rateLimit(c.env,'gpgs-signin-subject',p.gpgsId,20,300);
  const existing=await knownOwner(c.env,p);if(existing)return c.json(await session(c.env,existing,p,op));
  enabled(c.env);
  const original=await preserveGoogleRecovery(c.env,p.playerId,p,b);
  try{await publishRecovery(c.env,p.playerId,op,p,b.rawSaveJson,b.legacyPlaytime==null?undefined:String(b.legacyPlaytime),original,'gpgs_signin_google_saved_games',true);}
  catch(e){const winner=await knownOwner(c.env,p);if(winner)return c.json(await session(c.env,winner,p,op));throw e;}
  return c.json(await session(c.env,p.playerId,p,op));
 });
 return app;
}
