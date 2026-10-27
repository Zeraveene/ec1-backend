import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { rateLimit } from '../auth/maintenance';
import { verifyAppleReceipt, verifyGooglePlayReceipt } from './receipts';
import { PurchaseError, verifyStore } from './store';
import { productGrant } from './catalog';
import { accountBinding, hex, protocol } from './binding';
import { hash } from '../auth/crypto';

// Exact active native SKUs. Retired products remain verifiable for entitlement restoration.
export const activeProducts = [
  ...Array.from({length:8},(_,i)=>`ruby${i+1}`), 'jewel_red','jewel_orange','jewel_purple',
  'premium','archer','souru','double_loot','more_exp','booster_pack',
  ...Array.from({length:5},(_,i)=>`stepup_${i+1}`),
  'iap_premium','iap_archer','iap_souru','iap_double_loot','iap_more_exp','iap_dual_booster',
  ...Array.from({length:5},(_,i)=>`iap_stepup_${i+1}`),
];
export function configuredProducts(env: AppEnv['Bindings'], platform?: 'google'|'apple') {
  if (env.IAP_PURCHASES_ENABLED !== 'true') return [];
  const google = platform !== 'apple' && !!(env.IAP_GOOGLE_PUBLIC_KEY && env.IAP_GOOGLE_SERVICE_ACCOUNT && env.IAP_GOOGLE_PACKAGE_NAME);
  const apple = platform !== 'google' && !!(env.IAP_APPLE_BUNDLE_ID && env.IAP_APPLE_VERIFICATION_MODE === 'receipt');
  return activeProducts.filter(id => id.startsWith('iap_') ? apple : /^(ruby|jewel_)/.test(id) ? google || apple : google);
}
type Ledger = { player_id:string; product_id:string; status:string; environment:string; verification_source:string };
type GrantRow = { grant_json:string; operation_id:string };
export function installGrantRoutes(app: Hono<AppEnv>) {
  app.post('/validate', async c => {
    const playerId = c.get('player').playerId;
    await rateLimit(c.env,'purchase-validate',playerId,60);
    let b: Record<string, unknown>;
    try { b = await c.req.json(); } catch { throw new PurchaseError('invalid_purchase_request'); }
    if (!b || Array.isArray(b) || b.protocol !== protocol || (b.mode !== 'purchase' && b.mode !== 'restore') ||
        (b.platform !== 'google' && b.platform !== 'apple') || typeof b.productId !== 'string' || b.productId.length > 128 ||
        typeof b.operationId !== 'string' || !/^[a-f0-9]{64}$/.test(b.operationId) ||
        Object.keys(b).some(k => !['protocol','mode','platform','productId','operationId','receiptJson','signatureBase64','jwsReceipt'].includes(k)))
      throw new PurchaseError('invalid_purchase_request');
    const {platform,productId,operationId} = b, mode = b.mode as 'purchase'|'restore';
    const field = (name:string,max=65536) => {
      const value=b[name]; if(typeof value !== 'string' || !value || value.length>max) throw new PurchaseError('invalid_purchase_request'); return value;
    };
    const definition = productGrant(platform,productId);
    if (platform==='google' && (!c.env.IAP_GOOGLE_PUBLIC_KEY || !c.env.IAP_GOOGLE_PACKAGE_NAME) ||
        platform==='apple' && (!c.env.IAP_APPLE_BUNDLE_ID || c.env.IAP_APPLE_VERIFICATION_MODE!=='receipt'))
      throw new PurchaseError('purchase_not_configured',503);
    const verified = platform === 'google'
      ? await verifyGooglePlayReceipt({publicKeyBase64:c.env.IAP_GOOGLE_PUBLIC_KEY!,packageName:c.env.IAP_GOOGLE_PACKAGE_NAME!,receiptJson:field('receiptJson'),signatureBase64:field('signatureBase64',4096),claimedProductId:productId})
      : await verifyAppleReceipt({bundleId:c.env.IAP_APPLE_BUNDLE_ID!,receipt:field('jwsReceipt'),claimedProductId:productId});
    if (verified.appleData?.revocationDate != null) throw new PurchaseError('purchase_revoked',403);
    const purchaseKey = platform + ':' + (platform==='google' ? await hex(verified.purchaseToken!) : verified.transactionId);
    // Historical pre-grant builds used base64url SHA-256 purchase keys. Never award the same token again.
    if (platform==='google' && await c.env.DB.prepare('SELECT 1 FROM purchase_ledger WHERE purchase_key=?').bind('google:' + await hash(verified.purchaseToken!)).first())
      throw new PurchaseError('purchase_already_granted',409);
    if (operationId !== await hex(`ec1/purchase/v1/${playerId}/${purchaseKey}`)) throw new PurchaseError('operation_conflict',409);
    const ledger = () => c.env.DB.prepare('SELECT player_id,product_id,status,environment,verification_source FROM purchase_ledger WHERE purchase_key=?').bind(purchaseKey).first<Ledger>();
    const check = (row: Ledger) => {
      if (row.player_id!==playerId) throw new PurchaseError('purchase_already_claimed',409);
      if (row.product_id!==productId) throw new PurchaseError('purchase_proof_conflict',409);
      if (row.status==='revoked') throw new PurchaseError('purchase_revoked',403);
      if (row.verification_source==='unity_editor') throw new PurchaseError('invalid_purchase_request');
    };
    const read = () => c.env.DB.prepare('SELECT grant_json,operation_id FROM purchase_grant WHERE purchase_key=? AND mode=?').bind(purchaseKey,mode).first<GrantRow>();
    let row = await ledger();
    if (row) {
      check(row);
      const prior=await read();
      // Already verified sales remain deliverable while checkout is paused or the store is down.
      if (prior && mode==='purchase') return c.json(JSON.parse(prior.grant_json));
      if (mode==='purchase' && (row.status==='granted' || await c.env.DB.prepare("SELECT 1 FROM purchase_grant WHERE purchase_key=? AND mode='restore'").bind(purchaseKey).first()))
        throw new PurchaseError('purchase_already_granted',409);
    }
    if (mode==='purchase' && !activeProducts.includes(productId)) throw new PurchaseError('purchase_product_unsupported',422);
    if (mode==='restore' && Object.keys(definition.entitlements).length===0) throw new PurchaseError('purchase_not_restorable',422);
    // A paused checkout must still recover valid payments that were already made.
    const facts = await verifyStore(c.env,verified,await accountBinding(c.env,playerId));
    const grantId='purchase_' + await hex(`${purchaseKey}/${mode}`), now=Date.now();
    const grant={protocol,game:'ec1',playerId,grantId,purchaseKey,platform,productId,quantity:1,rewardRevision:'catalog-v1',
      environment:facts.environment,verificationSource:facts.source,
      ...(mode==='restore'?{kind:'entitlement-restore'}:{}),
      rewards:mode==='restore'?[]:definition.rewards,
      entitlements:Object.fromEntries(Object.entries(definition.entitlements).map(([k,v])=>[k,Number(v)]))};
    const statements=[c.env.DB.prepare('INSERT OR IGNORE INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,created_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)')
      .bind(purchaseKey,platform,platform==='apple'?verified.transactionId:purchaseKey,playerId,productId,verified.receiptSha256,facts.environment,facts.source,JSON.stringify(facts),now)];
    if (definition.oneTimeKey) statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO purchase_offer_claim(player_id,offer_key,purchase_key) SELECT ?,?,? FROM purchase_ledger WHERE purchase_key=? AND player_id=? AND product_id=? AND status!='revoked'`)
      .bind(playerId,definition.oneTimeKey,purchaseKey,purchaseKey,playerId,productId));
    const eligible=`SELECT 1 FROM purchase_ledger l WHERE l.purchase_key=? AND l.player_id=? AND l.product_id=? AND l.status!='revoked'`+
      (definition.oneTimeKey?" AND EXISTS(SELECT 1 FROM purchase_offer_claim o WHERE o.player_id=l.player_id AND o.offer_key=? AND o.purchase_key=l.purchase_key) AND NOT EXISTS(SELECT 1 FROM purchase_entitlement e WHERE e.player_id=l.player_id AND e.key=? AND e.source_key!=l.purchase_key)":'')+
      (mode==='purchase'?" AND NOT EXISTS(SELECT 1 FROM purchase_grant g WHERE g.purchase_key=l.purchase_key AND g.mode='restore')":'');
    const values=[purchaseKey,playerId,productId,...(definition.oneTimeKey?[definition.oneTimeKey,definition.oneTimeKey]:[])];
    statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO purchase_grant(grant_id,player_id,purchase_key,mode,operation_id,grant_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(${eligible})`)
      .bind(grantId,playerId,purchaseKey,mode,operationId,JSON.stringify(grant),now,...values));
    for(const [key,value] of Object.entries(definition.entitlements)) statements.push(c.env.DB.prepare(`INSERT INTO purchase_entitlement(player_id,key,value,source_key) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM purchase_grant WHERE grant_id=? AND player_id=?) ON CONFLICT(player_id,key) DO UPDATE SET value=excluded.value,source_key=excluded.source_key`)
      .bind(playerId,key,value,purchaseKey,grantId,playerId));
    await c.env.DB.batch(statements);
    row=await ledger(); if(!row) throw new PurchaseError('purchase_service_unavailable',503); check(row);
    const saved=await read();
    if(!saved) throw new PurchaseError('purchase_entitlement_already_owned',409);
    return c.json(JSON.parse(saved.grant_json));
  });
  app.post('/grants/:grantId/ack',async c=>{
    const playerId=c.get('player').playerId,grantId=c.req.param('grantId');
    let b: {operationId?:unknown}; try{b=await c.req.json();}catch{throw new PurchaseError('invalid_purchase_request');}
    if(!/^purchase_[a-f0-9]{64}$/.test(grantId) || !b || typeof b.operationId!=='string' || !/^[a-f0-9]{64}$/.test(b.operationId)) throw new PurchaseError('invalid_purchase_request');
    const row=await c.env.DB.prepare('SELECT g.purchase_key,l.status FROM purchase_grant g JOIN purchase_ledger l ON l.purchase_key=g.purchase_key WHERE grant_id=? AND g.player_id=? AND g.operation_id=?').bind(grantId,playerId,b.operationId).first<{purchase_key:string;status:string}>();
    if(!row) throw new PurchaseError('purchase_grant_not_found',404);
    if(row.status==='revoked') throw new PurchaseError('purchase_revoked',403);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE purchase_grant SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE grant_id=? AND player_id=? AND EXISTS(SELECT 1 FROM purchase_ledger WHERE purchase_key=? AND status!='revoked')").bind(Date.now(),grantId,playerId,row.purchase_key),
      c.env.DB.prepare("UPDATE purchase_ledger SET status='granted',granted_at=COALESCE(granted_at,?) WHERE purchase_key=? AND player_id=? AND status!='revoked'").bind(Date.now(),row.purchase_key,playerId),
    ]);
    return c.json({acknowledged:true});
  });
}
