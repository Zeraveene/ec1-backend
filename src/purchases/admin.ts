import type { Env } from '../env';
import { configuredProducts } from './grants';

// Only fields written by verifyStore are used. It does not persist financial facts.
const time = `CASE WHEN p.verification_source IN ('google_api','apple_signed_receipt') AND json_valid(p.facts_json) THEN CASE WHEN json_type(p.facts_json,'$.purchaseTime') IN ('integer','real') AND json_extract(p.facts_json,'$.purchaseTime')>=0 AND json_extract(p.facts_json,'$.purchaseTime')<=p.created_at+60000 THEN CAST(json_extract(p.facts_json,'$.purchaseTime') AS INTEGER) ELSE p.created_at END ELSE p.created_at END`;
// Google stores a token hash in transaction_id; only a format-validated store order is displayable.
const googleOrder = `CASE WHEN p.platform='google' AND p.verification_source='google_api' AND json_valid(p.facts_json) THEN CASE WHEN json_type(p.facts_json,'$.orderId')='text' AND length(json_extract(p.facts_json,'$.orderId'))=24 AND json_extract(p.facts_json,'$.orderId') GLOB 'GPA.????-????-????-?????' AND substr(json_extract(p.facts_json,'$.orderId'),5) NOT GLOB '*[^0-9-]*' AND length(replace(json_extract(p.facts_json,'$.orderId'),'-',''))=21 THEN json_extract(p.facts_json,'$.orderId') ELSE NULL END ELSE NULL END`;
const projection = `p.rowid AS rowId,p.platform,CASE WHEN p.platform='apple' THEN p.transaction_id ELSE ${googleOrder} END AS transactionId,p.player_id AS playerId,pl.display_name AS displayName,p.product_id AS productId,${time} AS purchasedAt,p.created_at AS validatedAt,p.granted_at AS grantedAt,p.status,p.environment,p.quantity,p.verification_source AS verificationSource,p.save_version AS saveVersion`;
const baseReadiness = { ledger: true, financialAmounts: false, usdNormalization: false, refundReconciliation: false, country: false, reports: false, deliveryProtocolReady: true, refundChecksReady: false, reportsEnabled: false, reportingConfigured: false };
const from = 'FROM purchase_ledger p LEFT JOIN player pl ON pl.id=p.player_id';
const dayMs = 86400000;
function rowDto(row: Record<string, unknown>) {
  const { rowId, ...safe } = row;
  return { id: `p_${Number(rowId).toString(36)}`, ...safe, currency: null, amountMicros: null, amountSource: null, usdMicros: null, refundStatus: 'unknown', refundedMicros: null, country: null };
}
function fail(status: number, error: string) { return { status, body: { error } }; }
function keys(args: Record<string, unknown>, allowed: string[]) { return Object.keys(args).every(key => allowed.includes(key)); }

/** Read-only projection; caller must also authenticate and recheck current central role. */
export async function dispatchPurchaseAdmin(env: Env, _actor: { id: string; name: string }, role: 'internal' | 'manager' | 'guest', operation: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (role !== 'internal') return fail(403, 'forbidden');
  const readiness = { ...baseReadiness, purchasesEnabled: configuredProducts(env).length > 0 };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(400, 'invalid_arguments');
  if (operation === 'purchases.detail') {
    if (!keys(args, ['id']) || typeof args.id !== 'string' || !/^p_[1-9a-z][0-9a-z]{0,10}$/.test(args.id)) return fail(400, 'invalid_arguments');
    const id = parseInt(args.id.slice(2), 36);
    if (!Number.isSafeInteger(id) || id <= 0 || `p_${id.toString(36)}` !== args.id) return fail(400, 'invalid_arguments');
    try {
      const row = await env.DB.prepare(`SELECT ${projection} ${from} WHERE p.rowid=?`).bind(id).first<Record<string, unknown>>();
      return row ? { status: 200, body: { purchase: rowDto(row), readiness } } : fail(404, 'purchase_not_found');
    } catch { return fail(503, 'purchase_storage_unavailable'); }
  }
  if (operation !== 'purchases.analytics') return fail(400, 'invalid_operation');
  if (!keys(args, ['days', 'platform', 'status', 'q', 'cursor', 'limit'])) return fail(400, 'invalid_arguments');
  const days = args.days === undefined ? 1 : Number(args.days), limit = args.limit === undefined ? 50 : Number(args.limit);
  if (![1, 7, 30, 90].includes(days) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (args.days !== undefined && !['number','string'].includes(typeof args.days)) || (args.limit !== undefined && !['number','string'].includes(typeof args.limit))) return fail(400, 'invalid_arguments');
  const platform = args.platform ?? '', status = args.status ?? '', q = args.q ?? '';
  if (typeof platform !== 'string' || !['', 'google', 'apple'].includes(platform) || typeof status !== 'string' || !['', 'verified_pending', 'granted', 'revoked', 'test'].includes(status) || typeof q !== 'string' || q.length > 80 || (args.cursor !== undefined && typeof args.cursor !== 'string')) return fail(400, 'invalid_arguments');
  const search = q.trim(), scope = JSON.stringify([days, platform, status, search]);
  let until = Date.now(), cursorTime: number | null = null, cursorId = 0;
  if (args.cursor) {
    if ((args.cursor as string).length > 800) return fail(400, 'invalid_cursor');
    try {
      const cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(args.cursor as string), c => c.charCodeAt(0))));
      if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== 1 || cursor[1] !== scope || !Number.isSafeInteger(cursor[2]) || cursor[2] < 0 || cursor[2] > until || !Number.isSafeInteger(cursor[3]) || cursor[3] < 0 || cursor[3] > cursor[2] || !Number.isSafeInteger(cursor[4]) || cursor[4] <= 0) return fail(400, 'invalid_cursor');
      [, , until, cursorTime, cursorId] = cursor;
    } catch { return fail(400, 'invalid_cursor'); }
  }
  const since = Math.floor((until + 7 * 3600000) / dayMs) * dayMs - 7 * 3600000 - (days - 1) * dayMs;
  const range = `${time}>=? AND ${time}<=?`, production = `${from} WHERE p.environment='production' AND ${range}`;
  const filters: string[] = [], values: (string | number)[] = [since, until];
  if (platform) { filters.push('p.platform=?'); values.push(platform); }
  if (status === 'test') filters.push("p.environment IN ('test','sandbox')");
  else if (status) { filters.push('p.status=?'); values.push(status); }
  if (search) {
    // instr avoids D1's short LIKE/GLOB pattern limit and treats wildcard characters literally.
    filters.push(`(instr(lower(p.player_id),lower(?))>0 OR instr(lower(p.product_id),lower(?))>0 OR instr(lower(pl.display_name),lower(?))>0 OR (p.platform='apple' AND instr(lower(p.transaction_id),lower(?))>0) OR instr(lower(${googleOrder}),lower(?))>0)`);
    values.push(search, search, search, search, search);
  }
  if (cursorTime !== null) { filters.push(`(${time}<? OR (${time}=? AND p.rowid<?))`); values.push(cursorTime, cursorTime, cursorId); }
  const prepare = (sql: string, params: (string | number)[] = [since, until]) => env.DB.prepare(sql).bind(...params);
  try {
    const [totals, products, daily, recent, buyers, previous, environments, hourly] = await env.DB.batch<Record<string, unknown>>([
      prepare(`SELECT COUNT(*) AS purchases,COUNT(DISTINCT p.player_id) AS buyers,COALESCE(SUM(p.quantity),0) AS units,COUNT(*) AS unknownAmounts,COALESCE(SUM(p.status='verified_pending'),0) AS verifiedPending,COALESCE(SUM(p.status='granted'),0) AS granted,COALESCE(SUM(p.status='revoked'),0) AS revoked ${production}`),
      prepare(`SELECT p.platform,p.product_id AS productId,COUNT(*) AS purchases,SUM(p.quantity) AS units,COUNT(DISTINCT p.player_id) AS buyers ${production} GROUP BY p.platform,p.product_id ORDER BY purchases DESC,p.platform,p.product_id LIMIT 100`),
      prepare(`SELECT strftime('%Y-%m-%d',(${time})/1000,'unixepoch','+7 hours') AS day,COUNT(*) AS purchases ${production} GROUP BY day ORDER BY day`),
      prepare(`SELECT ${projection} ${from} WHERE ${range}${filters.map(filter => ` AND ${filter}`).join('')} ORDER BY ${time} DESC,p.rowid DESC LIMIT ?`, [...values, limit + 1]),
      prepare(`SELECT p.player_id AS playerId,pl.display_name AS displayName,COUNT(*) AS purchases ${production} GROUP BY p.player_id ORDER BY purchases DESC,p.player_id LIMIT 10`),
      prepare(`SELECT COUNT(*) AS purchases ${production}`, [since - days * dayMs, since - 1]),
      prepare(`SELECT p.environment,COUNT(*) AS purchases ${from} WHERE ${range} GROUP BY p.environment ORDER BY p.environment LIMIT 20`),
      prepare(`SELECT CAST(strftime('%H',(${time})/1000,'unixepoch','+7 hours') AS INTEGER) AS hour,COUNT(*) AS purchases ${production} GROUP BY hour ORDER BY hour`),
    ]);
    const rows = recent.results as Record<string, unknown>[], more = rows.length > limit, visible = rows.slice(0, limit), last = visible.at(-1);
    return { status: 200, body: { since, until, timeZone: 'Asia/Jakarta', totals: { ...totals.results[0], refundedPurchases: null }, revenue: [], products: products.results.map(row => ({ ...row, usdMicros: null })), daily: daily.results.map(row => ({ ...row, usdMicros: null, refunds: null })), recent: visible.map(rowDto), buyers: buyers.results.map(row => ({ ...row, usdMicros: null })), countries: [], hourly: days === 1 ? hourly.results.map(row => ({ ...row, usdMicros: null, refunds: null })) : [], previous: { ...previous.results[0], usdMicros: null }, environments: environments.results, nextCursor: more && last ? btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([1, scope, until, last.purchasedAt, last.rowId])))) : null, limit, readiness, periodUsd: null, todayUsd: null, reportsEnabled: false, reportingConfigured: false, refundChecksReady: false, deliveryProtocolReady: true } };
  } catch { return fail(503, 'purchase_storage_unavailable'); }
}
