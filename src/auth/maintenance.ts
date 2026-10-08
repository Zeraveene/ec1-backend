import type { Env } from '../env';
import { hash, now } from './crypto';
import { AuthError } from './providers';

/** Edge IP is supplied by Cloudflare, never a client-selected account identifier. */
export async function rateLimit(env:Env,route:string,ip:string,maximum:number,window=300){
  const bucket=await hash(JSON.stringify(['ec1/auth-rate/v1',route,ip,Math.floor(now()/window)]));
  await env.DB.prepare('INSERT INTO auth_rate_limit(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').bind(bucket,now()+window).run();
  const current=await env.DB.prepare('SELECT count FROM auth_rate_limit WHERE bucket=?').bind(bucket).first<{count:number}>();
  if(!current||current.count>maximum)throw new AuthError('rate_limited',429);
}

/** A bounded scheduled maintenance hook; repeat over time instead of unbounded scans. */
export async function cleanupAuthState(env:Env,limit=100){
  const bounded=Math.max(1,Math.min(500,Math.floor(limit))),time=now();
  return env.DB.batch([
    env.DB.prepare('DELETE FROM auth_rate_limit WHERE bucket IN(SELECT bucket FROM auth_rate_limit WHERE expires_at<=? ORDER BY expires_at LIMIT ?)').bind(time,bounded),
    env.DB.prepare('DELETE FROM auth_challenge WHERE id IN(SELECT id FROM auth_challenge WHERE expires_at<=? ORDER BY expires_at LIMIT ?)').bind(time,bounded),
    env.DB.prepare('DELETE FROM auth_refresh WHERE hash IN(SELECT r.hash FROM auth_refresh r JOIN auth_session s ON s.id=r.session_id WHERE r.expires_at<=? OR (s.revoked_at IS NOT NULL AND s.revoked_at<=?) ORDER BY r.expires_at LIMIT ?)').bind(time,time-86400,bounded),
    env.DB.prepare('DELETE FROM auth_session WHERE id IN(SELECT s.id FROM auth_session s WHERE s.expires_at<=? AND NOT EXISTS(SELECT 1 FROM auth_refresh r WHERE r.session_id=s.id) ORDER BY s.expires_at LIMIT ?)').bind(time,bounded),
  ]);
}
