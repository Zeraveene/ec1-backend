import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Env } from '../env';
import { validateRewards, publishSnapshot } from '../game';
import { loadSnapshot } from '../game/storage';
import { GameError } from '../game/validation';
import { rateLimit } from '../auth/maintenance';
import { AuthError } from '../auth/providers';

type Admin = {id:string;name:string};
class AdminError extends Error { constructor(public code:string,public status=400){super(code);} }
const enc=new TextEncoder();
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function decode(value:string):Uint8Array<ArrayBuffer> {return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function key(secret:string){return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function seal(secret:string,value:unknown){const payload=b64(enc.encode(JSON.stringify(value)));return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(payload))))}`;}
async function unseal(secret:string,token:string|undefined):Promise<Record<string,any>|null>{try{if(!token)return null;const [payload,sig,extra]=token.split('.');if(extra||!payload||!sig||!await crypto.subtle.verify('HMAC',await key(secret),decode(sig),enc.encode(payload)))return null;const value=JSON.parse(new TextDecoder().decode(decode(payload)));return Number.isSafeInteger(value.exp)&&value.exp>Date.now()?value:null;}catch{return null;}}
function allowlisted(env:Env,id:string){return (env.ADMIN_DISCORD_IDS||'').split(',').map(s=>s.trim()).filter(Boolean).includes(id);}
function configured(env:Env){return !!(env.ADMIN_SESSION_SECRET&&env.ADMIN_SESSION_SECRET.length>=32&&env.ADMIN_SESSION_SECRET!==env.PLAYER_TOKEN_SECRET&&env.DISCORD_ADMIN_CLIENT_ID&&env.DISCORD_ADMIN_CLIENT_SECRET&&env.DISCORD_ADMIN_REDIRECT_URI&&env.ADMIN_DISCORD_IDS);}
const cookieOptions={httpOnly:true,secure:true,sameSite:'Lax' as const,path:'/'};
const requireAdmin=createMiddleware<AppEnv>(async(c,next)=>{
  if(!configured(c.env))return c.json({error:'admin_not_configured'},503);
  const session=await unseal(c.env.ADMIN_SESSION_SECRET!,getCookie(c,'ec1_admin'));
  if(!session||session.purpose!=='ec1/admin'||session.iss!=='ec1-admin'||session.aud!==new URL(c.req.url).origin||typeof session.sid!=='string'||typeof session.id!=='string'||!allowlisted(c.env,session.id))return c.json({error:'admin_unauthorized'},401);
  const stored=await c.env.DB.prepare('SELECT actor_id,expires_at,revoked_at FROM admin_session WHERE id=?').bind(session.sid).first<{actor_id:string;expires_at:number;revoked_at:number|null}>();
  if(!stored||stored.actor_id!==session.id||stored.expires_at<=Date.now()||stored.revoked_at!==null)return c.json({error:'admin_unauthorized'},401);
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.req.header('Origin')!==new URL(c.req.url).origin)return c.json({error:'invalid_origin'},403);
  c.set('admin',{id:session.id,name:String(session.name||session.id)});await next();
});
function handler(error:Error,c:any){if(error instanceof AdminError||error instanceof GameError||error instanceof AuthError)return c.json({error:error.code,...(error.status===429?{retryAfterSeconds:300}:{})},error.status);return c.json({error:'admin_service_unavailable'},503);}
async function body(c:any){try{const value=await c.req.json();if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value as Record<string,any>;}catch{throw new AdminError('invalid_request');}}
function string(value:unknown,max=256){if(typeof value!=='string'||!value.trim()||value.length>max)throw new AdminError('invalid_request');return value.trim();}
async function exists(env:Env,id:string){if(!await env.DB.prepare('SELECT id FROM player WHERE id=?').bind(id).first())throw new AdminError('player_not_found',404);}
function audit(env:Env,admin:Admin,action:string,playerId:string|null,detail:unknown){return env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),admin.id,admin.name,action,playerId,JSON.stringify(detail),Date.now());}
export async function cleanupAdminState(env:Env,limit=100){const bounded=Math.max(1,Math.min(500,Math.floor(limit)));return env.DB.batch([env.DB.prepare('DELETE FROM admin_oauth_state WHERE id IN(SELECT id FROM admin_oauth_state WHERE expires_at<=? ORDER BY expires_at LIMIT ?)').bind(Date.now(),bounded),env.DB.prepare('DELETE FROM admin_session WHERE id IN(SELECT id FROM admin_session WHERE expires_at<=? ORDER BY expires_at LIMIT ?)').bind(Date.now(),bounded)]);}

export function createAdminAuthApp(){const app=new Hono<AppEnv>();app.onError(handler);
  app.get('/discord',async c=>{if(!configured(c.env))throw new AdminError('admin_not_configured',503);if(new URL(c.env.DISCORD_ADMIN_REDIRECT_URI!).origin!==new URL(c.req.url).origin)throw new AdminError('admin_redirect_mismatch',503);await rateLimit(c.env,'admin-oauth',c.req.header('CF-Connecting-IP')||'local',20);const state=b64(crypto.getRandomValues(new Uint8Array(32))),expires=Date.now()+300000;await c.env.DB.prepare('INSERT INTO admin_oauth_state(id,expires_at) VALUES(?,?)').bind(state,expires).run();setCookie(c,'ec1_admin_state',await seal(c.env.ADMIN_SESSION_SECRET!,{purpose:'ec1/admin-state',state,aud:new URL(c.req.url).origin,exp:expires}),{...cookieOptions,path:'/auth',maxAge:300});const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({client_id:c.env.DISCORD_ADMIN_CLIENT_ID!,redirect_uri:c.env.DISCORD_ADMIN_REDIRECT_URI!,response_type:'code',scope:'identify',state}).toString();return c.redirect(url.toString());});
  app.get('/discord/callback',async c=>{
    if(!configured(c.env))throw new AdminError('admin_not_configured',503);
    const state=await unseal(c.env.ADMIN_SESSION_SECRET!,getCookie(c,'ec1_admin_state'));deleteCookie(c,'ec1_admin_state',{path:'/auth',secure:true});
    if(!state||state.purpose!=='ec1/admin-state'||state.aud!==new URL(c.req.url).origin||state.state!==c.req.query('state'))throw new AdminError('invalid_oauth_state',403);
    const consumed=await c.env.DB.prepare('UPDATE admin_oauth_state SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').bind(Date.now(),state.state,Date.now()).run();if(!consumed.meta.changes)throw new AdminError('invalid_oauth_state',403);
    const code=string(c.req.query('code'),2048);
    const response=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:c.env.DISCORD_ADMIN_CLIENT_ID!,client_secret:c.env.DISCORD_ADMIN_CLIENT_SECRET!,redirect_uri:c.env.DISCORD_ADMIN_REDIRECT_URI!,code}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new AdminError('oauth_exchange_failed',502);const token=await response.json() as {access_token?:string};if(!token.access_token)throw new AdminError('oauth_exchange_failed',502);
    const userResponse=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(10000)});if(!userResponse.ok)throw new AdminError('oauth_identity_failed',502);
    const user=await userResponse.json() as {id:string;username:string;global_name?:string};if(!allowlisted(c.env,user.id))throw new AdminError('admin_not_allowed',403);
    if(typeof user.id!=='string'||typeof user.username!=='string')throw new AdminError('oauth_identity_failed',502);
    const sid=crypto.randomUUID(),expires=Date.now()+8*3600000;await c.env.DB.prepare('INSERT INTO admin_session(id,actor_id,expires_at) VALUES(?,?,?)').bind(sid,user.id,expires).run();
    setCookie(c,'ec1_admin',await seal(c.env.ADMIN_SESSION_SECRET!,{purpose:'ec1/admin',iss:'ec1-admin',aud:new URL(c.req.url).origin,sid,id:user.id,name:user.global_name||user.username,exp:expires}),{...cookieOptions,maxAge:8*3600});return c.redirect('/');
  });return app;
}

export function createAdminApp(){const app=new Hono<AppEnv>();app.onError(handler);app.use('*',requireAdmin);
  app.get('/me',c=>c.json({admin:c.get('admin'),game:'ec1'}));
  app.post('/logout',async c=>{const session=await unseal(c.env.ADMIN_SESSION_SECRET!,getCookie(c,'ec1_admin'));await c.env.DB.prepare('UPDATE admin_session SET revoked_at=? WHERE id=?').bind(Date.now(),session!.sid).run();deleteCookie(c,'ec1_admin',cookieOptions);return c.json({ok:true});});
  app.get('/status',async c=>{const count=await c.env.DB.prepare('SELECT COUNT(*) AS count FROM player').first();return c.json({game:'ec1',environment:c.env.ENVIRONMENT,players:count?.count,migrationEnabled:c.env.LEGACY_MIGRATION_ENABLED==='true',newAccountsEnabled:c.env.ALLOW_NEW_ACCOUNTS==='true',providers:{google:!!c.env.GOOGLE_CLIENT_IDS,apple:!!c.env.APPLE_CLIENT_IDS,discord:!!c.env.DISCORD_GAME_CLIENT_ID,email:true},playfabConfigured:!!c.env.PLAYFAB_TITLE_ID&&!!c.env.PLAYFAB_SECRET_KEY});});
  app.get('/players',async c=>{const query=(c.req.query('query')||'').trim().slice(0,128),before=Number(c.req.query('before')||Number.MAX_SAFE_INTEGER);if(!Number.isFinite(before))throw new AdminError('invalid_cursor');const rows=await c.env.DB.prepare('SELECT p.* FROM player p WHERE (p.id LIKE ? OR p.display_name LIKE ? OR EXISTS(SELECT 1 FROM auth_identity a WHERE a.player_id=p.id AND a.subject LIKE ?)) AND p.created_at<? ORDER BY p.created_at DESC,p.id DESC LIMIT 100').bind(`%${query}%`,`%${query}%`,`%${query}%`,before).all();return c.json({players:rows.results});});
  app.get('/players/:id',async c=>{const id=c.req.param('id');await exists(c.env,id);const results=await Promise.all([c.env.DB.prepare('SELECT * FROM player WHERE id=?').bind(id).first(),c.env.DB.prepare('SELECT provider,subject,created_at FROM auth_identity WHERE player_id=?').bind(id).all(),c.env.DB.prepare('SELECT version,playtime,operation_id,sha256,created_at FROM save_revision WHERE player_id=? ORDER BY version DESC LIMIT 100').bind(id).all(),c.env.DB.prepare('SELECT id,title,body,rewards_json,created_at,expires_at,read_at,claimed_at FROM mail WHERE player_id=? ORDER BY created_at DESC LIMIT 100').bind(id).all(),c.env.DB.prepare('SELECT * FROM player_ban WHERE player_id=?').bind(id).first(),c.env.DB.prepare('SELECT * FROM migration_record WHERE player_id=?').bind(id).first()]);return c.json({player:results[0],identities:(results[1] as any).results,revisions:(results[2] as any).results,mail:(results[3] as any).results,ban:results[4],migration:results[5]});});
  app.get('/players/:id/save',async c=>{const id=c.req.param('id');await exists(c.env,id);return c.json(await loadSnapshot(c.env,id));});
  app.post('/players/:id/mail',async c=>{
    const id=c.req.param('id');await exists(c.env,id);const b=await body(c),mailId=string(b.operationId,128),title=string(b.title,200),message=string(b.body,8000),rewards=validateRewards(b.rewards);
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(mailId))throw new AdminError('invalid_operation');
    const expires=b.expiresAt??null;if(expires!==null&&!Number.isSafeInteger(expires))throw new AdminError('invalid_expiry');const encoded=JSON.stringify(rewards);
    const replay=async()=>{const previous=await c.env.DB.prepare('SELECT player_id,title,body,rewards_json,expires_at FROM mail WHERE id=?').bind(mailId).first();if(!previous)return false;if(previous.player_id!==id||previous.title!==title||previous.body!==message||previous.rewards_json!==encoded||previous.expires_at!==expires)throw new AdminError('operation_conflict',409);return true;};
    if(await replay())return c.json({id:mailId,replayed:true});
    if(expires!==null&&expires<=Date.now())throw new AdminError('invalid_expiry');
    try{await c.env.DB.batch([c.env.DB.prepare('INSERT INTO mail(id,player_id,title,body,rewards_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(mailId,id,title,message,encoded,Date.now(),expires),audit(c.env,c.get('admin'),'mail.send',id,{mailId,title,rewards})]);}
    catch(error){if(await replay())return c.json({id:mailId,replayed:true});throw error;}
    return c.json({id:mailId},201);
  });
  app.post('/players/:id/ban',async c=>{const id=c.req.param('id');await exists(c.env,id);const b=await body(c);let mutation:D1PreparedStatement;if(b.revoked===true){mutation=c.env.DB.prepare('UPDATE player_ban SET revoked_at=? WHERE player_id=?').bind(Math.floor(Date.now()/1000),id);}else{const reason=string(b.reason,1000),expires=b.expiresAt??null;if(expires!==null&&(!Number.isSafeInteger(expires)||expires<=Math.floor(Date.now()/1000)))throw new AdminError('invalid_expiry');mutation=c.env.DB.prepare('INSERT INTO player_ban(player_id,reason,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL) ON CONFLICT(player_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL').bind(id,reason,Math.floor(Date.now()/1000),expires);}await c.env.DB.batch([mutation,audit(c.env,c.get('admin'),'ban.update',id,{revoked:b.revoked===true,reason:b.reason,expiresAt:b.expiresAt})]);return c.json({ok:true});});
  app.post('/players/:id/restore',async c=>{
    const id=c.req.param('id');await exists(c.env,id);const b=await body(c);
    if(!Number.isSafeInteger(b.version)||b.version<1||!Number.isSafeInteger(b.expectedSaveVersion)||b.expectedSaveVersion<0)throw new AdminError('invalid_version');
    const row=await c.env.DB.prepare('SELECT r2_key,sha256 FROM save_revision WHERE player_id=? AND version=?').bind(id,b.version).first<{r2_key:string;sha256:string}>();if(!row)throw new AdminError('revision_not_found',404);
    const stored=await c.env.PLAYER_SAVES.get(row.r2_key);if(!stored)throw new AdminError('revision_unavailable',503);const raw=await stored.text(),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(raw)))).map(v=>v.toString(16).padStart(2,'0')).join('');if(sha!==row.sha256)throw new AdminError('revision_integrity_failure',503);
    const old=JSON.parse(raw),operationId=string(b.operationId,128),admin=c.get('admin');
    return c.json(await publishSnapshot(c.env,id,{...old,expectedSaveVersion:b.expectedSaveVersion,operationId},{allowPlaytimeDecrease:true,adminAudit:{id:`restore:${id}:${operationId}`,actorId:admin.id,actorName:admin.name,action:'save.restore',detail:{sourceVersion:b.version,newVersion:b.expectedSaveVersion+1,operationId}}}));
  });
  app.get('/config',async c=>c.json({config:(await c.env.DB.prepare('SELECT * FROM game_config ORDER BY key').all()).results,coupons:(await c.env.DB.prepare('SELECT * FROM coupon ORDER BY code LIMIT 100').all()).results}));
  app.put('/config/daily',async c=>{const b=await body(c);if(!Array.isArray(b.rewards)||b.rewards.length<1||b.rewards.length>31)throw new AdminError('invalid_daily_schedule');const rewards=b.rewards.map(validateRewards);await c.env.DB.batch([c.env.DB.prepare("INSERT INTO game_config(key,value_json,updated_at) VALUES('daily_rewards',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(JSON.stringify({rewards}),Date.now()),audit(c.env,c.get('admin'),'daily.configure',null,{rewards})]);return c.json({ok:true});});
  app.put('/coupons/:code',async c=>{const code=c.req.param('code');if(!/^[A-Za-z0-9_-]{1,64}$/.test(code))throw new AdminError('invalid_coupon');const b=await body(c),rewards=validateRewards(b.rewards),expires=b.expiresAt??null;if(expires!==null&&(!Number.isSafeInteger(expires)||expires<=Date.now()))throw new AdminError('invalid_expiry');await c.env.DB.batch([c.env.DB.prepare('INSERT INTO coupon(code,rewards_json,enabled,expires_at) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET rewards_json=excluded.rewards_json,enabled=excluded.enabled,expires_at=excluded.expires_at').bind(code,JSON.stringify(rewards),b.enabled===true?1:0,expires),audit(c.env,c.get('admin'),'coupon.configure',null,{code,enabled:b.enabled===true,rewards,expiresAt:expires})]);return c.json({ok:true});});
  app.get('/audit',async c=>c.json({events:(await c.env.DB.prepare('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 100').all()).results}));
  return app;
}
