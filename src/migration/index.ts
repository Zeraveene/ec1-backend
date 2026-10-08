import type { Env } from "../env";
import {
  GameError,
  sha256,
  stableJson,
  validateSnapshot,
  type Snapshot,
} from "../game/validation";
import { publishSnapshot } from "../game/storage";
import { readPlayFab, verifyLegacyTicket } from "./playfab";
import { applyRewardFlags, validateRewards } from "../game/rewards";
async function recovery(
  env: Env,
  playerId: string,
  cloudArchive: string,
  localArchive: string,
  error: GameError,
): Promise<never> {
  await env.DB.prepare(
    "INSERT INTO migration_record(player_id,status,cloud_archive,local_archive,reason,created_at,updated_at) SELECT id,'recovery_required',?,?,?,?,? FROM player WHERE id=? AND save_version=0 ON CONFLICT(player_id) DO UPDATE SET status='recovery_required',cloud_archive=excluded.cloud_archive,local_archive=excluded.local_archive,reason=excluded.reason,updated_at=excluded.updated_at WHERE migration_record.save_version IS NULL",
  )
    .bind(
      cloudArchive,
      localArchive,
      error.code,
      Date.now(),
      Date.now(),
      playerId,
    )
    .run();
  throw error;
}
async function archive(
  env: Env,
  playerId: string,
  label: string,
  value: unknown,
): Promise<string> {
  const bytes = stableJson(value),
    hash = await sha256(bytes),
    key = `ec1/${playerId}/${crypto.randomUUID()}/${label}-${hash}.json`;
  await env.LEGACY_ARCHIVE.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
  });
  const saved = await env.LEGACY_ARCHIVE.get(key);
  if (!saved || (await sha256(await saved.text())) !== hash)
    throw new GameError("legacy_archive_failed", 503);
  return key;
}
export function selectMigrationWinner(
  cloud: unknown,
  local: unknown,
): { winner: "cloud" | "local"; snapshot: Snapshot } {
  const assess = (input: unknown) => {
    try {
      return validateSnapshot(input, true);
    } catch {
      return null;
    }
  };
  const c = assess(cloud),
    l = assess(local);
  if (!c?.healthy && !l?.healthy)
    throw new GameError(
      "migration_recovery_required",
      409,
      "both_sources_damaged_or_default",
    );
  const chooseCloud =
    c?.healthy &&
    (!l?.healthy ||
      (c.progressed && !l.progressed) ||
      (c.progressed === l.progressed &&
        c.effectivePlaytime >= l.effectivePlaytime));
  const winner = chooseCloud ? "cloud" : "local",
    selected = chooseCloud ? c! : l!;
  // Keep proven same-account entitlement flags independently from the chosen gameplay timeline.
  const flags: Record<string, string> = {};
  for (const source of [c, l])
    if (source)
      for (const [key, value] of Object.entries(source.prefs))
        if (
          value === "1" &&
          /^(premium|more_exp|double_loot|dualTaken|elysianTaken|louisaUnlock|soulUnlock|stepUp[1-5]|costume_(alaster|edna|louisa|soul)_[1-8])$/.test(
            key,
          ) &&
          selected.prefs[key] !== "1"
        )
          flags[key] = "1";
  return {
    winner,
    snapshot: Object.keys(flags).length
      ? {
          ...selected.snapshot,
          data: applyRewardFlags(selected.snapshot.data, flags),
        }
      : selected.snapshot,
  };
}
export async function importMigration(
  env: Env,
  playerId: string,
  body: Record<string, any>,
  verifiedDeviceId: string | null = null,
) {
  const verified = await verifyLegacyTicket(env, body.sessionTicket);
  if (verified !== playerId) throw new GameError("legacy_owner_mismatch", 403);
  const existing = await env.DB.prepare(
    "SELECT save_version,save_state FROM player WHERE id=?",
  )
    .bind(playerId)
    .first<{ save_version: number; save_state: string }>();
  if (!existing) throw new GameError("player_not_found", 404);
  // Lost acknowledgment resumes the actual committed winner; it never ranks a new submission over an import.
  if (existing.save_version > 0) {
    const { loadSnapshot } = await import("../game/storage");
    return loadSnapshot(env, playerId);
  }
  if (
    typeof body.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(body.operationId)
  )
    throw new GameError("invalid_operation_id");
  const [user, inventory, profile, accountInfo] = await Promise.all([
    readPlayFab(env, "Server/GetUserData", { PlayFabId: verified }),
    readPlayFab(env, "Server/GetUserInventory", { PlayFabId: verified }),
    readPlayFab(env, "Server/GetPlayerProfile", {
      PlayFabId: verified,
      ProfileConstraints: { ShowBannedUntil: true, ShowLinkedAccounts: true },
    }),
    readPlayFab(env, "Server/GetUserAccountInfo", { PlayFabId: verified }),
  ]);
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(user.Data || {}))
    if (v && typeof (v as { Value?: unknown }).Value === "string")
      values[k] = (v as { Value: string }).Value;
  const cloud = {
    game: "ec1",
    schemaVersion: 1,
    playtime: Number(values.Playtime || 0),
    data: values,
    expectedSaveVersion: 0,
    operationId: body.operationId,
  } as Snapshot;
  const cloudArchive = await archive(env, playerId, "cloud", {
    user,
    inventory,
    profile,
    accountInfo,
  });
  const localArchive = await archive(
    env,
    playerId,
    "local",
    body.localSnapshot ?? null,
  );
  const bannedUntil = Date.parse(profile.PlayerProfile?.BannedUntil || "");
  if (Number.isFinite(bannedUntil) && bannedUntil > Date.now()) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO player_ban(player_id,reason,created_at,expires_at) VALUES(?,?,?,?)",
    )
      .bind(
        playerId,
        "Preserved legacy account ban",
        Math.floor(Date.now() / 1000),
        Math.ceil(bannedUntil / 1000),
      )
      .run();
    return recovery(
      env,
      playerId,
      cloudArchive,
      localArchive,
      new GameError("legacy_player_banned", 403),
    );
  }
  const customId = accountInfo.UserInfo?.CustomIdInfo?.CustomId;
  if (
    body.localSnapshot &&
    (!verifiedDeviceId ||
      customId !== verifiedDeviceId ||
      body.localSnapshot.deviceId !== verifiedDeviceId)
  )
    return recovery(
      env,
      playerId,
      cloudArchive,
      localArchive,
      new GameError(
        "local_owner_mismatch",
        403,
        "originals_archived_for_recovery",
      ),
    );
  let selected: ReturnType<typeof selectMigrationWinner>;
  try {
    selected = selectMigrationWinner(cloud, body.localSnapshot || null);
  } catch (error) {
    return recovery(
      env,
      playerId,
      cloudArchive,
      localArchive,
      error as GameError,
    );
  }
  if (
    inventory.Inventory?.length ||
    Object.keys(inventory.VirtualCurrency || {}).length
  )
    return recovery(
      env,
      playerId,
      cloudArchive,
      localArchive,
      new GameError(
        "migration_entitlement_review_required",
        409,
        "inventory_archived_codec_not_verified",
      ),
    );
  let migrationMail: { id: string; rewardsJson: string } | undefined;
  if (values.EC_MAIL_REWARDS) {
    try {
      const mail = JSON.parse(values.EC_MAIL_REWARDS);
      if (!Array.isArray(mail))
        throw new GameError("migration_mail_review_required", 409);
      if (mail.length) {
        validateRewards(mail);
        migrationMail = {
          id: `legacy-mail-${await sha256(`${playerId}:${values.EC_MAIL_REWARDS}`)}`,
          rewardsJson: values.EC_MAIL_REWARDS,
        };
      }
    } catch {
      return recovery(
        env,
        playerId,
        cloudArchive,
        localArchive,
        new GameError(
          "migration_mail_review_required",
          409,
          "original_pending_mail_archived_and_unclaimed",
        ),
      );
    }
  }
  return publishSnapshot(
    env,
    playerId,
    {
      ...selected.snapshot,
      expectedSaveVersion: 0,
      operationId: body.operationId,
    },
    {
      legacy: true,
      saveState: "imported_pending_auth",
      migration: { cloudArchive, localArchive, winner: selected.winner },
      migrationMail,
    },
  );
}
