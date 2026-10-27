import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requirePlayer } from '../auth';
import { hash, mac } from '../auth/crypto';
import { rateLimit } from '../auth/maintenance';
import { PurchaseError } from './store';

// Purchase capabilities have a separate token domain and never authenticate game/backup APIs.
export function installPurchaseIdentity(app: Hono<AppEnv>) {
  app.post('/guest-session', async c => {
    await rateLimit(c.env, 'purchase-guest', c.req.header('CF-Connecting-IP') || 'local', 20);
    let b: Record<string, unknown>;
    try { b = await c.req.json(); } catch { throw new PurchaseError('invalid_purchase_request'); }
    if (!b || typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id) ||
        typeof b.secret !== 'string' || !/^[a-f0-9]{64}$/.test(b.secret) || Object.keys(b).some(k => k !== 'id' && k !== 'secret'))
      throw new PurchaseError('invalid_purchase_request');
    const read = () => c.env.DB.prepare('SELECT secret_hash,player_id FROM purchase_guest WHERE id=?').bind(b.id)
      .first<{secret_hash:string;player_id:string}>();
    const digest = await hash('ec1/purchase-guest/v1/' + b.secret);
    let row = await read();
    if (!row) {
      if (c.env.IAP_PURCHASES_ENABLED !== 'true') throw new PurchaseError('purchases_disabled', 503);
      const playerId = 'EC1G_' + b.id;
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT OR IGNORE INTO player(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').bind(playerId, 'Guest purchaser', Date.now(), Date.now()),
        c.env.DB.prepare('INSERT OR IGNORE INTO purchase_guest(id,secret_hash,player_id,created_at) VALUES(?,?,?,?)').bind(b.id,digest,playerId,Date.now()),
      ]);
      row = await read();
    }
    if (!row || row.secret_hash !== digest) throw new PurchaseError('invalid_purchase_identity', 401);
    const expires = Math.floor(Date.now()/1000) + 900;
    const payload = `${b.id}.${expires}`;
    return c.json({ playerId: row.player_id, accessToken: `ec1purchase.${payload}.${await mac(c.env.PLAYER_TOKEN_SECRET, 'ec1/purchase-session/v1/' + payload)}`, expiresIn: 900 });
  });
  app.use('*', async (c, next) => {
    const token = c.req.header('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token?.startsWith('ec1purchase.')) return requirePlayer(c, next);
    const parts = token.split('.');
    if (parts.length !== 4 || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^\d{10}$/.test(parts[2]) ||
        Number(parts[2]) <= Math.floor(Date.now()/1000) ||
        parts[3] !== await mac(c.env.PLAYER_TOKEN_SECRET, 'ec1/purchase-session/v1/' + parts[1] + '.' + parts[2]))
      throw new PurchaseError('unauthorized', 401);
    const row = await c.env.DB.prepare('SELECT player_id FROM purchase_guest WHERE id=?').bind(parts[1]).first<{player_id:string}>();
    if (!row) throw new PurchaseError('unauthorized', 401);
    if (await c.env.DB.prepare('SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)')
      .bind(row.player_id, Math.floor(Date.now()/1000)).first()) throw new PurchaseError('player_banned',403);
    // Guest capabilities can use only the modern production grant API.
    if (!['/account-binding','/validate','/grants/'].some(p => c.req.path === '/api/purchases' + p || p === '/grants/' && c.req.path.startsWith('/api/purchases/grants/')))
      throw new PurchaseError('insufficient_scope',403);
    c.set('player',{playerId:row.player_id,sessionId:parts[1],provider:'purchase_guest',deviceId:null,scope:'player'});
    await next();
  });
}
