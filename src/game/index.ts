import { Hono } from "hono";
import { createBackupsApp } from "./backups";
import { createClassicMigrationApp } from "../migration/classic";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Env } from "../env";
import { mintMigrationSession, requirePlayer } from "../auth";
import { hasDeviceCredential } from "../auth/device";
import { AuthError } from "../auth/providers";
import { rateLimit } from "../auth/maintenance";
import { GameError, objectJson, sha256, type Snapshot } from "./validation";
import {
  loadSnapshot,
  publishSnapshot,
  replayOperation,
  type SaveResult,
} from "./storage";
import { applyRewards } from "./rewards";
import { dailyResetState, resetDailyPreferences } from "./daily";
import { readPlayFab, verifyLegacyTicket } from "../migration/playfab";
import { importMigration } from "../migration";
export { publishSnapshot } from "./storage";
export { validateSnapshot } from "./validation";
export { validateRewards } from "./rewards";
export { applyRewardFlags } from "./rewards";
async function bodyJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw 0;
    return body;
  } catch {
    throw new GameError("invalid_request");
  }
}
async function receipt(env: Env, playerId: string, sourceId: string) {
  const row = await env.DB.prepare(
    "SELECT operation_id FROM grant_receipt WHERE player_id=? AND source_id=?",
  )
    .bind(playerId, sourceId)
    .first<{ operation_id: string }>();
  return row ? replayOperation(env, playerId, row.operation_id) : null;
}
async function canonicalGrant(
  env: Env,
  playerId: string,
  body: Record<string, any>,
  saved: SaveResult,
): Promise<SaveResult> {
  if (body.operationId === saved.operationId) return saved;
  const head = await env.DB.prepare(
    "SELECT save_version FROM player WHERE id=?",
  )
    .bind(playerId)
    .first<{ save_version: number }>();
  throw new GameError("reward_already_claimed", 409, undefined, {
    receipt: {
      playerId,
      saveVersion: saved.saveVersion,
      operationId: saved.operationId,
    },
    latestSaveVersion: head?.save_version,
  });
}
async function grant(
  env: Env,
  playerId: string,
  sourceId: string,
  rewards: unknown,
  body: Record<string, any>,
  mailId?: string,
  mutate?: (prefs: Record<string, string>) => void | Promise<void>,
) {
  const previous = await receipt(env, playerId, sourceId);
  if (previous) return canonicalGrant(env, playerId, body, previous);
  const saved = await loadSnapshot(env, playerId);
  if (body.expectedSaveVersion !== saved.saveVersion) {
    const canonical = await receipt(env, playerId, sourceId);
    if (canonical) return canonicalGrant(env, playerId, body, canonical);
    throw new GameError("save_conflict", 409);
  }
  let data =
    rewards === undefined ? saved.data : applyRewards(saved.data, rewards);
  if (mutate) {
    const prefs = objectJson(data.CLOUD_ALL_DATA, "CLOUD_ALL_DATA") as Record<
      string,
      string
    >;
    await mutate(prefs);
    data = { ...data, CLOUD_ALL_DATA: JSON.stringify(prefs) };
  }
  const snapshot: Snapshot = {
    game: "ec1",
    schemaVersion: 1,
    data,
    playtime: saved.playtime,
    expectedSaveVersion: saved.saveVersion,
    operationId: body.operationId,
  };
  return canonicalGrant(
    env,
    playerId,
    body,
    await publishSnapshot(env, playerId, snapshot, {
      grant: { sourceId, mailId },
    }),
  );
}
async function dailyState(env: Env, playerId: string) {
  const latest = await env.DB.prepare(
    "SELECT COUNT(*) OVER() AS count,created_at,operation_id FROM grant_receipt WHERE player_id=? AND source_id LIKE 'daily:%' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(playerId)
    .first<{ count: number; created_at: number; operation_id: string }>();
  // Once a server receipt exists, future attendance is based on its immutable revision rather than an editable client preference.
  const saved = latest
    ? await replayOperation(env, playerId, latest.operation_id)
    : await loadSnapshot(env, playerId);
  if (!saved) throw new GameError("save_integrity_failure", 503);
  const prefs = objectJson(saved.data.CLOUD_ALL_DATA, "CLOUD_ALL_DATA"),
    lastReward = Number(prefs.LastReward);
  const legacyDate =
    typeof prefs.LastRewardTime === "string" && prefs.LastRewardTime
      ? Date.parse(prefs.LastRewardTime)
      : null;
  if (!latest && legacyDate !== null && !Number.isFinite(legacyDate))
    throw new GameError(
      "daily_state_recovery_required",
      409,
      "legacy_timestamp_culture_unsupported",
    );
  const lastClaimAt = latest?.created_at ?? legacyDate;
  const nextEligibleAt = lastClaimAt ? lastClaimAt + 86_400_000 : 0;
  return {
    claimCount: latest?.count || 0,
    lastReward,
    lastClaimAt,
    nextEligibleAt,
    eligible: Date.now() >= nextEligibleAt,
    serverTime: Date.now(),
  };
}
export function createGameApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    bodyLimit({
      maxSize: 2_100_000,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );
  app.onError((error, c) =>
    error instanceof AuthError
      ? c.json({ error: error.code }, error.status)
      : error instanceof GameError
        ? c.json(
            {
              error: error.code,
              ...(error.reason ? { reason: error.reason } : {}),
              ...(error.details || {}),
              ...(error.code === "no_save"
                ? { saveState: error.reason, saveVersion: 0 }
                : {}),
            },
            error.status as any,
          )
        : c.json({ error: "game_service_unavailable" }, 503),
  );
  app.post("/migration/proof", async (c) => {
    if (c.env.LEGACY_MIGRATION_ENABLED !== "true")
      throw new GameError("migration_disabled", 503);
    await rateLimit(
      c.env,
      "legacy-proof",
      c.req.header("CF-Connecting-IP") || "local",
      10,
      300,
    );
    const body = await bodyJson(c),
      id = await verifyLegacyTicket(c.env, body.sessionTicket);
    const info = await readPlayFab(c.env, "Server/GetUserAccountInfo", {
        PlayFabId: id,
      }),
      account = info.UserInfo;
    if (
      !account ||
      typeof account.PlayFabId !== "string" ||
      account.PlayFabId.toUpperCase() !== id
    )
      throw new GameError("legacy_proof_invalid", 401);
    const customId = account.CustomIdInfo?.CustomId;
    const device =
      typeof body.deviceId === "string" &&
      typeof customId === "string" &&
      body.deviceId === customId
        ? body.deviceId
        : null;
    const session = await mintMigrationSession(c.env, id, device);
    await c.env.DB.prepare(
      "INSERT INTO migration_identity_proof(player_id,google_subject,email,custom_id_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET google_subject=excluded.google_subject,email=excluded.email,custom_id_hash=excluded.custom_id_hash,created_at=excluded.created_at",
    )
      .bind(
        id,
        account.GoogleInfo?.GoogleId || null,
        account.PrivateInfo?.Email?.toLowerCase() || null,
        typeof customId === "string" ? await sha256(customId) : null,
        Date.now(),
      )
      .run();
    return c.json(session);
  });
  app.use("*", requirePlayer);
  app.use("*", async (c, next) => {
    if (
      c.get("player").scope === "migration" &&
      !c.req.path.endsWith("/readiness") &&
      !c.req.path.includes("/migration/")
    )
      return c.json({ error: "migration_scope_restricted" }, 403);
    await next();
  });
  app.route("/migration/classic", createClassicMigrationApp());
  // Historical grant/save writers mutate preference dictionaries and cannot publish canonical manual backups.
  app.use("*", async (c, next) => {
    if (c.env.EC1_MANUAL_BACKUPS_ENABLED === "true" && c.req.method !== "GET" &&
        (c.req.path.endsWith("/save") || /\/(?:claim|daily|coupon|migration)(?:\/|$)/.test(c.req.path)))
      throw new GameError("legacy_gameplay_writer_disabled", 503);
    await next();
  });
  app.route("/backups", createBackupsApp());
  app.get("/readiness", async (c) => {
    const p = c.get("player"),
      row = await c.env.DB.prepare(
        "SELECT save_state,save_version FROM player WHERE id=?",
      )
        .bind(p.playerId)
        .first();
    const migration = await c.env.DB.prepare(
      "SELECT status,winner,save_version,reason FROM migration_record WHERE player_id=?",
    )
      .bind(p.playerId)
      .first();
    return c.json({
      playerId: p.playerId,
      saveState: row?.save_state,
      saveVersion: row?.save_version,
      nativeComplete:
        p.scope === "player" &&
        (row?.save_state === "native_ready" || row?.save_state === "migrated"),
      migration,
    });
  });
  app.post("/migration/import", async (c) =>
    c.json(
      await importMigration(
        c.env,
        c.get("player").playerId,
        await bodyJson(c),
        c.get("player").deviceId,
      ),
    ),
  );
  app.post("/migration/complete", async (c) => {
    // Pausing new source imports must still allow already imported players to finish native cutover.
    const p = c.get("player");
    if (p.scope !== "player")
      throw new GameError("native_authentication_required", 403);
    const identity = await c.env.DB.prepare(
      "SELECT 1 FROM auth_identity WHERE player_id=? AND provider<>'guest'",
    )
      .bind(p.playerId)
      .first();
    if (!identity && !(await hasDeviceCredential(c.env, p.playerId)))
      throw new GameError("durable_identity_required", 403);
    await loadSnapshot(c.env, p.playerId);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE migration_record SET status='complete',updated_at=? WHERE player_id=? AND status='imported_pending_auth'",
      ).bind(Date.now(), p.playerId),
      c.env.DB.prepare(
        "UPDATE player SET save_state='migrated',migrated_at=COALESCE(migrated_at,?),updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM migration_record WHERE player_id=? AND status='complete')",
      ).bind(
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
        p.playerId,
        p.playerId,
      ),
    ]);
    const record = await c.env.DB.prepare(
      "SELECT status FROM migration_record WHERE player_id=?",
    )
      .bind(p.playerId)
      .first();
    if (record?.status !== "complete")
      throw new GameError("migration_not_imported", 409);
    await c.env.DB.prepare(
      "UPDATE auth_session SET revoked_at=? WHERE player_id=? AND scope='migration' AND revoked_at IS NULL",
    )
      .bind(Math.floor(Date.now() / 1000), p.playerId)
      .run();
    return c.json({ complete: true, playerId: p.playerId });
  });
  app.get("/save", async (c) =>
    c.json(await loadSnapshot(c.env, c.get("player").playerId)),
  );
  app.get("/profile", async (c) => {
    const p = c.get("player"),
      row = await c.env.DB.prepare("SELECT display_name FROM player WHERE id=?")
        .bind(p.playerId)
        .first<{ display_name: string | null }>();
    return c.json({
      playerId: p.playerId,
      displayName: row?.display_name || "",
    });
  });
  app.put("/profile", async (c) => {
    const p = c.get("player"),
      body = await bodyJson(c);
    if (typeof body.displayName !== "string")
      throw new GameError("invalid_display_name");
    const name = body.displayName.trim().normalize("NFC");
    if (
      name.length < 1 ||
      name.length > 24 ||
      !/[\p{L}\p{N}]/u.test(name) ||
      /[\p{C}<>\[\]{}|\/\\]/u.test(name)
    )
      throw new GameError("invalid_display_name");
    await rateLimit(c.env, "display-name", p.playerId, 10, 300);
    await c.env.DB.prepare(
      "UPDATE player SET display_name=?,updated_at=? WHERE id=?",
    )
      .bind(name, Math.floor(Date.now() / 1000), p.playerId)
      .run();
    return c.json({ playerId: p.playerId, displayName: name });
  });
  app.get("/leaderboard", async (c) => {
    const requested = Number(c.req.query("limit") || 100);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100)
      throw new GameError("invalid_leaderboard_limit");
    const time = Math.floor(Date.now() / 1000),
      p = c.get("player");
    const result = await c.env.DB.prepare(
      "SELECT l.player_id AS playerId,COALESCE(p.display_name,'') AS playerName,l.character,l.floor,l.cleartime,l.save_version AS saveVersion FROM player_leaderboard l JOIN player p ON p.id=l.player_id WHERE l.floor>0 AND NOT EXISTS(SELECT 1 FROM player_ban b WHERE b.player_id=l.player_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>?)) ORDER BY l.floor DESC,l.cleartime ASC,l.character DESC,l.player_id LIMIT ?",
    )
      .bind(time, requested)
      .all();
    const mine = await c.env.DB.prepare(
      "SELECT l.player_id AS playerId,COALESCE(p.display_name,'') AS playerName,l.character,l.floor,l.cleartime,l.save_version AS saveVersion,1+(SELECT COUNT(*) FROM player_leaderboard other WHERE (other.floor>l.floor OR (other.floor=l.floor AND (other.cleartime<l.cleartime OR (other.cleartime=l.cleartime AND (other.character>l.character OR (other.character=l.character AND other.player_id<l.player_id)))))) AND NOT EXISTS(SELECT 1 FROM player_ban b WHERE b.player_id=other.player_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>?))) AS rank FROM player_leaderboard l JOIN player p ON p.id=l.player_id WHERE l.player_id=? AND l.floor>0",
    )
      .bind(time, p.playerId)
      .first();
    return c.json({
      leaderboard: "infinity_fortress",
      entries: result.results.map((row, i) => ({ playerId: row.playerId, playerName: row.playerName, saveVersion: row.saveVersion, record: { character: row.character, floor: row.floor, cleartime: row.cleartime }, rank: i + 1 })),
      me: mine ? { playerId: mine.playerId, playerName: mine.playerName, saveVersion: mine.saveVersion, record: { character: mine.character, floor: mine.floor, cleartime: mine.cleartime }, rank: mine.rank } : null,
    });
  });
  app.put("/save", async (c) => {
    const p = c.get("player"),
      body = await bodyJson(c);
    if (body.deviceId && body.deviceId !== p.deviceId)
      throw new GameError("device_mismatch", 403);
    return c.json(await publishSnapshot(c.env, p.playerId, body));
  });
  app.get("/inbox", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id,title,body,rewards_json,created_at,expires_at,read_at,claimed_at FROM mail WHERE player_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 100",
    )
      .bind(c.get("player").playerId, Date.now())
      .all();
    return c.json({
      mail: rows.results.map((row: any) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        rewards: JSON.parse(row.rewards_json),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        readAt: row.read_at,
        claimedAt: row.claimed_at,
      })),
    });
  });
  app.post("/mail/:id/read", async (c) => {
    const result = await c.env.DB.prepare(
      "UPDATE mail SET read_at=COALESCE(read_at,?) WHERE id=? AND player_id=?",
    )
      .bind(Date.now(), c.req.param("id"), c.get("player").playerId)
      .run();
    if (!result.meta.changes) throw new GameError("mail_not_found", 404);
    return c.json({ read: true });
  });
  app.post("/mail/:id/claim", async (c) => {
    const p = c.get("player"),
      id = c.req.param("id"),
      source = `mail:${id}`,
      body = await bodyJson(c),
      previous = await receipt(c.env, p.playerId, source);
    if (previous)
      return c.json(await canonicalGrant(c.env, p.playerId, body, previous));
    const row = await c.env.DB.prepare(
      "SELECT rewards_json,expires_at FROM mail WHERE id=? AND player_id=? AND claimed_at IS NULL",
    )
      .bind(id, p.playerId)
      .first<{ rewards_json: string; expires_at: number | null }>();
    if (!row) throw new GameError("mail_not_found", 404);
    if (row.expires_at && row.expires_at <= Date.now())
      throw new GameError("mail_expired", 409);
    return c.json(
      await grant(
        c.env,
        p.playerId,
        source,
        JSON.parse(row.rewards_json),
        body,
        id,
      ),
    );
  });
  app.get("/time", (c) =>
    c.json({ serverTime: Date.now(), isoTime: new Date().toISOString() }),
  );
  app.get("/daily/check", async (c) => {
    const playerId = c.get("player").playerId;
    return c.json({
      ...(await dailyState(c.env, playerId)),
      reset: await dailyResetState(c.env, playerId),
    });
  });
  app.post("/daily/reset", async (c) => {
    const p = c.get("player"),
      body = await bodyJson(c);
    if (!Number.isSafeInteger(body.period) || body.period < 0)
      throw new GameError("invalid_daily_reset_period");
    const prior = await c.env.DB.prepare(
      "SELECT source_id,save_version FROM grant_receipt WHERE player_id=? AND operation_id=? AND source_id LIKE 'daily-reset:%'",
    )
      .bind(p.playerId, body.operationId || "")
      .first<{ source_id: string; save_version: number }>();
    const source = `daily-reset:${body.period}`;
    if (prior) {
      if (
        prior.source_id !== source ||
        body.expectedSaveVersion !== prior.save_version - 1
      )
        throw new GameError("operation_id_reused", 409);
      return c.json(await receipt(c.env, p.playerId, source));
    }
    const previous = await receipt(c.env, p.playerId, source);
    if (previous)
      return c.json(await canonicalGrant(c.env, p.playerId, body, previous));
    const state = await dailyResetState(c.env, p.playerId);
    if (body.period !== state.period)
      throw new GameError("daily_reset_period_expired", 409, undefined, {
        currentPeriod: state.period,
      });
    if (!state.eligible) throw new GameError("daily_reset_not_ready", 409);
    return c.json(
      await grant(
        c.env,
        p.playerId,
        source,
        undefined,
        body,
        undefined,
        (prefs) => resetDailyPreferences(prefs, p.playerId, state.period),
      ),
    );
  });
  app.post("/daily/claim", async (c) => {
    const p = c.get("player"),
      body = await bodyJson(c);
    // Operation replay precedes time eligibility so a lost response never becomes a false cooldown failure.
    const prior = await c.env.DB.prepare(
      "SELECT source_id FROM grant_receipt WHERE player_id=? AND operation_id=? AND source_id LIKE 'daily:%'",
    )
      .bind(p.playerId, body.operationId || "")
      .first<{ source_id: string }>();
    if (prior) return c.json(await receipt(c.env, p.playerId, prior.source_id));
    const state = await dailyState(c.env, p.playerId);
    if (!state.eligible) throw new GameError("daily_not_ready", 409);
    const config = await c.env.DB.prepare(
      "SELECT value_json FROM game_config WHERE key='daily_rewards'",
    ).first<{ value_json: string }>();
    if (!config) throw new GameError("daily_not_configured", 503);
    const rewards = JSON.parse(config.value_json).rewards;
    if (!Array.isArray(rewards) || !rewards.length)
      throw new GameError("daily_not_configured", 503);
    const index = state.lastReward % rewards.length;
    return c.json(
      await grant(
        c.env,
        p.playerId,
        `daily:${state.claimCount + 1}`,
        rewards[index],
        body,
        undefined,
        (prefs) => {
          prefs.LastReward = String(index + 1);
          prefs.LastRewardTime = new Date(state.serverTime).toISOString();
        },
      ),
    );
  });
  app.post("/coupon/redeem", async (c) => {
    const p = c.get("player"),
      body = await bodyJson(c);
    if (
      typeof body.code !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(body.code)
    )
      throw new GameError("invalid_coupon");
    const source = `coupon:${body.code}`,
      previous = await receipt(c.env, p.playerId, source);
    if (previous)
      return c.json(await canonicalGrant(c.env, p.playerId, body, previous));
    const row = await c.env.DB.prepare(
      "SELECT rewards_json,expires_at FROM coupon WHERE code=? AND enabled=1",
    )
      .bind(body.code)
      .first<{ rewards_json: string; expires_at: number | null }>();
    if (!row || (row.expires_at && row.expires_at <= Date.now()))
      throw new GameError("coupon_unavailable", 404);
    return c.json(
      await grant(
        c.env,
        p.playerId,
        source,
        JSON.parse(row.rewards_json),
        body,
        undefined,
        (prefs) => {
          const gd = objectJson(prefs.gamedata, "gamedata"),
            used = gd.usedCoupons as string[];
          if (used.includes(body.code))
            throw new GameError("already_claimed", 409);
          gd.usedCoupons = [...used, body.code];
          prefs.gamedata = JSON.stringify(gd);
        },
      ),
    );
  });
  return app;
}
