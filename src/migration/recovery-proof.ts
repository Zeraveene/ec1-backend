import type { Env } from '../env';
import { GameError } from '../game/validation';
import { base64, decode, mac } from '../auth/crypto';
import { readPlayFab } from './playfab';

const object = (v:any) => v && typeof v === 'object' && !Array.isArray(v);
async function request(url:string, init:RequestInit) {
  try { const response=await fetch(url,{...init,signal:AbortSignal.timeout(10000)}); return {response,body:await response.json() as any}; }
  catch { throw new GameError('legacy_source_unavailable',503); }
}
function code(v:unknown):string { if(typeof v!=='string'||!v||v.length>4096)throw new GameError('legacy_proof_invalid',401); return v; }
async function lookupSession(env:Env){
  if(env.PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID){
    const login=await request(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithCustomID`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({TitleId:env.PLAYFAB_TITLE_ID,CustomId:env.PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID,CreateAccount:false})});
    if(!login.response.ok||login.body.error||login.body.data?.NewlyCreated===true||typeof login.body.data?.SessionTicket!=='string'||!login.body.data.SessionTicket)throw new GameError('legacy_recovery_lookup_unavailable',503);
    return login.body.data.SessionTicket as string;
  }
  if(!env.PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET)throw new GameError('legacy_recovery_lookup_unavailable',503);
  return env.PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET;
}
export async function verifyGpgsIdentity(env:Env,serverAuthCode:unknown) {
  if(!env.GPGS_RECOVERY_CLIENT_ID||!env.GPGS_RECOVERY_CLIENT_SECRET||!env.GPGS_RECOVERY_APPLICATION_ID)throw new GameError('legacy_recovery_not_configured',503);
  const googleCode=code(serverAuthCode);
  const token=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GPGS_RECOVERY_CLIENT_ID,client_secret:env.GPGS_RECOVERY_CLIENT_SECRET,grant_type:'authorization_code',code:googleCode,redirect_uri:''})});
  if(!token.response.ok||typeof token.body.access_token!=='string')throw new GameError(token.response.status===400?'legacy_proof_invalid':'legacy_source_unavailable',token.response.status===400?401:503);
  const verified=await request(`https://games.googleapis.com/games/v1/applications/${encodeURIComponent(env.GPGS_RECOVERY_APPLICATION_ID)}/verify`,{headers:{Authorization:'Bearer '+token.body.access_token}});
  if(!verified.response.ok||typeof verified.body.player_id!=='string'||!verified.body.player_id||verified.body.player_id.length>256)throw new GameError('legacy_proof_invalid',verified.response.status>=500||verified.response.status===429?503:401);
  return verified.body.player_id as string;
}
export async function recoveryIdentity(env:Env,b:any) {
  if(b.serverAuthCode===b.playFabServerAuthCode)throw new GameError('legacy_proof_invalid',401);
  return legacyGpgsIdentity(env,await verifyGpgsIdentity(env,b.serverAuthCode),b.playFabServerAuthCode);
}
export async function legacyGpgsIdentity(env:Env,gpgsId:string,playFabServerAuthCode:unknown) {
  if(!env.PLAYFAB_TITLE_ID||!env.PLAYFAB_SECRET_KEY||!/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID))throw new GameError('legacy_recovery_not_configured',503);
  const playFabCode=code(playFabServerAuthCode);
  // This is deliberately the Play Games provider, not LoginWithGoogleAccount:
  // the same Google user can own different PlayFab accounts through each provider.
  const login=await request(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithGooglePlayGamesServices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({TitleId:env.PLAYFAB_TITLE_ID,ServerAuthCode:playFabCode,CreateAccount:false})});
  if(login.response.status===400&&login.body.error==='AccountBanned')throw new GameError('legacy_account_banned',403);
  let id:unknown;
  if(login.response.status===400&&login.body.error==='AccountNotFound'){
    // An absent account does not reveal the identity behind the second code.
    // Independently resolve the first, verified identity; otherwise mixing two
    // people's codes could bypass an existing PlayFab source claim.
    const session=await lookupSession(env);
    const lookup=await request(`https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Client/GetPlayFabIDsFromGooglePlayGamesPlayerIDs`,{method:'POST',headers:{'Content-Type':'application/json','X-Authorization':session},body:JSON.stringify({GooglePlayGamesPlayerIDs:[gpgsId]})});
    const rows=lookup.body.data?.Data;
    if(!lookup.response.ok||lookup.body.error||!Array.isArray(rows)||rows.length!==1||rows[0]?.GooglePlayGamesPlayerId!==gpgsId)throw new GameError('legacy_recovery_lookup_unavailable',503);
    if(rows[0].PlayFabId===null)return {gpgsId,playFabId:null,account:null};
    id=rows[0].PlayFabId;
  }else{
    if(!login.response.ok||login.body.error||!object(login.body.data))throw new GameError('legacy_source_unavailable',503);
    if(login.body.data.NewlyCreated===true)throw new GameError('legacy_proof_invalid',401);
    id=login.body.data.PlayFabId;
  }
  if(typeof id!=='string'||!/^[a-fA-F0-9]{8,64}$/.test(id))throw new GameError('legacy_proof_invalid',401);
  const info=await readPlayFab(env,'Server/GetUserAccountInfo',{PlayFabId:id});
  if(info.UserInfo?.PlayFabId?.toUpperCase()!==id.toUpperCase()||info.UserInfo?.GooglePlayGamesInfo?.GooglePlayGamesPlayerId!==gpgsId)throw new GameError('legacy_proof_invalid',401);
  if(info.UserInfo?.TitleInfo?.isBanned===true)throw new GameError('legacy_account_banned',403);
  return {gpgsId,playFabId:id.toUpperCase(),account:info};
}
export type RecoveryProof={playerId:string;gpgsId:string;playFabId:string|null;operationId:string;archiveKey:string;archiveHash:string;expires:number};
export async function issueRecoveryProof(env:Env,proof:RecoveryProof,domain='ec1-legacy-recovery-v1'){const payload=base64(JSON.stringify(proof));return payload+'.'+await mac(env.PLAYER_TOKEN_SECRET,domain+':'+payload);}
export async function verifyRecoveryProof(env:Env,token:unknown,id:string|null,operation:string,domain='ec1-legacy-recovery-v1'):Promise<RecoveryProof>{
  try { if(typeof token!=='string'||token.length>8192)throw 0;const [payload,signature,...extra]=token.split('.');if(extra.length||signature!==await mac(env.PLAYER_TOKEN_SECRET,domain+':'+payload))throw 0;const p=JSON.parse(new TextDecoder().decode(decode(payload)));if(id!==null&&p.playerId!==id||p.operationId!==operation||p.expires<Date.now()||typeof p.gpgsId!=='string'||!p.gpgsId)throw 0;return p; }
  catch {throw new GameError('legacy_recovery_proof_expired',401);}
}
