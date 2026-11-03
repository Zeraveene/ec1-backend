import type { Env } from '../env';
import { passwordHash, random } from '../auth/crypto';
import { AdminActionError, requireWriter, type AdminActor } from './action-types';

async function key(env: Env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ec1/admin-migration-email/v1/' + env.PLAYER_TOKEN_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function migrationPassword(env: Env, id: string) {
  const password = random(), salt = random(), digest = await passwordHash(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, await key(env), new TextEncoder().encode(password));
  return { salt, digest, encrypted: JSON.stringify({ iv: [...iv], bytes: [...new Uint8Array(bytes)] }) };
}
export async function migrationEmailStatus(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT status,updated_at FROM classic_migration_email WHERE player_id=?').bind(id).first<{ status: string; updated_at: number }>();
  return row ?? { status: 'no_email', updated_at: null };
}
// Separate retryable delivery from publication. Passwords never enter responses,
// audit records or plaintext storage. Existing credentials are never replaced.
export async function sendMigrationEmail(env: Env, actor: AdminActor, id: string) {
  requireWriter(actor);
  if (!env.EMAIL || !env.MAIL_FROM || !env.PASSWORD_RESET_ORIGIN || !/^https:\/\/[^/?#]+$/.test(env.PASSWORD_RESET_ORIGIN)) throw new AdminActionError('email_not_configured', 503);
  const attempt = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare("UPDATE classic_migration_email SET status='sending',attempt_id=?,updated_at=? WHERE player_id=? AND status IN ('pending','failed') RETURNING recipient,password_hash,encrypted_password")
    .bind(attempt, now, id).first<{ recipient: string; password_hash: string; encrypted_password: string }>();
  if (!row) return migrationEmailStatus(env, id);
  const identity = await env.DB.prepare("SELECT password_hash FROM auth_identity WHERE provider='email' AND subject=? AND player_id=?").bind(row.recipient, id).first<{ password_hash: string }>();
  if (identity?.password_hash !== row.password_hash) {
    await env.DB.prepare("UPDATE classic_migration_email SET status='superseded',encrypted_password=NULL,updated_at=? WHERE player_id=? AND attempt_id=?").bind(Date.now(), id, attempt).run();
    return migrationEmailStatus(env, id);
  }
  try {
    const encrypted = JSON.parse(row.encrypted_password);
    const password = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv), additionalData: new TextEncoder().encode(id) }, await key(env), new Uint8Array(encrypted.bytes)));
    await env.EMAIL.send({ from: env.MAIL_FROM, to: row.recipient, subject: 'Your Epic Conquest Classic account has been migrated', text: `Your account and cloud backup have been migrated to our new server.\n\nAccount UID: ${id}\nLogin email: ${row.recipient}\nNew password: ${password}\n\nSign in to Epic Conquest Classic using this email and password. Signing in does not load or overwrite your device progress. Use Load cloud data in the backup menu to restore your cloud backup.\n\nTo change your password, use Reset password in the game.\n\nIf you need help, contact support on our Discord server.` });
  } catch {
    await env.DB.prepare("UPDATE classic_migration_email SET status='failed',updated_at=? WHERE player_id=? AND attempt_id=? AND status='sending'").bind(Date.now(), id, attempt).run();
    return migrationEmailStatus(env, id);
  }
  // A lost response after send remains 'sending', preventing duplicate emails.
  await env.DB.prepare("UPDATE classic_migration_email SET status='sent',encrypted_password=NULL,updated_at=? WHERE player_id=? AND attempt_id=? AND status='sending'").bind(Date.now(), id, attempt).run();
  return migrationEmailStatus(env, id);
}
