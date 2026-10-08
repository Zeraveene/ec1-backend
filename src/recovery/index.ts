import {Hono} from 'hono';
import type {AppEnv} from '../env';
import {hash,mac,now,passwordHash,random} from '../auth/crypto';
class RecoveryError extends Error{constructor(public code:string,public status=400){super(code);}}
async function json(c:any){try{const b=await c.req.json();if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b as Record<string,unknown>;}catch{throw new RecoveryError('invalid_request');}}
function string(value:unknown,max=256){if(typeof value!=='string'||!value||value.length>max)throw new RecoveryError('invalid_request');return value;}
export function createRecoveryApp(){const app=new Hono<AppEnv>();
 app.onError((e,c)=>e instanceof RecoveryError?c.json({error:e.code},e.status as any):c.json({error:'recovery_unavailable'},503));
 app.use('*',async(c,next)=>{if(c.env.RECOVERY_ENABLED!=='true'||!c.env.EMAIL||!c.env.MAIL_FROM||!c.env.PASSWORD_RESET_ORIGIN||!/^https:\/\/[^/?#]+$/.test(c.env.PASSWORD_RESET_ORIGIN))return c.json({error:'recovery_not_configured'},503);await next();});
 app.post('/request',async c=>{
  const b=await json(c),email=string(b.email,254).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new RecoveryError('invalid_email');
  const slot=Math.floor(now()/900),ip=c.req.header('CF-Connecting-IP')||'local',buckets=await Promise.all([hash(`ec1/recovery/ip/${ip}/${slot}`),hash(`ec1/recovery/email/${email}/${slot}`)]);
  await c.env.DB.batch(buckets.map(bucket=>c.env.DB.prepare('INSERT INTO recovery_rate(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').bind(bucket,now()+900)));
  const rates=await Promise.all(buckets.map(bucket=>c.env.DB.prepare('SELECT count FROM recovery_rate WHERE bucket=?').bind(bucket).first<{count:number}>()));
  if(rates.some((rate,i)=>(rate?.count||0)>(i===0?15:3)))return c.json({error:'rate_limited',retryAfterSeconds:900},429);
  const identity=await c.env.DB.prepare("SELECT player_id,password_hash FROM auth_identity WHERE provider='email' AND subject=?").bind(email).first<{player_id:string;password_hash:string}>();
  if(identity){
   const token=random(),digest=await hash(token);await c.env.DB.prepare('INSERT INTO password_recovery(token_hash,player_id,old_password_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(digest,identity.player_id,identity.password_hash,now()+1800,now()).run();
   try{await c.env.EMAIL!.send({from:c.env.MAIL_FROM!,to:email,subject:'Reset your Epic Conquest 1 password',text:`A password reset was requested for your Epic Conquest 1 account.\n\n${c.env.PASSWORD_RESET_ORIGIN}/reset-password#token=${token}\n\nThis link expires in 30 minutes. If you did not request it, you can ignore this email. Your PlayFab account is unchanged.`});await c.env.DB.prepare("UPDATE password_recovery SET status='ready' WHERE token_hash=?").bind(digest).run();}
   catch{await c.env.DB.prepare("UPDATE password_recovery SET status='failed' WHERE token_hash=?").bind(digest).run();}
  }
  return c.json({accepted:true,message:'If that EC1 email account exists, a reset link will be sent.'},202);
 });
 app.post('/reset',async c=>{
  const b=await json(c),token=string(b.token,128),password=string(b.password),operationId=string(b.operationId,128);if(password.length<10)throw new RecoveryError('weak_password');if(!/^[A-Za-z0-9_-]{8,128}$/.test(operationId))throw new RecoveryError('invalid_operation');
  const digest=await hash(token),fingerprint=await mac(c.env.PLAYER_TOKEN_SECRET,JSON.stringify(['ec1/recovery/confirm/v1',operationId,password]));
  const row=await c.env.DB.prepare('SELECT * FROM password_recovery WHERE token_hash=?').bind(digest).first<{player_id:string;old_password_hash:string;expires_at:number;status:string;used_at:number|null;fingerprint:string|null}>();
  if(!row||row.status==='failed'||row.status==='pending')throw new RecoveryError('invalid_reset_link',401);
  if(row.used_at){if(row.fingerprint===fingerprint&&now()-row.used_at<=120)return c.json({ok:true});throw new RecoveryError('reset_link_used',409);}
  if(row.expires_at<=now())throw new RecoveryError('reset_link_expired',401);
  const salt=random(),next=await passwordHash(password,salt),time=now();
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE auth_identity SET password_hash=?,salt=? WHERE provider='email' AND player_id=? AND password_hash=? AND EXISTS(SELECT 1 FROM password_recovery WHERE token_hash=? AND used_at IS NULL AND status='ready' AND expires_at>?)").bind(next,salt,row.player_id,row.old_password_hash,digest,time),
   c.env.DB.prepare("UPDATE password_recovery SET used_at=?,fingerprint=?,status='used' WHERE token_hash=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM auth_identity WHERE provider='email' AND player_id=? AND password_hash=?)").bind(time,fingerprint,digest,row.player_id,next),
   c.env.DB.prepare('UPDATE auth_session SET revoked_at=? WHERE player_id=? AND EXISTS(SELECT 1 FROM password_recovery WHERE token_hash=? AND fingerprint=? AND used_at=?)').bind(time,row.player_id,digest,fingerprint,time),
   c.env.DB.prepare("INSERT INTO recovery_event(id,player_id,action,created_at) SELECT ?,?,'password.reset',? WHERE EXISTS(SELECT 1 FROM password_recovery WHERE token_hash=? AND fingerprint=? AND used_at=?)").bind(crypto.randomUUID(),row.player_id,time,digest,fingerprint,time),
  ]);
  const confirmed=await c.env.DB.prepare('SELECT used_at,fingerprint FROM password_recovery WHERE token_hash=?').bind(digest).first<{used_at:number|null;fingerprint:string|null}>();
  if(confirmed?.fingerprint!==fingerprint||!confirmed.used_at)throw new RecoveryError('reset_conflict',409);
  return c.json({ok:true});
 });return app;
}
