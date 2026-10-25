import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Env } from "../env";
import { requirePlayer } from "../auth";
import { GameError } from "../game/validation";
import {
  adminFailure,
  installLiveopsErrors,
  auditStatement,
  commitAdminMutation,
  replayAdminMutation,
  expectedRevision,
  getGrant,
  grantInsertFromSelect,
  page,
  nextPage,
  text,
  timestamp,
  validateGrantRewards,
  type AdminActor,
  type AdminRole,
  type AdminResult,
} from "./grants";
function code(value: unknown): string {
  const v = text(value, "code", 64).toUpperCase();
  if (!/^[A-Z0-9_-]{3,64}$/.test(v)) throw new GameError("invalid_code");
  return v;
}
function view(row: Record<string, unknown>) {
  return {
    id: row.id,
    revision: row.revision,
    playerIds: row.player_ids_json
      ? JSON.parse(String(row.player_ids_json))
      : null,
    code: row.code,
    title: row.title,
    rewards: JSON.parse(String(row.rewards_json)),
    enabled: !!row.enabled,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    maxClaims: row.max_claims,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claim_count !== undefined ? { claimCount: row.claim_count } : {}),
  };
}
export async function claimCoupon(
  env: Env,
  playerId: string,
  suppliedCode: unknown,
) {
  const normalized = code(suppliedCode),
    row = await env.DB.prepare("SELECT id FROM liveops_coupon WHERE code=?")
      .bind(normalized)
      .first<{ id: string }>();
  if (!row) throw new GameError("coupon_unavailable", 404);
  const existing = await getGrant(env, playerId, "coupon", row.id);
  if (existing) return { grant: existing, replayed: true };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO liveops_coupon_claim(coupon_id,player_id,claimed_at) SELECT id,?,? FROM liveops_coupon WHERE id=? AND enabled=1 AND (player_ids_json IS NULL OR EXISTS(SELECT 1 FROM json_each(player_ids_json) WHERE value=?)) AND (starts_at IS NULL OR starts_at<=?) AND (expires_at IS NULL OR expires_at>?) AND (max_claims IS NULL OR (SELECT COUNT(*) FROM liveops_coupon_claim WHERE coupon_id=liveops_coupon.id)<max_claims)`,
    ).bind(playerId, now, row.id, playerId, now, now),
    grantInsertFromSelect(env, {
      playerId,
      sourceType: "coupon",
      sourceId: row.id,
      selectSql:
        "SELECT c.rewards_json, cl.claimed_at AS created_at FROM liveops_coupon c JOIN liveops_coupon_claim cl ON cl.coupon_id=c.id WHERE c.id=? AND cl.player_id=?",
      bindings: [row.id, playerId],
    }),
  ]);
  const grant = await getGrant(env, playerId, "coupon", row.id);
  if (!grant) throw new GameError("coupon_unavailable", 409);
  return { grant };
}
export function createCouponApp() {
  const app = new Hono<AppEnv>();
  installLiveopsErrors(app);
  app.use("*", requirePlayer);
  app.use(
    "*",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    const now = Date.now();
    await c.env.DB.prepare(
      "DELETE FROM liveops_rate_limit WHERE bucket IN (SELECT bucket FROM liveops_rate_limit WHERE expires_at<=? LIMIT 50)",
    )
      .bind(now)
      .run();
    const row = await c.env.DB.prepare(
      "INSERT INTO liveops_rate_limit(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at",
    )
      .bind("coupon:" + c.get("player").playerId, now + 60000, now, now)
      .first<{ count: number; expires_at: number }>();
    if (row && row.count > 30) {
      c.header(
        "Retry-After",
        String(Math.max(1, Math.ceil((row.expires_at - now) / 1000))),
      );
      return c.json(
        {
          error: "rate_limited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((row.expires_at - now) / 1000),
          ),
        },
        429,
      );
    }
    await next();
  });
  app.post("/check", async (c) =>
    c.json(
      await checkCoupon(
        c.env,
        c.get("player").playerId,
        (await c.req.json())?.code,
      ),
    ),
  );
  app.post("/claim", async (c) =>
    c.json(
      await claimCoupon(
        c.env,
        c.get("player").playerId,
        (await c.req.json())?.code,
      ),
    ),
  );
  return app;
}
export async function dispatchCouponAdmin(
  env: Env,
  actor: AdminActor,
  role: AdminRole,
  operation: string,
  args: Record<string, unknown>,
): Promise<AdminResult> {
  try {
    if (!["internal", "manager", "guest"].includes(role))
      return { status: 403, body: { error: "forbidden" } };
    if (operation === "coupons.list") {
      const p = page(args);
      const rows = await env.DB.prepare(
        "SELECT c.*, (SELECT COUNT(*) FROM liveops_coupon_claim WHERE coupon_id=c.id) claim_count FROM liveops_coupon c WHERE (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
      )
        .bind(p.before, p.before, p.beforeId, p.limit + 1)
        .all<Record<string, unknown>>();
      const values = rows.results.slice(0, p.limit);
      return {
        status: 200,
        body: {
          coupons: values.map(view),
          nextBefore: nextPage(rows.results, p.limit),
        },
      };
    }
    if (!["coupons.detail"].includes(operation)) {
      if (role === "guest")
        return { status: 403, body: { error: "forbidden" } };
      const replay = await replayAdminMutation(env, actor, operation, args);
      if (replay) return replay;
    }
    const id =
      operation === "coupons.create"
        ? crypto.randomUUID()
        : text(args.id, "id", 128);
    const previous =
      operation === "coupons.create"
        ? null
        : await env.DB.prepare("SELECT * FROM liveops_coupon WHERE id=?")
            .bind(id)
            .first<Record<string, unknown>>();
    if (operation !== "coupons.create" && !previous)
      return { status: 404, body: { error: "coupon_not_found" } };
    if (operation === "coupons.detail")
      return { status: 200, body: { coupon: view(previous!) } };
    if (role === "guest") return { status: 403, body: { error: "forbidden" } };
    if (
      !["coupons.create", "coupons.update", "coupons.disable"].includes(
        operation,
      )
    )
      return { status: 400, body: { error: "unknown_operation" } };
    const now = Date.now();
    if (operation === "coupons.disable") {
      const revision = expectedRevision(args);
      return await commitAdminMutation(
        env,
        actor,
        operation,
        args,
        [
          env.DB.prepare(
            "UPDATE liveops_coupon SET enabled=0,updated_at=?,revision=revision+1 WHERE id=?",
          ).bind(now, id),
          auditStatement(env, actor, operation, null, { id }),
        ],
        { status: 200, body: { id, disabled: true, revision: revision + 1 } },
        {
          sql: "EXISTS(SELECT 1 FROM liveops_coupon WHERE id=? AND revision=?)",
          bindings: [id, revision],
        },
      );
    }
    const merged = { ...(previous ? view(previous) : {}), ...args };
    const targets = merged.playerIds ?? null;
    if (
      targets !== null &&
      (!Array.isArray(targets) ||
        !targets.length ||
        targets.length > 1000 ||
        targets.some((x) => typeof x !== "string" || x.length > 128))
    )
      throw new GameError("invalid_player_ids");
    const values = {
      playerIds: targets,
      code: code(merged.code),
      title: text(merged.title, "title", 200),
      rewards: validateGrantRewards(merged.rewards),
      startsAt: timestamp(merged.startsAt),
      expiresAt: timestamp(merged.expiresAt),
      maxClaims: timestamp(merged.maxClaims),
      enabled: merged.enabled ?? true,
    };
    if (
      typeof values.enabled !== "boolean" ||
      values.maxClaims === 0 ||
      (values.startsAt !== null &&
        values.expiresAt !== null &&
        values.expiresAt <= values.startsAt)
    )
      throw new GameError("invalid_coupon");
    // Code identity is stable so a receipt can always be recovered with the original code.
    if (previous && values.code !== previous.code)
      throw new GameError("coupon_code_immutable", 409);
    const duplicate = await env.DB.prepare(
      "SELECT id FROM liveops_coupon WHERE code=? AND id<>?",
    )
      .bind(values.code, id)
      .first();
    if (duplicate) {
      const replay = await replayAdminMutation(env, actor, operation, args);
      if (replay) return replay;
      throw new GameError("coupon_code_exists", 409);
    }
    const statement =
      operation === "coupons.create"
        ? env.DB.prepare(
            "INSERT INTO liveops_coupon(id,code,title,rewards_json,enabled,starts_at,expires_at,max_claims,created_at,updated_at,player_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          ).bind(
            id,
            values.code,
            values.title,
            JSON.stringify(values.rewards),
            Number(values.enabled),
            values.startsAt,
            values.expiresAt,
            values.maxClaims,
            now,
            now,
            targets === null ? null : JSON.stringify(targets),
          )
        : env.DB.prepare(
            "UPDATE liveops_coupon SET title=?,rewards_json=?,enabled=?,starts_at=?,expires_at=?,max_claims=?,updated_at=?,player_ids_json=?,revision=revision+1 WHERE id=?",
          ).bind(
            values.title,
            JSON.stringify(values.rewards),
            Number(values.enabled),
            values.startsAt,
            values.expiresAt,
            values.maxClaims,
            now,
            targets === null ? null : JSON.stringify(targets),
            id,
          );
    const revision =
      operation === "coupons.create" ? 1 : expectedRevision(args) + 1;
    return await commitAdminMutation(
      env,
      actor,
      operation,
      args,
      [
        statement,
        auditStatement(env, actor, operation, null, { id, ...values }),
      ],
      {
        status: operation === "coupons.create" ? 201 : 200,
        body: { coupon: { id, revision, ...values } },
      },
      operation === "coupons.create"
        ? undefined
        : {
            sql: "EXISTS(SELECT 1 FROM liveops_coupon WHERE id=? AND revision=?)",
            bindings: [id, revision - 1],
          },
    );
  } catch (error) {
    if (operation === "coupons.create" && !(error instanceof GameError)) {
      // A concurrent create can win after the earlier uniqueness preview.
      // Recover the exact operation first, then report only a confirmed code collision.
      const replay = await replayAdminMutation(env, actor, operation, args);
      if (replay) return replay;
      const duplicate = await env.DB.prepare(
        "SELECT id FROM liveops_coupon WHERE code=?",
      )
        .bind(code(args.code))
        .first();
      if (duplicate)
        return { status: 409, body: { error: "coupon_code_exists" } };
    }
    return adminFailure(error);
  }
}

export async function checkCoupon(
  env: Env,
  playerId: string,
  suppliedCode: unknown,
) {
  const row = await env.DB.prepare("SELECT * FROM liveops_coupon WHERE code=?")
    .bind(code(suppliedCode))
    .first<Record<string, unknown>>();
  if (!row) throw new GameError("coupon_unavailable", 404);
  const grant = await getGrant(env, playerId, "coupon", String(row.id));
  if (grant) return { eligible: false, claimed: true, grant };
  const now = Date.now(),
    targets = row.player_ids_json
      ? (JSON.parse(String(row.player_ids_json)) as string[])
      : null;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) n FROM liveops_coupon_claim WHERE coupon_id=?",
  )
    .bind(row.id)
    .first<{ n: number }>();
  if (
    !row.enabled ||
    (row.starts_at !== null && Number(row.starts_at) > now) ||
    (row.expires_at !== null && Number(row.expires_at) <= now) ||
    (targets && !targets.includes(playerId)) ||
    (row.max_claims !== null && Number(count?.n) >= Number(row.max_claims))
  )
    throw new GameError("coupon_unavailable", 409);
  return {
    eligible: true,
    claimed: false,
    coupon: {
      id: row.id,
      title: row.title,
      rewards: JSON.parse(String(row.rewards_json)),
      expiresAt: row.expires_at,
    },
  };
}
