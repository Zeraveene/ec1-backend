import type { Env } from '../env';
import { PurchaseError } from './store';
export const protocol = 'ec1-grants-v1';
export async function hex(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function accountBinding(env: Env, id: string) {
  await env.DB.prepare('INSERT OR IGNORE INTO purchase_account_binding(player_id,google_account_id,apple_account_token,created_at) VALUES(?,?,?,?)')
    .bind(id, await hex(`ec1/store-account/v1/${id}`), crypto.randomUUID(), Date.now()).run();
  const row = await env.DB.prepare('SELECT google_account_id,apple_account_token FROM purchase_account_binding WHERE player_id=?').bind(id)
    .first<{google_account_id:string;apple_account_token:string}>();
  if (!row) throw new PurchaseError('purchase_service_unavailable', 503);
  // Preserve previously issued bindings; the modern checkout accepts only hex IDs.
  return row;
}
