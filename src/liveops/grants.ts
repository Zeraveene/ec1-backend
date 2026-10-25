import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requirePlayer } from "../auth";
import { AuthError } from "../auth/providers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import type { Env } from "../env";
import { validateRewards, type Reward } from "../game/rewards";
import { GameError } from "../game/validation";
export function installLiveopsErrors(app: Hono<AppEnv>): void {
  app.onError((error, c) => {
    if (error instanceof GameError || error instanceof AuthError) {
      return c.json(
        {
          error: error.code,
          ...(error instanceof GameError && error.reason
            ? { reason: error.reason }
            : {}),
        },
        error.status as ContentfulStatusCode,
      );
    }
    if (error instanceof SyntaxError)
      return c.json({ error: "invalid_json" }, 400);
    return c.json({ error: "liveops_unavailable" }, 503);
  });
}
export interface GrantReceipt {
  id: string;
  playerId: string;
  sourceType: string;
  sourceId: string;
  rewards: Reward[];
  createdAt: number;
}
export function validateGrantRewards(
  value: unknown,
  allowEmpty = false,
): Reward[] {
  if (allowEmpty && Array.isArray(value) && value.length === 0) return [];
  const rewards = validateRewards(value);
  const seen = new Set<string>();
  return rewards.map((r) => {
    if (seen.has(r.id)) throw new GameError("duplicate_reward");
    seen.add(r.id);
    if (r.name !== undefined && r.name.length > 160)
      throw new GameError("invalid_reward_name");
    return r;
  });
}
/** Trusted SQL only: selectSql must yield rewards_json and created_at. Batch with source eligibility changes. */
export function grantInsertFromSelect(
  env: Env,
  input: {
    playerId: string;
    sourceType: string;
    sourceId: string;
    selectSql: string;
    bindings?: unknown[];
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO liveops_grant(id,player_id,source_type,source_id,rewards_json,created_at) SELECT ?,?,?,?,eligible.rewards_json,eligible.created_at FROM (${input.selectSql}) eligible WHERE 1 ON CONFLICT(player_id,source_type,source_id) DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    input.playerId,
    input.sourceType,
    input.sourceId,
    ...(input.bindings ?? []),
  );
}
export async function getGrant(
  env: Env,
  playerId: string,
  sourceType: string,
  sourceId: string,
): Promise<GrantReceipt | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM liveops_grant WHERE player_id=? AND source_type=? AND source_id=?",
  )
    .bind(playerId, sourceType, sourceId)
    .first<Record<string, unknown>>();
  return row
    ? {
        id: String(row.id),
        playerId: String(row.player_id),
        sourceType: String(row.source_type),
        sourceId: String(row.source_id),
        rewards: JSON.parse(String(row.rewards_json)),
        createdAt: Number(row.created_at),
      }
    : null;
}
export type AdminActor = { id: string; name: string };
export type AdminRole = "internal" | "manager" | "guest";
export type AdminResult = { status: number; body: Record<string, unknown> };
export function auditStatement(
  env: Env,
  actor: AdminActor,
  action: string,
  playerId: string | null,
  detail: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(
    crypto.randomUUID(),
    actor.id,
    actor.name,
    action,
    playerId,
    JSON.stringify(detail),
    Date.now(),
  );
}
export function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new GameError(`invalid_${name}`);
  return value.trim();
}
export function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new GameError("invalid_timestamp");
  return Number(value);
}
export function page(args: Record<string, unknown>): {
  limit: number;
  before: number;
  beforeId: string;
} {
  const limit = Number(args.limit ?? 30),
    raw = String(args.before ?? Number.MAX_SAFE_INTEGER),
    parts = raw.split(":"),
    before = Number(parts[0]),
    beforeId = parts[1] ?? "~";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(before) ||
    before < 0 ||
    parts.length > 2 ||
    beforeId.length > 128
  )
    throw new GameError("invalid_pagination");
  return { limit, before, beforeId };
}
export function nextPage(
  rows: Record<string, unknown>[],
  limit: number,
): string | null {
  const last = rows[Math.min(rows.length, limit) - 1];
  return rows.length > limit ? `${last.created_at}:${last.id}` : null;
}

export function adminFailure(error: unknown): AdminResult {
  if (error instanceof GameError)
    return {
      status: error.status,
      body: { error: error.code, reason: error.reason },
    };
  throw error;
}
/** Admin write idempotency and audit/resource writes share one D1 transaction. */
export async function commitAdminMutation(
  env: Env,
  actor: AdminActor,
  operation: string,
  args: Record<string, unknown>,
  statements: D1PreparedStatement[],
  result: AdminResult,
  guard?: { sql: string; bindings: unknown[] },
): Promise<AdminResult> {
  const operationId = text(args.operationId, "operation_id", 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId))
    throw new GameError("invalid_operation_id");
  const requestJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const read = () =>
    env.DB.prepare(
      "SELECT request_json,result_json FROM liveops_admin_operation WHERE actor_id=? AND operation=? AND operation_id=?",
    )
      .bind(actor.id, operation, operationId)
      .first<{ request_json: string; result_json: string }>();
  const replay = (row: {
    request_json: string;
    result_json: string;
  }): AdminResult => {
    if (row.request_json !== requestJson)
      throw new GameError("operation_conflict", 409);
    return JSON.parse(row.result_json);
  };
  const existing = await read();
  if (existing) return replay(existing);
  const id = crypto.randomUUID();
  const insert = guard
    ? env.DB.prepare(
        `INSERT INTO liveops_admin_operation(id,actor_id,operation,operation_id,request_json,result_json,created_at) SELECT CASE WHEN (${guard.sql}) THEN ? ELSE NULL END,?,?,?,?,?,?`,
      ).bind(
        ...guard.bindings,
        id,
        actor.id,
        operation,
        operationId,
        requestJson,
        JSON.stringify(result),
        Date.now(),
      )
    : env.DB.prepare(
        "INSERT INTO liveops_admin_operation(id,actor_id,operation,operation_id,request_json,result_json,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        id,
        actor.id,
        operation,
        operationId,
        requestJson,
        JSON.stringify(result),
        Date.now(),
      );
  try {
    await env.DB.batch([insert, ...statements]);
    return result;
  } catch (error) {
    const saved = await read();
    if (saved) return replay(saved);
    if (guard) {
      const current = await env.DB.prepare(`SELECT (${guard.sql}) AS valid`)
        .bind(...guard.bindings)
        .first<{ valid: number }>();
      if (!current?.valid) throw new GameError("revision_conflict", 409);
    }
    throw error;
  }
}
export async function replayAdminMutation(
  env: Env,
  actor: AdminActor,
  operation: string,
  args: Record<string, unknown>,
): Promise<AdminResult | null> {
  const row = await env.DB.prepare(
    "SELECT request_json,result_json FROM liveops_admin_operation WHERE actor_id=? AND operation=? AND operation_id=?",
  )
    .bind(actor.id, operation, String(args.operationId ?? ""))
    .first<{ request_json: string; result_json: string }>();
  if (!row) return null;
  const requestJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  if (row.request_json !== requestJson)
    throw new GameError("operation_conflict", 409);
  return JSON.parse(row.result_json);
}
export function expectedRevision(args: Record<string, unknown>): number {
  if (
    !Number.isSafeInteger(args.expectedRevision) ||
    Number(args.expectedRevision) < 1
  )
    throw new GameError("invalid_expected_revision");
  return Number(args.expectedRevision);
}

function grantView(row: Record<string, unknown>): GrantReceipt {
  return {
    id: String(row.id),
    playerId: String(row.player_id),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    rewards: JSON.parse(String(row.rewards_json)),
    createdAt: Number(row.created_at),
  };
}
export function createGrantsApp() {
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
  app.get("/", async (c) => {
    const p = page(c.req.query());
    const rows = await c.env.DB.prepare(
      "SELECT g.*,a.acknowledged_at FROM liveops_grant g LEFT JOIN liveops_grant_ack a ON a.grant_id=g.id WHERE g.player_id=? AND (g.created_at<? OR (g.created_at=? AND g.id<?)) ORDER BY g.created_at DESC,g.id DESC LIMIT ?",
    )
      .bind(
        c.get("player").playerId,
        p.before,
        p.before,
        p.beforeId,
        p.limit + 1,
      )
      .all<Record<string, unknown>>();
    return c.json({
      grants: rows.results.slice(0, p.limit).map((row) => ({
        ...grantView(row),
        acknowledgedAt: row.acknowledged_at ?? null,
      })),
      nextBefore: nextPage(rows.results, p.limit),
    });
  });
  app.get("/:id", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT g.*,a.acknowledged_at FROM liveops_grant g LEFT JOIN liveops_grant_ack a ON a.grant_id=g.id WHERE g.id=? AND g.player_id=?",
    )
      .bind(c.req.param("id"), c.get("player").playerId)
      .first<Record<string, unknown>>();
    return row
      ? c.json({
          grant: grantView(row),
          acknowledgedAt: row.acknowledged_at ?? null,
        })
      : c.json({ error: "grant_not_found" }, 404);
  });
  app.post("/:id/ack", async (c) => {
    const id = text(c.req.param("id"), "grant_id", 128),
      owner = c.get("player").playerId;
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO liveops_grant_ack(grant_id,player_id,acknowledged_at) SELECT id,player_id,? FROM liveops_grant WHERE id=? AND player_id=?",
    )
      .bind(Date.now(), id, owner)
      .run();
    const row = await c.env.DB.prepare(
      "SELECT acknowledged_at FROM liveops_grant_ack WHERE grant_id=? AND player_id=?",
    )
      .bind(id, owner)
      .first<{ acknowledged_at: number }>();
    return row
      ? c.json({ grantId: id, acknowledgedAt: row.acknowledged_at })
      : c.json({ error: "grant_not_found" }, 404);
  });
  return app;
}
