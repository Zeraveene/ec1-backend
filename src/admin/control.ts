import { legacyEditor, legacySaveEdit } from './legacy-edit';
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env";
import { AdminActionError, requireWriter, type AdminActor } from "./action-types";
import { identityRead, identityPreviewMove, identityMove, identityUnlink, identityResetPassword, identitySetEmail } from "./identities";
import { auditLegacyRead } from './legacy-playfab';
import { readWorkspace, type Operation } from "./workspace-read";
import { revisionList, revisionGet, revisionPreviewRestore, revisionRestore } from "./revisions";

type ControlEnv = { Bindings: Env; Variables: { adminActor: AdminActor } };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.origin !== value || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

// The path route belongs to EC1, even when the browser is on the EC2 dashboard.
// Only the existing central session introspection endpoint is called. No token
// signer, player credential, caller-selected URL or actor header is accepted.
export function createClassicAdminControl() {
  const app = new Hono<ControlEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = configuredOrigin(c.env.CLASSIC_ADMIN_ORIGIN);
    if (!origin || !c.env.EC2_ADMIN_SESSION) return c.json({ error: "classic_admin_not_configured" }, 503);
    if (new URL(c.req.url).origin !== origin) return c.json({ error: "invalid_admin_origin" }, 403);
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (c.req.header("Origin") !== origin) return c.json({ error: "invalid_origin" }, 403);
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? ""))
        return c.json({ error: "json_required" }, 415);
    }
    const cookie = c.req.header("Cookie")?.match(/(?:^|;\s*)ec2mod_session=([^;]+)/)?.[1];
    if (!cookie || cookie.length > 8192) return c.json({ error: "unauthenticated" }, 401);
    try {
      const response = await c.env.EC2_ADMIN_SESSION.fetch(new Request(`${origin}/api/me`, {
        headers: { Cookie: `ec2mod_session=${cookie}`, Accept: "application/json" },
        redirect: "manual", signal: AbortSignal.timeout(10000),
      }));
      if (response.status === 401 || response.status === 403) return c.json({ error: "unauthenticated" }, 401);
      if (response.status !== 200 || !response.headers.get("Content-Type")?.includes("application/json"))
        return c.json({ error: "admin_authority_unavailable" }, 503);
      const text = await response.text();
      if (text.length > 16384) return c.json({ error: "admin_authority_unavailable" }, 503);
      const me: unknown = JSON.parse(text);
      if (!object(me) || typeof me.discordId !== "string" || !/^\d{17,20}$/.test(me.discordId) ||
          !["internal", "manager", "guest"].includes(String(me.role)) || typeof me.username !== "string")
        return c.json({ error: "admin_authority_unavailable" }, 503);
      const name = typeof me.globalName === "string" && me.globalName ? me.globalName : me.username;
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))
        return c.json({ error: "admin_authority_unavailable" }, 503);
      c.set("adminActor", { id: me.discordId, name, role: me.role as AdminActor["role"] });
    } catch { return c.json({ error: "admin_authority_unavailable" }, 503); }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 32768, onError: c => c.json({ error: "request_too_large" }, 413) }));
  app.onError((error, c) => {
    const typed = error as { code?: unknown; status?: unknown };
    if (typeof typed.code === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(typed.code) &&
        typeof typed.status === "number" && Number.isInteger(typed.status) && typed.status >= 400 && typed.status <= 599)
      return c.json({ error: typed.code }, typed.status as ContentfulStatusCode);
    return c.json({ error: "classic_admin_service_unavailable" }, 503);
  });
  const body = async (c: Context<ControlEnv>): Promise<Record<string, unknown>> => {
    requireWriter(c.get("adminActor"));
    try { const input: unknown = await c.req.json(); if (object(input)) return input; }
    catch { /* Typed failure, never an exception body. */ }
    throw new AdminActionError("invalid_request");
  };
  // Session middleware above revalidates current central membership for every read.
  // Reuse projections, not the RPC entrypoint's separately required getRole binding.
  const read = async (c: Context<ControlEnv>, operation: Operation, args: Record<string, unknown> = {}) => {
    if (operation === 'legacy-search' || operation === 'legacy-player') await auditLegacyRead(c.env, c.get('adminActor'), operation, args);
    const result = await readWorkspace(c.env, operation, args);
    return c.json(result.body, result.status as ContentfulStatusCode);
  };
  app.get("/legacy/:id/editor", async c => c.json(await legacyEditor(c.env,c.get("adminActor"),{id:c.req.param("id")})));
  app.post("/legacy/:id/revisions", async c => { const b=await body(c);return c.json(await legacySaveEdit(c.env,c.get("adminActor"),{...b,id:c.req.param("id")})); });
  app.get("/legacy", c => read(c, "legacy-search", { query: c.req.query("query") }));
  app.get("/legacy/:id", c => read(c, "legacy-player", { id: c.req.param("id") }));
  app.get("/status", c => read(c, "status"));
  app.get("/players", c => read(c, "players", { query: c.req.query("query"), cursor: c.req.query("cursor") }));
  app.get("/players/:id", c => read(c, "player", { id: c.req.param("id") }));
  app.get("/audit", c => read(c, "audit", { cursor: c.req.query("cursor") }));
  app.get("/capabilities", c => c.json({ game: "ec1", role: c.get("adminActor").role,
    canWrite: c.get("adminActor").role === "internal", features: { identities: true, revisions: true, canonicalRevisions: true } }));
  app.get("/players/:id/identities", async c => c.json(await identityRead(c.env, c.get("adminActor"), { id: c.req.param("id") })));
  app.post("/players/:id/identities/:provider/move/preview", async c => {
    const b = await body(c);
    return c.json(await identityPreviewMove(c.env, c.get("adminActor"), { id: c.req.param("id"), provider: c.req.param("provider"), sourceId: b.sourceId }));
  });
  app.post("/players/:id/identities/:provider/move", async c => {
    const b = await body(c);
    return c.json(await identityMove(c.env, c.get("adminActor"), { id: c.req.param("id"), provider: c.req.param("provider"), sourceId: b.sourceId, reviewSha256: b.reviewSha256, operationId: b.operationId }));
  });
  app.post("/players/:id/identities/:provider/unlink", async c => {
    const b = await body(c);
    return c.json(await identityUnlink(c.env, c.get("adminActor"), { id: c.req.param("id"), provider: c.req.param("provider"), expectedSubject: b.expectedSubject, operationId: b.operationId }));
  });
  app.post("/players/:id/identities/password/reset", async c => {
    const b = await body(c);
    return c.json(await identityResetPassword(c.env, c.get("adminActor"), { id: c.req.param("id"), password: b.password, expectedSubject: b.expectedSubject, operationId: b.operationId }));
  });
  app.post("/players/:id/identities/password/email", async c => {
    const b = await body(c);
    return c.json(await identitySetEmail(c.env, c.get("adminActor"), { id: c.req.param("id"), email: b.email, password: b.password, expectedSubject: b.expectedSubject, operationId: b.operationId }));
  });
  app.get("/players/:id/revisions", async c => c.json(await revisionList(c.env, c.get("adminActor"), { id: c.req.param("id"), cursor: c.req.query("cursor"), format: c.req.query("format") })));
  app.get("/players/:id/revisions/:version", async c => c.json(await revisionGet(c.env, c.get("adminActor"), { id: c.req.param("id"), version: Number(c.req.param("version")), format: c.req.query("format") })));
  app.post("/players/:id/revisions/:version/preview", async c => {
    await body(c);
    return c.json(await revisionPreviewRestore(c.env, c.get("adminActor"), { id: c.req.param("id"), version: Number(c.req.param("version")), format: c.req.query("format") }));
  });
  app.post("/players/:id/revisions/:version/restore", async c => {
    const b = await body(c);
    return c.json(await revisionRestore(c.env, c.get("adminActor"), { id: c.req.param("id"), version: Number(c.req.param("version")), format: c.req.query("format"), expectedSaveVersion: b.expectedSaveVersion, reviewSha256: b.reviewSha256, operationId: b.operationId }));
  });
  app.all("*", c => c.json({ error: "not_found" }, 404));
  return app;
}
