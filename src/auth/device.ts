import type { Env } from "../env";
import { hash, now } from "./crypto";
import { AuthError } from "./providers";

export interface DeviceCredential {
  id: string;
  secretHash: string;
  deviceId: string;
}
export async function parseDeviceCredential(
  body: Record<string, unknown>,
  optional = false,
): Promise<DeviceCredential | null> {
  if (
    optional &&
    body.deviceCredentialId === undefined &&
    body.deviceSecret === undefined
  )
    return null;
  if (
    typeof body.deviceCredentialId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.deviceCredentialId) ||
    typeof body.deviceSecret !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(body.deviceSecret) ||
    typeof body.deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(body.deviceId)
  )
    throw new AuthError("invalid_device_credential");
  return {
    id: body.deviceCredentialId,
    secretHash: await hash(body.deviceSecret),
    deviceId: body.deviceId,
  };
}
export async function hasDeviceCredential(
  env: Env,
  playerId: string,
): Promise<boolean> {
  // Older deployments/tests remain readable before the additive migration is installed.
  if (
    !(await env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_device_credential'",
    ).first())
  )
    return false;
  return !!(await env.DB.prepare(
    "SELECT 1 FROM auth_device_credential WHERE player_id=? AND revoked_at IS NULL",
  )
    .bind(playerId)
    .first());
}
export function deviceInsert(
  env: Env,
  playerId: string,
  credential: DeviceCredential,
  sessionId?: string,
) {
  return sessionId
    ? env.DB.prepare(
        "INSERT INTO auth_device_credential(id,player_id,secret_hash,device_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_session WHERE id=? AND player_id=? AND revoked_at IS NULL AND expires_at>?)",
      ).bind(
        credential.id,
        playerId,
        credential.secretHash,
        credential.deviceId,
        now(),
        sessionId,
        playerId,
        now(),
      )
    : env.DB.prepare(
        "INSERT INTO auth_device_credential(id,player_id,secret_hash,device_id,created_at) VALUES(?,?,?,?,?)",
      ).bind(
        credential.id,
        playerId,
        credential.secretHash,
        credential.deviceId,
        now(),
      );
}
export async function credentialOwner(
  env: Env,
  credential: DeviceCredential,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT player_id,secret_hash,device_id,revoked_at FROM auth_device_credential WHERE id=?",
  )
    .bind(credential.id)
    .first<{
      player_id: string;
      secret_hash: string;
      device_id: string;
      revoked_at: number | null;
    }>();
  return row &&
    row.revoked_at == null &&
    row.secret_hash === credential.secretHash &&
    row.device_id === credential.deviceId
    ? row.player_id
    : null;
}
export async function activeDeviceSession(
  env: Env,
  session: {
    provider: string;
    player_id: string;
    device_credential_id?: string | null;
  },
): Promise<boolean> {
  if (session.provider !== "device") return true;
  return (
    !!session.device_credential_id &&
    !!(await env.DB.prepare(
      "SELECT 1 FROM auth_device_credential WHERE id=? AND player_id=? AND revoked_at IS NULL",
    )
      .bind(session.device_credential_id, session.player_id)
      .first())
  );
}
