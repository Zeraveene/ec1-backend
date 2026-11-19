import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env';
import { purchaseAdminCatalog } from './catalog';
import { publisherToken } from './store';
import { hex } from './binding';

const products = purchaseAdminCatalog().products;

// Only the Nillo worker binds this entrypoint. Store and player identifiers stay in Classic.
export class ClassicPurchaseReports extends WorkerEntrypoint<Env> {
  async claim() {
    const db = this.env.DB;
    const now = Date.now();
    const row = await db.prepare(`SELECT r.grant_id,r.attempted_at,r.currency,r.amount_micros,r.purchased_at,
      l.platform,l.product_id,p.display_name FROM purchase_report_outbox r JOIN purchase_ledger l USING(purchase_key)
      LEFT JOIN player p ON p.id=l.player_id
      WHERE r.message_id IS NULL AND r.next_attempt_at<=? AND l.environment='production' AND l.status!='revoked'
      ORDER BY r.next_attempt_at,r.purchased_at LIMIT 1`).bind(now).first<{
        grant_id:string; attempted_at:number|null; currency:string|null; amount_micros:number|null;
        purchased_at:number; platform:string; product_id:string; display_name:string|null;
      }>();
    if (!row) return null;
    const locked = await db.prepare(`UPDATE purchase_report_outbox SET next_attempt_at=?,attempted_at=COALESCE(attempted_at,?)
      WHERE grant_id=? AND next_attempt_at<=? AND message_id IS NULL`).bind(now+300000,now,row.grant_id,now).run();
    if (!locked.meta.changes) return null;
    return { ...row, title: products.find(p => p.platform===row.platform && p.productId===row.product_id)?.name ?? row.product_id };
  }

  async delivered(id:string, messageId:string) {
    if (!/^purchase_[a-f0-9]{64}$/.test(id) || !/^\d{1,20}$/.test(messageId)) throw new Error('Invalid report receipt');
    await this.env.DB.prepare('UPDATE purchase_report_outbox SET message_id=? WHERE grant_id=? AND message_id IS NULL')
      .bind(messageId,id).run();
  }

  async totals(since:number, until:number) {
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || until<=since || until-since>86400000)
      throw new Error('Invalid report interval');
    return (await this.env.DB.prepare(`SELECT currency,SUM(amount_micros) AS micros,COUNT(*) AS count
      FROM purchase_report_outbox WHERE purchased_at>=? AND purchased_at<? GROUP BY currency`)
      .bind(since,until).all<{currency:string|null;micros:number|null;count:number}>()).results;
  }

  // Pricing is retried independently so a delayed Play order cannot hold up a grant or Discord.
  async refreshPrices() {
    const env = this.env;
    if (!env.IAP_GOOGLE_SERVICE_ACCOUNT || !env.IAP_GOOGLE_PACKAGE_NAME) return;
    const now = Date.now();
    const rows = await env.DB.prepare(`SELECT r.grant_id,r.purchase_key,l.product_id,json_extract(l.facts_json,'$.orderId') AS order_id
      FROM purchase_report_outbox r JOIN purchase_ledger l USING(purchase_key)
      WHERE l.platform='google' AND l.status!='revoked' AND r.amount_micros IS NULL AND r.price_retry_at<=?
      ORDER BY r.price_retry_at,r.purchased_at LIMIT 5`).bind(now).all<{grant_id:string;purchase_key:string;product_id:string;order_id:string}>();
    for (const row of rows.results) {
      const claimed = await env.DB.prepare('UPDATE purchase_report_outbox SET price_retry_at=? WHERE grant_id=? AND price_retry_at<=?')
        .bind(now+3600000,row.grant_id,now).run();
      if (!claimed.meta.changes || !row.order_id) continue;
      const token = await publisherToken(env.IAP_GOOGLE_SERVICE_ACCOUNT);
      const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        encodeURIComponent(env.IAP_GOOGLE_PACKAGE_NAME) + '/orders/' + encodeURIComponent(row.order_id);
      const res = await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(5000)});
      if (!res.ok) continue;
      const order = await res.json<any>();
      if (order.orderId!==row.order_id || typeof order.purchaseToken!=='string' ||
          'google:'+await hex(order.purchaseToken)!==row.purchase_key || order.lineItems?.length!==1 ||
          order.lineItems[0].productId!==row.product_id) continue;
      const money=order.total, units=money?.units ?? '0', nanos=money?.nanos ?? 0;
      if (!money || !/^[A-Z]{3}$/.test(money.currencyCode) || !/^\d+$/.test(units) ||
          !Number.isInteger(nanos) || nanos<0 || nanos>=1e9 || nanos%1000!==0) continue;
      const micros=Number(units)*1000000+nanos/1000;
      if (Number.isSafeInteger(micros)) await env.DB.prepare('UPDATE purchase_report_outbox SET currency=?,amount_micros=? WHERE grant_id=?')
        .bind(money.currencyCode,micros,row.grant_id).run();
    }
  }
}
