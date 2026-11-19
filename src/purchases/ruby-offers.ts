import { rubyFirstBonuses } from './catalog';
import type { Reward } from '../game/rewards';

export async function availableRubyBonuses(db: D1Database, playerId: string, editor: boolean) {
  const rows = await db.prepare(editor
    ? `SELECT DISTINCT product_id AS offer_key FROM purchase_editor_grant WHERE player_id=?
       AND json_extract(grant_json,'$.rewardRevision')='ruby-first-v1'`
    : "SELECT substr(offer_key,7) AS offer_key FROM purchase_offer_claim WHERE player_id=? AND offer_key LIKE 'first:ruby%'")
    .bind(playerId).all<{offer_key: string}>();
  const claimed = new Set(rows.results.map(row => row.offer_key));
  return Object.fromEntries(Object.entries(rubyFirstBonuses).filter(([id]) => !claimed.has(id)));
}

// Insert the reservation and select the winning grant inside the same D1 batch.
export function rubyGrant(db: D1Database, playerId: string, purchaseKey: string, productId: string,
  grant: { rewards: Reward[] }, editor: boolean) {
  const regular = JSON.stringify(grant);
  if (!Object.hasOwn(rubyFirstBonuses, productId) || !grant.rewards.length)
    return { reservation: [], sql: '?', args: [regular] };
  const key = 'first:' + productId;
  const bonus = { id: 'ruby', amount: rubyFirstBonuses[productId] };
  const first = JSON.stringify({...grant, rewardRevision: 'ruby-first-v1', rewards: [...grant.rewards, bonus]});
  if (editor) return {
    reservation: [],
    sql: `CASE WHEN EXISTS(SELECT 1 FROM purchase_editor_grant WHERE player_id=? AND product_id=?
      AND json_extract(grant_json,'$.rewardRevision')='ruby-first-v1') THEN ? ELSE ? END`,
    args: [playerId, productId, regular, first],
  };
  const reservation = db.prepare(`INSERT OR IGNORE INTO purchase_offer_claim(player_id,offer_key,purchase_key)
    SELECT player_id,?,purchase_key FROM purchase_ledger WHERE purchase_key=? AND player_id=? AND product_id=?
    AND status!='revoked'`).bind(key, purchaseKey, playerId, productId);
  return {
    reservation: [reservation],
    sql: `CASE WHEN EXISTS(SELECT 1 FROM purchase_offer_claim WHERE player_id=? AND offer_key=? AND purchase_key=?)
      THEN ? ELSE ? END`,
    args: [playerId, key, purchaseKey, first, regular],
  };
}
