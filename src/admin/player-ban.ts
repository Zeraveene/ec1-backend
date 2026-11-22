import type { Env } from "../env";
import { AdminActionError, type AdminActor } from "./action-types";

export async function updatePlayerBan(env: Env, actor: AdminActor, id: string, input: Record<string, unknown>) {
  const revoke = input.revoked === true;
  if (actor.role !== "internal" && (actor.role !== "manager" || revoke))
    throw new AdminActionError("forbidden_role", 403);
  if (!await env.DB.prepare("SELECT id FROM player WHERE id=?").bind(id).first())
    throw new AdminActionError("player_not_found", 404);
  const now = Math.floor(Date.now() / 1000);
  const expires = input.expiresAt ?? null;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!revoke && (!reason || reason.length > 1000)) throw new AdminActionError("invalid_request");
  if (!revoke && expires !== null && (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires <= now))
    throw new AdminActionError("invalid_expiry");

  // Only internal admins can replace an active ban. A manager cannot shorten it.
  const mutation = revoke
    ? env.DB.prepare("UPDATE player_ban SET revoked_at=? WHERE player_id=?").bind(now, id)
    : env.DB.prepare(`INSERT INTO player_ban(player_id,reason,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL)
        ON CONFLICT(player_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL
        WHERE ?='internal' OR player_ban.revoked_at IS NOT NULL OR player_ban.expires_at<=excluded.created_at`)
        .bind(id, reason, now, expires, actor.role);
  const [result] = await env.DB.batch([mutation,
    env.DB.prepare(`INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at)
      SELECT ?,?,?,'ban.update',?,?,? WHERE changes()>0`).bind(crypto.randomUUID(), actor.id, actor.name, id,
        JSON.stringify({ revoked: revoke, reason, expiresAt: expires }), Date.now()),
  ]);
  if (!revoke && !result.meta.changes) throw new AdminActionError("already_banned", 409);
  return { ok: true };
}
