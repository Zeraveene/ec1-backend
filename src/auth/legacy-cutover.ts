import type { Env } from '../env';
import { AuthError } from './providers';
import { verifyClassicMigrationForCutover } from '../migration/classic';
import { hash, now, passwordHash, random, signToken } from './crypto';

type Proof={id:string;player_id:string;provider:string;subject:string;password_hash:string|null;salt:string|null;session_id:string|null;expires_at:number};
const query=(env:Env,sql:string,...values:unknown[])=>env.DB.prepare(sql).bind(...values);
async function legacyLogin(env:Env,endpoint:string,credentials:Record<string,unknown>){
 if(env.LEGACY_MIGRATION_ENABLED!=='true')throw new AuthError('migration_disabled',403);
 if(!env.PLAYFAB_TITLE_ID||!/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID))throw new AuthError('legacy_not_configured',503);
 let response:Response;try{response=await fetch(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Client/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({TitleId:env.PLAYFAB_TITLE_ID,CreateAccount:false,InfoRequestParameters:{GetUserAccountInfo:true},...credentials}),signal:AbortSignal.timeout(10000)});}catch{throw new AuthError('legacy_unavailable',503);}
 let result:any;try{result=await response.json();}catch{throw new AuthError('legacy_unavailable',503);}
 if(!response.ok||result.error){const rejected=new Set(['InvalidEmailOrPassword','InvalidUsernameOrPassword','AccountNotFound','GoogleOAuthNotConfiguredForTitle','InvalidGoogleToken']);if(response.status>=500||response.status===429||!rejected.has(result.error))throw new AuthError('legacy_unavailable',503);if(result.error==='GoogleOAuthNotConfiguredForTitle')throw new AuthError('legacy_not_configured',503);throw new AuthError('invalid_legacy_credentials',401);}
 const id=result.data?.PlayFabId;if(typeof id!=='string'||!/^[a-fA-F0-9]{8,32}$/.test(id))throw new AuthError('legacy_unavailable',503);
 return {id:id.toUpperCase(),account:result.data?.InfoResultPayload?.AccountInfo};
}
async function putProof(env:Env,id:string,playerId:string,provider:string,subject:string,digest:string|null=null,salt:string|null=null){
 // Only a proven missing native identity may establish the migration candidate.
 if(await query(env,'SELECT 1 FROM auth_identity WHERE provider=? AND subject=?',provider,subject).first())throw new AuthError('native_signin_required',409);
 if(await query(env,'SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',playerId,now()).first())throw new AuthError('player_banned',403);
 await query(env,'INSERT OR IGNORE INTO classic_auth_proof(id,player_id,provider,subject,password_hash,salt,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',id,playerId,provider,subject,digest,salt,now()+900,now()).run();
}
/** Browser token is used only within the callback lifetime and never stored. */
export async function prepareBrowserClassicProof(env:Env,challengeId:string,subject:string,accessToken:unknown){
 const challenge=await query(env,"SELECT 1 FROM auth_challenge WHERE id=? AND provider='google' AND intent='signin' AND expires_at>? AND used_at IS NULL",challengeId,now()).first();
 if(!challenge||await query(env,"SELECT 1 FROM auth_identity WHERE provider='google' AND subject=?",subject).first())return;
 if(typeof accessToken!=='string'||!accessToken)throw new AuthError('legacy_google_browser_required',409);
 const legacy=await legacyLogin(env,'LoginWithGoogleAccount',{AccessToken:accessToken});
 if(legacy.account?.GoogleInfo?.GoogleId!==subject)throw new AuthError('legacy_identity_mismatch',403);
 await putProof(env,challengeId,legacy.id,'google',subject);
}
export async function beginEmailClassic(env:Env,subject:string,password:string,deviceId:string|null){
 const legacy=await legacyLogin(env,'LoginWithEmailAddress',{Email:subject,Password:password});
 const verifiedEmail=legacy.account?.PrivateInfo?.Email;
 if(typeof verifiedEmail!=='string'||verifiedEmail.toLowerCase()!==subject)throw new AuthError('legacy_identity_mismatch',403);
 const salt=random(),id=random();await putProof(env,id,legacy.id,'email',subject,await passwordHash(password,salt),salt);
 return beginClassicProof(env,id,subject,deviceId);
}
export async function beginClassicProof(env:Env,id:string,subject:string,deviceId:string|null){
 const proof=await query(env,'SELECT * FROM classic_auth_proof WHERE id=? AND subject=? AND expires_at>?',id,subject,now()).first<Proof>();
 if(!proof)throw new AuthError('legacy_google_browser_required',409);
 if(await query(env,'SELECT 1 FROM auth_identity WHERE provider=? AND subject=?',proof.provider,subject).first())throw new AuthError('native_signin_required',409);
 const sid=proof.session_id??random();
 await env.DB.batch([
 query(env,"INSERT OR IGNORE INTO player(id,save_state,device_id,created_at,updated_at) VALUES(?,'migration_pending',?,?,?)",proof.player_id,deviceId,now(),now()),
 query(env,'UPDATE classic_auth_proof SET session_id=? WHERE id=? AND session_id IS NULL AND expires_at>?',sid,id,now()),
 query(env,"INSERT OR IGNORE INTO auth_session(id,player_id,provider,device_id,scope,created_at,expires_at) SELECT session_id,player_id,'legacy',?,'migration',?,expires_at FROM classic_auth_proof WHERE id=? AND expires_at>?",deviceId,now(),id,now())
 ]);
 const bound=await query(env,'SELECT session_id FROM classic_auth_proof WHERE id=?',id).first<{session_id:string}>();
 if(!bound)throw new AuthError('legacy_proof_unavailable',503);
 return {migrationRequired:true,scope:'migration',playerId:proof.player_id,accessToken:await signToken(env.PLAYER_TOKEN_SECRET,{sub:proof.player_id,sid:bound.session_id,provider:'legacy',scope:'migration',deviceId}),expiresIn:900,saveState:'migration_pending',saveVersion:0};
}
export async function finalizeClassic(env:Env,playerId:string,sessionId:string){
 const proof=await query(env,'SELECT * FROM classic_auth_proof WHERE player_id=? AND session_id=? AND expires_at>?',playerId,sessionId,now()).first<Proof>();
 if(!proof)throw new AuthError('legacy_identity_proof_required',403);
 let hasCloudSave=true;
 try { hasCloudSave=(await verifyClassicMigrationForCutover(env,playerId)).hasCloudSave; } catch(error) {
  if(error && typeof error==='object' && 'code' in error && 'status' in error) throw new AuthError(String(error.code),error.status as 400|401|403|404|409|429|503);
  throw new AuthError('migration_storage_unavailable',503);
 }
 const owner=await query(env,'SELECT player_id FROM auth_identity WHERE provider=? AND subject=?',proof.provider,proof.subject).first<{player_id:string}>();
 if(owner&&owner.player_id!==playerId)throw new AuthError('identity_already_claimed',409);
 const sid=random(),refresh=random(),timestamp=now();
 // Identity, durable completion and native session publish in the same D1 transaction.
 const migrationCondition=hasCloudSave ? 'm.revision=1' : "m.revision IS NULL AND NOT EXISTS(SELECT 1 FROM classic_backup_head h WHERE h.player_id=m.player_id) AND NOT EXISTS(SELECT 1 FROM classic_backup_revision r WHERE r.player_id=m.player_id)";
 const guard=`EXISTS(SELECT 1 FROM auth_session s JOIN classic_auth_proof p ON p.session_id=s.id JOIN classic_migration m ON m.player_id=s.player_id AND (${migrationCondition}) WHERE s.id=? AND s.player_id=? AND s.revoked_at IS NULL AND s.scope='migration' AND s.provider='legacy' AND s.expires_at>? AND p.expires_at>? AND p.player_id=s.player_id AND p.provider=? AND p.subject=?)`;
 try{await env.DB.batch([
 query(env,`INSERT OR IGNORE INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at) SELECT ?,?,?,?,?,? WHERE ${guard}`,proof.provider,proof.subject,playerId,proof.password_hash,proof.salt,timestamp,sessionId,playerId,timestamp,timestamp,proof.provider,proof.subject),
 query(env,`UPDATE classic_migration SET completed_at=COALESCE(completed_at,?) WHERE player_id=? AND ${hasCloudSave ? "revision=1" : "revision IS NULL"} AND ${guard} AND EXISTS(SELECT 1 FROM auth_identity WHERE provider=? AND subject=? AND player_id=?)`,timestamp,playerId,sessionId,playerId,timestamp,timestamp,proof.provider,proof.subject,proof.provider,proof.subject,playerId),
 query(env,"UPDATE player SET save_state='migrated',migrated_at=COALESCE(migrated_at,?),updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM classic_migration WHERE player_id=? AND completed_at IS NOT NULL)",timestamp,timestamp,playerId,playerId),
 query(env,`INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) SELECT ?,?,?,'player',?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM classic_migration WHERE player_id=? AND completed_at IS NOT NULL) AND EXISTS(SELECT 1 FROM auth_identity WHERE provider=? AND subject=? AND player_id=?)`,sid,playerId,proof.provider,timestamp,timestamp+30*86400,sessionId,playerId,timestamp,timestamp,proof.provider,proof.subject,playerId,proof.provider,proof.subject,playerId),
 query(env,'INSERT INTO auth_refresh(hash,session_id,expires_at) SELECT ?,id,expires_at FROM auth_session WHERE id=?',await hash(refresh),sid),
 query(env,"UPDATE auth_session SET revoked_at=? WHERE player_id=? AND scope='migration' AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM auth_session WHERE id=? AND scope='player')",timestamp,playerId,sid)
 ]);}catch{const winner=await query(env,'SELECT player_id FROM auth_identity WHERE provider=? AND subject=?',proof.provider,proof.subject).first<{player_id:string}>();if(winner&&winner.player_id!==playerId)throw new AuthError('identity_already_claimed',409);throw new AuthError('migration_finalize_unavailable',503);}
 if(!await query(env,'SELECT 1 FROM auth_session WHERE id=?',sid).first())throw new AuthError('migration_finalize_conflict',409);
 return {scope:'player',playerId,accessToken:await signToken(env.PLAYER_TOKEN_SECRET,{sub:playerId,sid,provider:proof.provider,scope:'player',deviceId:null}),refreshToken:refresh,expiresIn:900,saveState:'migrated',saveVersion:0};
}
