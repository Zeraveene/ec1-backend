import type { Env } from "../env";
import { GameError } from "../game/validation";
// An explicit allowlist prevents accidentally porting legacy clear-mail/marker/link callbacks.
const allowed = new Set([
  "Server/AuthenticateSessionTicket",
  "Server/GetUserData",
  "Server/GetUserReadOnlyData",
  "Server/GetUserInventory",
  "Server/GetPlayerProfile",
  "Server/GetUserAccountInfo",
]);
export async function readPlayFab(
  env: Env,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  if (!allowed.has(endpoint))
    throw new GameError("legacy_mutation_forbidden", 403);
  if (env.LEGACY_MIGRATION_ENABLED !== "true")
    throw new GameError("migration_disabled", 503);
  if (
    !env.PLAYFAB_TITLE_ID ||
    !/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID) ||
    !env.PLAYFAB_SECRET_KEY
  )
    throw new GameError("migration_not_configured", 503);
  let response: Response;
  try {
    response = await fetch(
      `https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/${endpoint}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-SecretKey": env.PLAYFAB_SECRET_KEY,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    throw new GameError("legacy_source_unavailable", 503);
  }
  if (!response.ok)
    throw new GameError(
      response.status === 400
        ? "legacy_proof_invalid"
        : "legacy_source_unavailable",
      response.status === 400 ? 401 : 503,
    );
  let result: Record<string, any>;
  try {
    result = await response.json();
  } catch {
    throw new GameError("legacy_source_unavailable", 503);
  }
  if (result.error || !result.data)
    throw new GameError("legacy_proof_invalid", 401);
  return result.data;
}
export async function verifyLegacyTicket(
  env: Env,
  ticket: unknown,
): Promise<string> {
  if (typeof ticket !== "string" || ticket.length < 16 || ticket.length > 4096)
    throw new GameError("legacy_proof_invalid", 401);
  const result = await readPlayFab(env, "Server/AuthenticateSessionTicket", {
    SessionTicket: ticket,
  });
  const id = result.UserInfo?.PlayFabId;
  if (
    result.IsSessionTicketExpired ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9]{8,64}$/.test(id)
  )
    throw new GameError("legacy_proof_invalid", 401);
  return id.toUpperCase();
}
