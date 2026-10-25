import { Hono } from "hono";
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
function view(row: Record<string, unknown>) {
  return {
    id: row.id,
    revision: row.revision,
    playerId: row.player_id,
    title: row.title,
    subject: row.title,
    body: row.body,
    rewards: JSON.parse(String(row.rewards_json)),
    enabled: !!row.enabled,
    expiresAt: row.expires_at,
    readAt: row.read_at,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}
export async function claimMail(env: Env, playerId: string, id: string) {
  const existing = await getGrant(env, playerId, "mail", id);
  if (existing) return { grant: existing, replayed: true };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE liveops_mail SET claimed_at=?,read_at=COALESCE(read_at,?) WHERE id=? AND player_id=? AND claimed_at IS NULL AND enabled=1 AND (expires_at IS NULL OR expires_at>?)",
    ).bind(now, now, id, playerId, now),
    grantInsertFromSelect(env, {
      playerId,
      sourceType: "mail",
      sourceId: id,
      selectSql:
        "SELECT rewards_json,claimed_at AS created_at FROM liveops_mail WHERE id=? AND player_id=? AND claimed_at IS NOT NULL",
      bindings: [id, playerId],
    }),
  ]);
  const grant = await getGrant(env, playerId, "mail", id);
  if (!grant) throw new GameError("mail_unavailable", 404);
  return { grant };
}
export function createMailApp() {
  const app = new Hono<AppEnv>();
  installLiveopsErrors(app);
  app.use("*", requirePlayer);
  app.get("/", async (c) => {
    const p = page(c.req.query()),
      owner = c.get("player").playerId;
    const rows = await c.env.DB.prepare(
      "SELECT * FROM liveops_mail WHERE player_id=? AND (created_at<? OR (created_at=? AND id<?)) AND enabled=1 AND (expires_at IS NULL OR expires_at>? OR claimed_at IS NOT NULL) ORDER BY created_at DESC,id DESC LIMIT ?",
    )
      .bind(owner, p.before, p.before, p.beforeId, Date.now(), p.limit + 1)
      .all<Record<string, unknown>>();
    const values = rows.results.slice(0, p.limit);
    return c.json({
      mail: values.map(view),
      nextBefore: nextPage(rows.results, p.limit),
    });
  });
  app.get("/:id", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM liveops_mail WHERE id=? AND player_id=? AND (claimed_at IS NOT NULL OR (enabled=1 AND (expires_at IS NULL OR expires_at>?)))",
    )
      .bind(c.req.param("id"), c.get("player").playerId, Date.now())
      .first<Record<string, unknown>>();
    return row
      ? c.json({ mail: view(row) })
      : c.json({ error: "mail_not_found" }, 404);
  });
  app.post("/:id/read", async (c) => {
    const result = await c.env.DB.prepare(
      "UPDATE liveops_mail SET read_at=COALESCE(read_at,?) WHERE id=? AND player_id=? AND (claimed_at IS NOT NULL OR (enabled=1 AND (expires_at IS NULL OR expires_at>?)))",
    )
      .bind(Date.now(), c.req.param("id"), c.get("player").playerId, Date.now())
      .run();
    return result.meta.changes
      ? c.json({ read: true })
      : c.json({ error: "mail_not_found" }, 404);
  });
  app.post("/:id/claim", async (c) =>
    c.json(await claimMail(c.env, c.get("player").playerId, c.req.param("id"))),
  );
  return app;
}
export async function dispatchMailAdmin(
  env: Env,
  actor: AdminActor,
  role: AdminRole,
  operation: string,
  args: Record<string, unknown>,
): Promise<AdminResult> {
  try {
    if (!["internal", "manager", "guest"].includes(role))
      return { status: 403, body: { error: "forbidden" } };
    if (operation === "mail.history") {
      const playerId = text(args.playerId, "player_id", 128),
        p = page(args);
      const rows = await env.DB.prepare(
        "SELECT * FROM liveops_mail WHERE player_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
      )
        .bind(playerId, p.before, p.before, p.beforeId, p.limit + 1)
        .all<Record<string, unknown>>();
      const values = rows.results.slice(0, p.limit);
      return {
        status: 200,
        body: {
          mail: values.map(view),
          nextBefore: nextPage(rows.results, p.limit),
        },
      };
    }
    if (operation === "mail.detail") {
      const row = await env.DB.prepare("SELECT * FROM liveops_mail WHERE id=?")
        .bind(text(args.id, "id", 128))
        .first<Record<string, unknown>>();
      return row
        ? { status: 200, body: { mail: view(row) } }
        : { status: 404, body: { error: "mail_not_found" } };
    }
    if (role === "guest") return { status: 403, body: { error: "forbidden" } };
    const replay = await replayAdminMutation(env, actor, operation, args);
    if (replay) return replay;
    if (operation === "mail.send") {
      const playerId = text(args.playerId, "player_id", 128),
        title = text(args.title ?? args.subject, "title", 200),
        body = args.body ?? "";
      if (typeof body !== "string" || body.length > 10000)
        throw new GameError("invalid_body");
      const rewards = validateGrantRewards(args.rewards ?? [], true),
        expiresAt = timestamp(args.expiresAt),
        now = Date.now(),
        id = crypto.randomUUID();
      if (expiresAt !== null && expiresAt <= now)
        throw new GameError("invalid_expiry");
      if (
        !(await env.DB.prepare("SELECT id FROM player WHERE id=?")
          .bind(playerId)
          .first())
      )
        return { status: 404, body: { error: "player_not_found" } };
      return await commitAdminMutation(
        env,
        actor,
        operation,
        args,
        [
          env.DB.prepare(
            "INSERT INTO liveops_mail(id,player_id,title,body,rewards_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
          ).bind(
            id,
            playerId,
            title,
            body,
            JSON.stringify(rewards),
            expiresAt,
            now,
          ),
          auditStatement(env, actor, operation, playerId, {
            id,
            title,
            body,
            rewards,
            expiresAt,
          }),
        ],
        {
          status: 201,
          body: {
            mail: {
              id,
              playerId,
              title,
              body,
              rewards,
              expiresAt,
              createdAt: now,
              revision: 1,
            },
          },
        },
      );
    }
    if (operation === "mail.disable") {
      const id = text(args.id, "id", 128);
      const row = await env.DB.prepare(
        "SELECT player_id FROM liveops_mail WHERE id=?",
      )
        .bind(id)
        .first<{ player_id: string }>();
      if (!row) return { status: 404, body: { error: "mail_not_found" } };
      const revision = expectedRevision(args);
      return await commitAdminMutation(
        env,
        actor,
        operation,
        args,
        [
          env.DB.prepare(
            "UPDATE liveops_mail SET enabled=0,revision=revision+1 WHERE id=?",
          ).bind(id),
          auditStatement(env, actor, operation, row.player_id, { id }),
        ],
        { status: 200, body: { id, disabled: true, revision: revision + 1 } },
        {
          sql: "EXISTS(SELECT 1 FROM liveops_mail WHERE id=? AND revision=?)",
          bindings: [id, revision],
        },
      );
    }
    return { status: 400, body: { error: "unknown_operation" } };
  } catch (error) {
    return adminFailure(error);
  }
}
