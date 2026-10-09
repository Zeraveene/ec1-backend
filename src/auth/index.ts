import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Env } from "../env";
import {
  decode,
  hash,
  mac,
  now,
  passwordHash,
  random,
  signToken,
  verifyToken,
} from "./crypto";
import { AuthError, providerProof } from "./providers";
import { bootstrapAcknowledgementWindow, rateLimit } from "./maintenance";
import {
  activeDeviceSession,
  credentialOwner,
  deviceInsert,
  hasDeviceCredential,
  parseDeviceCredential,
  type DeviceCredential,
} from "./device";
export { cleanupAuthState } from "./maintenance";
type Body = Record<string, unknown>;
interface Session {
  id: string;
  player_id: string;
  provider: string;
  device_id: string | null;
  device_credential_id?: string | null;
  scope: "player" | "migration";
  expires_at: number;
  revoked_at: number | null;
}
const lifetime = 30 * 86400;
interface BootstrapProof {
  id: string;
  secretHash: string;
  fingerprint: string;
}
const stmt = (env: Env, sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql).bind(...values);
async function active(env: Env, id: string): Promise<void> {
  if (
    await stmt(
      env,
      "SELECT player_id FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      id,
      now(),
    ).first()
  )
    throw new AuthError("player_banned", 403);
}
export const requirePlayer = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  const claims = token
    ? await verifyToken(c.env.PLAYER_TOKEN_SECRET, token)
    : null;
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const session = await stmt(
    c.env,
    "SELECT * FROM auth_session WHERE id=?",
    claims.sid,
  ).first<Session>();
  if (
    !session ||
    session.revoked_at ||
    session.expires_at <= now() ||
    session.player_id !== claims.sub ||
    session.scope !== claims.scope ||
    session.provider !== claims.provider ||
    !(await activeDeviceSession(c.env, session))
  )
    return c.json({ error: "unauthorized" }, 401);
  await active(c.env, claims.sub);
  if (
    session.scope === "migration" &&
    !(
      /^\/api\/game\/migration(?:\/|$)/.test(c.req.path) ||
      c.req.path === "/api/game/readiness" ||
      c.req.path === "/api/auth/readiness" ||
      c.req.path === "/api/auth/logout" ||
      c.req.path === "/api/auth/link/email" ||
      c.req.path === "/api/auth/link/device" ||
      (c.req.path === "/api/auth/identities" && c.req.method === "GET")
    )
  )
    return c.json({ error: "insufficient_scope" }, 403);
  c.set("player", {
    playerId: claims.sub,
    sessionId: claims.sid,
    provider: claims.provider,
    deviceId: session.device_id,
    scope: session.scope,
  });
  await next();
});
async function result(env: Env, session: Session, refreshToken: string) {
  if (!(await activeDeviceSession(env, session)))
    throw new AuthError("invalid_device_credentials", 401);
  await active(env, session.player_id);
  const player = await stmt(
    env,
    "SELECT save_state,save_version FROM player WHERE id=?",
    session.player_id,
  ).first<{ save_state: string; save_version: number }>();
  if (!player) throw new AuthError("account_unavailable", 503);
  return {
    playerId: session.player_id,
    accessToken: await signToken(env.PLAYER_TOKEN_SECRET, {
      sub: session.player_id,
      sid: session.id,
      provider: session.provider,
      scope: session.scope,
      deviceId: session.device_id,
    }),
    refreshToken,
    expiresIn: 900,
    saveState: player.save_state,
    saveVersion: player.save_version,
  };
}
async function openSession(
  env: Env,
  playerId: string,
  provider: string,
  deviceId: string | null,
  seed?: string,
  device?: DeviceCredential,
  bootstrap?: BootstrapProof,
) {
  await active(env, playerId);
  const id = seed
    ? await mac(env.PLAYER_TOKEN_SECRET, `ec1/session/${seed}`)
    : random();
  const refresh = seed
    ? await mac(env.PLAYER_TOKEN_SECRET, `ec1/initial-refresh/${seed}`)
    : random();
  await env.DB.batch([
    device
      ? stmt(
          env,
          "INSERT INTO auth_session(id,player_id,provider,device_id,created_at,expires_at,device_credential_id) SELECT ?,?,?,?,?,?,id FROM auth_device_credential WHERE id=? AND player_id=? AND secret_hash=? AND device_id=? AND revoked_at IS NULL",
          id,
          playerId,
          provider,
          deviceId,
          now(),
          now() + lifetime,
          device.id,
          playerId,
          device.secretHash,
          device.deviceId,
        )
      : bootstrap
        ? stmt(
            env,
            "INSERT OR IGNORE INTO auth_session(id,player_id,provider,device_id,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_bootstrap WHERE id=? AND player_id=? AND secret_hash=? AND fingerprint=? AND created_at>=? AND created_at<=?)",
            id,
            playerId,
            provider,
            deviceId,
            now(),
            now() + lifetime,
            bootstrap.id,
            playerId,
            bootstrap.secretHash,
            bootstrap.fingerprint,
            now() - bootstrapAcknowledgementWindow,
            now(),
          )
        : stmt(
            env,
            "INSERT OR IGNORE INTO auth_session(id,player_id,provider,device_id,created_at,expires_at) VALUES(?,?,?,?,?,?)",
            id,
            playerId,
            provider,
            deviceId,
            now(),
            now() + lifetime,
          ),
    bootstrap
      ? stmt(
          env,
          "INSERT OR IGNORE INTO auth_refresh(hash,session_id,expires_at) SELECT ?,s.id,? FROM auth_session s WHERE s.id=? AND EXISTS(SELECT 1 FROM auth_bootstrap b WHERE b.id=? AND b.player_id=s.player_id AND b.secret_hash=? AND b.fingerprint=? AND b.created_at>=? AND b.created_at<=?)",
          await hash(refresh),
          now() + lifetime,
          id,
          bootstrap.id,
          bootstrap.secretHash,
          bootstrap.fingerprint,
          now() - bootstrapAcknowledgementWindow,
          now(),
        )
      : stmt(
          env,
          "INSERT OR IGNORE INTO auth_refresh(hash,session_id,expires_at) SELECT ?,id,? FROM auth_session WHERE id=?",
          await hash(refresh),
          now() + lifetime,
          id,
        ),
  ]);
  const session = await stmt(
    env,
    "SELECT * FROM auth_session WHERE id=?",
    id,
  ).first<Session>();
  const initial = await stmt(
    env,
    "SELECT consumed_at FROM auth_refresh WHERE hash=?",
    await hash(refresh),
  ).first<{ consumed_at: number | null }>();
  // Recheck after conditional session publication too: a password reset may consume
  // this bootstrap between the INSERT and response signing. Recovery revokes the
  // winning account's sessions and deletes its bootstraps in one D1 transaction.
  if (
    bootstrap &&
    !(await stmt(
      env,
      "SELECT 1 FROM auth_bootstrap WHERE id=? AND player_id=? AND secret_hash=? AND fingerprint=? AND created_at>=? AND created_at<=?",
      bootstrap.id,
      playerId,
      bootstrap.secretHash,
      bootstrap.fingerprint,
      now() - bootstrapAcknowledgementWindow,
      now(),
    ).first())
  )
    throw new AuthError("bootstrap_retry_expired", 409);
  if (!session && device)
    throw new AuthError("invalid_device_credentials", 401);
  if (
    !session ||
    session.revoked_at ||
    session.expires_at <= now() ||
    initial?.consumed_at
  )
    throw new AuthError("bootstrap_already_used", 409);
  return result(env, session, refresh);
}
function text(body: Body, key: string, max = 256): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max)
    throw new AuthError("invalid_request");
  return value;
}
async function body(c: {
  req: {
    json: () => Promise<unknown>;
    header: (key: string) => string | undefined;
  };
}): Promise<Body> {
  const length = Number(c.req.header("Content-Length") || 0);
  if (length > 32768) throw new AuthError("request_too_large");
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Body;
  } catch {
    throw new AuthError("invalid_request");
  }
}
function email(b: Body) {
  const value = text(b, "email", 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new AuthError("invalid_email");
  return value;
}
function password(b: Body) {
  const value = text(b, "password", 256);
  if (value.length < 10) throw new AuthError("weak_password");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Body)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function create(
  env: Env,
  b: Body,
  provider: string,
  subject: string,
  credential?: { digest: string; salt: string },
) {
  if (env.ALLOW_NEW_ACCOUNTS !== "true")
    throw new AuthError("new_accounts_disabled", 403);
  const bootstrapId = text(
      { ...b, bootstrapId: b.bootstrapId ?? b.operationId },
      "bootstrapId",
      128,
    ),
    secret = text(b, "bootstrapSecret", 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret))
    throw new AuthError("invalid_bootstrap_secret");
  const device = await parseDeviceCredential(b, true);
  const secretHash = await hash(secret),
    fingerprint = await mac(
      env.PLAYER_TOKEN_SECRET,
      JSON.stringify(
        device
          ? [
              "ec1/bootstrap-intent/v2",
              provider,
              subject,
              credential ? b.password : null,
              device.id,
              device.secretHash,
              device.deviceId,
            ]
          : [
              "ec1/bootstrap-intent/v1",
              provider,
              subject,
              credential ? b.password : null,
            ],
      ),
    );
  const existing = await stmt(
    env,
    "SELECT * FROM auth_bootstrap WHERE id=?",
    bootstrapId,
  ).first<{ secret_hash: string; fingerprint: string; player_id: string }>();
  if (existing) {
    if (
      existing.secret_hash !== secretHash ||
      existing.fingerprint !== fingerprint
    )
      throw new AuthError("bootstrap_conflict", 409);
    return openSession(
      env,
      existing.player_id,
      provider,
      typeof b.deviceId === "string" ? b.deviceId : null,
      `${bootstrapId}/${secret}`,
      undefined,
      { id: bootstrapId, secretHash, fingerprint },
    );
  }
  const id = `EC1X${(await hash(random()))
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 24)
    .toUpperCase()}`;
  try {
    await env.DB.batch([
      stmt(
        env,
        "INSERT INTO player(id,device_id,created_at,updated_at) VALUES(?,?,?,?)",
        id,
        typeof b.deviceId === "string" ? b.deviceId : null,
        now(),
        now(),
      ),
      stmt(
        env,
        "INSERT INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)",
        provider,
        subject,
        id,
        credential?.digest ?? null,
        credential?.salt ?? null,
        now(),
      ),
      stmt(
        env,
        "INSERT INTO auth_bootstrap(id,secret_hash,fingerprint,player_id,created_at) VALUES(?,?,?,?,?)",
        bootstrapId,
        secretHash,
        fingerprint,
        id,
        now(),
      ),
      ...(device ? [deviceInsert(env, id, device)] : []),
    ]);
  } catch (error) {
    const retry = await stmt(
      env,
      "SELECT * FROM auth_bootstrap WHERE id=?",
      bootstrapId,
    ).first<{ secret_hash: string; fingerprint: string; player_id: string }>();
    if (retry?.secret_hash === secretHash && retry.fingerprint === fingerprint)
      return openSession(
        env,
        retry.player_id,
        provider,
        typeof b.deviceId === "string" ? b.deviceId : null,
        `${bootstrapId}/${secret}`,
        undefined,
        { id: bootstrapId, secretHash, fingerprint },
      );
    if (retry) throw new AuthError("bootstrap_conflict", 409);
    if (
      device &&
      (await stmt(
        env,
        "SELECT 1 FROM auth_device_credential WHERE id=? OR secret_hash=?",
        device.id,
        device.secretHash,
      ).first())
    )
      throw new AuthError("device_credential_conflict", 409);
    if (
      await stmt(
        env,
        "SELECT player_id FROM auth_identity WHERE provider=? AND subject=?",
        provider,
        subject,
      ).first()
    )
      throw new AuthError("identity_already_registered", 409);
    throw error;
  }
  return openSession(
    env,
    id,
    provider,
    typeof b.deviceId === "string" ? b.deviceId : null,
    `${bootstrapId}/${secret}`,
    undefined,
    { id: bootstrapId, secretHash, fingerprint },
  );
}
export function createAuthApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    error instanceof AuthError
      ? c.json(
          {
            error: error.code,
            ...(error.status === 429 ? { retryAfterSeconds: 300 } : {}),
          },
          error.status,
        )
      : c.json({ error: "auth_unavailable" }, 503),
  );
  app.use("*", async (c, next) => {
    if (!c.env.PLAYER_TOKEN_SECRET || c.env.PLAYER_TOKEN_SECRET.length < 32)
      return c.json({ error: "auth_not_configured" }, 503);
    await next();
  });
  app.get("/migration/readiness", (c) =>
    c.json({ game: "ec1", enabled: c.env.LEGACY_MIGRATION_ENABLED === "true" }),
  );
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const route = c.req.path.replace(/^\/api\/auth/, "");
      const maximum =
        route === "/register" ||
        route === "/link/email" ||
        route === "/link/device"
          ? 10
          : route === "/guest"
            ? 20
            : route.endsWith("/challenge")
              ? 30
              : route === "/refresh"
                ? 120
                : 60;
      await rateLimit(
        c.env,
        route,
        c.req.header("CF-Connecting-IP") || "local",
        maximum,
      );
    }
    await next();
  });
  app.post("/guest", async (c) => {
    const b = await body(c);
    const id = text(
      { ...b, bootstrapId: b.bootstrapId ?? b.operationId },
      "bootstrapId",
      128,
    );
    const secret = text(b, "bootstrapSecret", 128);
    return c.json(
      await create(c.env, b, "guest", await hash(`${id}/${secret}`)),
    );
  });
  app.post("/device/login", async (c) => {
    const b = await body(c),
      credential = (await parseDeviceCredential(b))!;
    await rateLimit(c.env, "device-credential-login", credential.id, 15);
    if (
      !(await stmt(
        c.env,
        "SELECT 1 FROM auth_device_credential WHERE id=?",
        credential.id,
      ).first())
    )
      throw new AuthError("device_credentials_not_found", 404);
    const owner = await credentialOwner(c.env, credential);
    if (!owner) throw new AuthError("invalid_device_credentials", 401);
    const session = await openSession(
      c.env,
      owner,
      "device",
      credential.deviceId,
      undefined,
      credential,
    );
    await stmt(
      c.env,
      "UPDATE auth_device_credential SET last_used_at=? WHERE id=? AND revoked_at IS NULL",
      now(),
      credential.id,
    ).run();
    return c.json(session);
  });
  app.post("/link/device", requirePlayer, async (c) => {
    const b = await body(c),
      credential = (await parseDeviceCredential(b))!,
      p = c.get("player");
    if (p.scope === "migration") {
      const proof = await stmt(
        c.env,
        "SELECT custom_id_hash FROM migration_identity_proof WHERE player_id=?",
        p.playerId,
      ).first<{ custom_id_hash: string | null }>();
      const imported = await stmt(
        c.env,
        "SELECT 1 FROM migration_record m JOIN player p ON p.id=m.player_id WHERE m.player_id=? AND m.status IN ('imported_pending_auth','complete') AND p.save_version>0 AND p.save_state IN ('imported_pending_auth','migrated')",
        p.playerId,
      ).first();
      const sourceHash = p.deviceId
        ? Array.from(decode(await hash(p.deviceId)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("")
        : null;
      if (
        !sourceHash ||
        !proof?.custom_id_hash ||
        proof.custom_id_hash !== sourceHash ||
        !imported
      )
        throw new AuthError("legacy_device_proof_required", 403);
    }
    const owner = await credentialOwner(c.env, credential);
    if (owner && owner !== p.playerId)
      throw new AuthError("device_credential_conflict", 409);
    if (!owner) {
      try {
        const inserted = await deviceInsert(
          c.env,
          p.playerId,
          credential,
          p.sessionId,
        ).run();
        if (!inserted.meta.changes) throw new AuthError("unauthorized", 401);
      } catch (error) {
        if ((await credentialOwner(c.env, credential)) !== p.playerId) {
          if (
            await stmt(
              c.env,
              "SELECT 1 FROM auth_device_credential WHERE id=? OR secret_hash=?",
              credential.id,
              credential.secretHash,
            ).first()
          )
            throw new AuthError("device_credential_conflict", 409);
          throw error;
        }
      }
    }
    // Binding ownership is idempotent; each proved login may issue a fresh bounded native session.
    return c.json(
      await openSession(
        c.env,
        p.playerId,
        "device",
        credential.deviceId,
        undefined,
        credential,
      ),
    );
  });
  app.post("/register", async (c) => {
    const b = await body(c);
    const subject = email(b),
      pass = password(b),
      salt = random();
    return c.json(
      await create(c.env, b, "email", subject, {
        salt,
        digest: await passwordHash(pass, salt),
      }),
    );
  });
  app.post("/login", async (c) => {
    const b = await body(c);
    const subject = email(b),
      pass = text(b, "password", 256);
    const bucket = await hash(
      `${c.req.header("CF-Connecting-IP") || "local"}/${subject}/${Math.floor(now() / 300)}`,
    );
    await stmt(
      c.env,
      "INSERT INTO auth_rate_limit(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
      bucket,
      now() + 300,
    ).run();
    const rate = await stmt(
      c.env,
      "SELECT count FROM auth_rate_limit WHERE bucket=?",
      bucket,
    ).first<{ count: number }>();
    if ((rate?.count || 0) > 15) throw new AuthError("rate_limited", 429);
    const identity = await stmt(
      c.env,
      "SELECT player_id,password_hash,salt FROM auth_identity WHERE provider='email' AND subject=?",
      subject,
    ).first<{ player_id: string; password_hash: string; salt: string }>();
    const digest = await passwordHash(
      pass,
      identity?.salt || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    if (!identity || digest !== identity.password_hash)
      throw new AuthError("invalid_credentials", 401);
    return c.json(
      await openSession(
        c.env,
        identity.player_id,
        "email",
        typeof b.deviceId === "string" ? b.deviceId : null,
      ),
    );
  });
  app.post("/refresh", async (c) => {
    const b = await body(c),
      raw = text(b, "refreshToken", 128),
      operationId = text(b, "operationId", 128),
      oldHash = await hash(raw);
    const previous = await stmt(
      c.env,
      "SELECT * FROM auth_refresh WHERE hash=?",
      oldHash,
    ).first<{
      session_id: string;
      expires_at: number;
      consumed_at: number | null;
      operation_id: string | null;
      successor_hash: string | null;
    }>();
    if (!previous || previous.expires_at <= now())
      throw new AuthError("invalid_refresh", 401);
    const session = await stmt(
      c.env,
      "SELECT * FROM auth_session WHERE id=?",
      previous.session_id,
    ).first<Session>();
    if (!session || session.revoked_at || session.expires_at <= now())
      throw new AuthError("invalid_refresh", 401);
    await active(c.env, session.player_id);
    const successor = await mac(
        c.env.PLAYER_TOKEN_SECRET,
        JSON.stringify(["ec1/refresh/v1", session.id, raw, operationId]),
      ),
      successorHash = await hash(successor);
    if (!previous.consumed_at)
      await c.env.DB.batch([
        stmt(
          c.env,
          "UPDATE auth_refresh SET consumed_at=?,operation_id=?,successor_hash=? WHERE hash=? AND consumed_at IS NULL",
          now(),
          operationId,
          successorHash,
          oldHash,
        ),
        stmt(
          c.env,
          "INSERT OR IGNORE INTO auth_refresh(hash,session_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM auth_refresh WHERE hash=? AND operation_id=? AND successor_hash=?)",
          successorHash,
          session.id,
          previous.expires_at,
          oldHash,
          operationId,
          successorHash,
        ),
      ]);
    const winner = await stmt(
      c.env,
      "SELECT * FROM auth_refresh WHERE hash=?",
      oldHash,
    ).first<typeof previous>();
    if (
      winner?.operation_id !== operationId ||
      winner.successor_hash !== successorHash
    ) {
      await stmt(
        c.env,
        "UPDATE auth_session SET revoked_at=? WHERE id=?",
        now(),
        session.id,
      ).run();
      throw new AuthError("refresh_reuse", 401);
    }
    const next = await stmt(
      c.env,
      "SELECT consumed_at FROM auth_refresh WHERE hash=?",
      successorHash,
    ).first<{ consumed_at: number | null }>();
    if (!next || next.consumed_at || now() - (winner.consumed_at || 0) > 120)
      throw new AuthError("refresh_retry_expired", 401);
    return c.json(await result(c.env, session, successor));
  });
  app.post("/logout", requirePlayer, async (c) => {
    await stmt(
      c.env,
      "UPDATE auth_session SET revoked_at=? WHERE id=?",
      now(),
      c.get("player").sessionId,
    ).run();
    return c.json({ ok: true });
  });
  app.get("/identities", requirePlayer, async (c) =>
    c.json({
      identities: (
        await stmt(
          c.env,
          "SELECT provider,created_at FROM auth_identity WHERE player_id=?",
          c.get("player").playerId,
        ).all()
      ).results,
    }),
  );
  app.get("/readiness", requirePlayer, async (c) => {
    const p = await stmt(
      c.env,
      "SELECT save_state,save_version FROM player WHERE id=?",
      c.get("player").playerId,
    ).first<{ save_state: string; save_version: number }>();
    return c.json({
      playerId: c.get("player").playerId,
      saveState: p?.save_state,
      saveVersion: p?.save_version,
      migrationEnabled: c.env.LEGACY_MIGRATION_ENABLED === "true",
    });
  });
  app.delete("/identities/:provider", requirePlayer, async (c) => {
    if (c.get("player").scope !== "player")
      throw new AuthError("insufficient_scope", 403);
    const provider = c.req.param("provider");
    if (provider === "guest")
      throw new AuthError("guest_unlink_not_allowed", 409);
    const removed = await stmt(
      c.env,
      "DELETE FROM auth_identity WHERE player_id=? AND provider=? AND (SELECT count(*) FROM auth_identity WHERE player_id=? AND provider<>'guest')>1",
      c.get("player").playerId,
      provider,
      c.get("player").playerId,
    ).run();
    if (!removed.meta.changes)
      throw new AuthError("last_identity_or_missing", 409);
    await stmt(
      c.env,
      "UPDATE auth_session SET revoked_at=? WHERE player_id=? AND provider=?",
      now(),
      c.get("player").playerId,
      provider,
    ).run();
    return c.json({ ok: true });
  });
  wireProviders(app);
  return app;
}

async function authenticated(
  env: Env,
  authorization: string | undefined,
): Promise<Session> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1],
    claims = token ? await verifyToken(env.PLAYER_TOKEN_SECRET, token) : null;
  if (!claims) throw new AuthError("unauthorized", 401);
  const session = await stmt(
    env,
    "SELECT * FROM auth_session WHERE id=?",
    claims.sid,
  ).first<Session>();
  if (
    !session ||
    session.revoked_at ||
    session.expires_at <= now() ||
    session.player_id !== claims.sub ||
    session.scope !== claims.scope ||
    !(await activeDeviceSession(env, session))
  )
    throw new AuthError("unauthorized", 401);
  await active(env, session.player_id);
  return session;
}
function configured(env: Env, provider: string) {
  if (
    provider === "google"
      ? !env.GOOGLE_CLIENT_IDS
      : provider === "apple"
        ? !env.APPLE_CLIENT_IDS
        : provider === "discord"
          ? !env.DISCORD_GAME_CLIENT_ID ||
            !env.DISCORD_GAME_CLIENT_SECRET ||
            !env.DISCORD_GAME_REDIRECT_URIS
          : true
  )
    throw new AuthError(
      provider === "google" || provider === "apple" || provider === "discord"
        ? "provider_not_configured"
        : "unsupported_provider",
      503,
    );
}
function wireProviders(app: Hono<AppEnv>) {
  app.post("/provider/:provider/challenge", async (c) => {
    const provider = c.req.param("provider");
    configured(c.env, provider);
    const b = await body(c),
      intent = text(b, "intent");
    if (!["signin", "create", "link"].includes(intent))
      throw new AuthError("invalid_intent");
    const owner =
      intent === "link"
        ? (await authenticated(c.env, c.req.header("Authorization"))).player_id
        : null;
    const id = random(),
      nonce = random();
    let redirect: string | null = null,
      challenge: string | null = null,
      authorizeUrl: string | undefined;
    if (
      provider === "discord" ||
      (provider === "google" && b.redirectUri != null)
    ) {
      const google = provider === "google";
      if (
        google &&
        (!c.env.GOOGLE_EDITOR_CLIENT_ID ||
          !c.env.GOOGLE_EDITOR_CLIENT_SECRET ||
          !c.env.GOOGLE_CLIENT_IDS?.split(",")
            .map((s) => s.trim())
            .includes(c.env.GOOGLE_EDITOR_CLIENT_ID))
      )
        throw new AuthError("provider_not_configured", 503);
      redirect = text(b, "redirectUri", 512);
      challenge = text(b, "codeChallenge", 64);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        !(
          google
            ? c.env.GOOGLE_EDITOR_REDIRECT_URIS
            : c.env.DISCORD_GAME_REDIRECT_URIS
        )
          ?.split(",")
          .map((s) => s.trim())
          .includes(redirect)
      )
        throw new AuthError("invalid_redirect_or_pkce");
      if (google) {
        const callback = new URL(redirect);
        if (
          callback.protocol !== "http:" ||
          !["localhost", "127.0.0.1"].includes(callback.hostname) ||
          callback.username ||
          callback.password ||
          callback.search ||
          callback.hash
        )
          throw new AuthError("invalid_redirect_or_pkce");
      }
      authorizeUrl = `${google ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://discord.com/oauth2/authorize"}?${new URLSearchParams({ client_id: google ? c.env.GOOGLE_EDITOR_CLIENT_ID! : c.env.DISCORD_GAME_CLIENT_ID!, response_type: "code", scope: google ? "openid email" : "identify", redirect_uri: redirect, state: id, code_challenge: challenge, code_challenge_method: "S256", ...(google ? { nonce, prompt: "select_account" } : {}) })}`;
    }
    await stmt(
      c.env,
      "INSERT INTO auth_challenge(id,provider,nonce,intent,player_id,redirect_uri,code_challenge,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      provider,
      nonce,
      intent,
      owner,
      redirect,
      challenge,
      now() + 300,
    ).run();
    return c.json({ challengeId: id, nonce, state: id, authorizeUrl });
  });
  app.post("/provider/:provider", async (c) => {
    const provider = c.req.param("provider");
    configured(c.env, provider);
    const b = await body(c),
      challengeId = text(b, "challengeId", 128),
      intent = text(b, "intent");
    const challenge = await stmt(
      c.env,
      "SELECT * FROM auth_challenge WHERE id=?",
      challengeId,
    ).first<{
      provider: string;
      nonce: string;
      intent: string;
      player_id: string | null;
      redirect_uri: string | null;
      code_challenge: string | null;
      expires_at: number;
      used_at: number | null;
      proof_hash: string | null;
      verified_subject: string | null;
    }>();
    if (
      !challenge ||
      challenge.provider !== provider ||
      challenge.intent !== intent ||
      challenge.expires_at <= now()
    )
      throw new AuthError("invalid_or_used_challenge", 401);
    const owner =
      intent === "link"
        ? await authenticated(c.env, c.req.header("Authorization"))
        : null;
    if (intent === "link" && owner?.player_id !== challenge.player_id)
      throw new AuthError("challenge_owner_mismatch", 403);
    if (
      (provider === "discord" || challenge.redirect_uri !== null) &&
      (b.state !== challengeId ||
        b.redirectUri !== challenge.redirect_uri ||
        typeof b.codeVerifier !== "string" ||
        (await hash(b.codeVerifier)) !== challenge.code_challenge)
    )
      throw new AuthError("invalid_state_or_pkce", 401);
    if (
      provider === "google" &&
      challenge.redirect_uri !== null &&
      (typeof b.code !== "string" || !b.code || b.idToken != null)
    )
      throw new AuthError("invalid_provider_proof", 401);
    const requestHash = await mac(
      c.env.PLAYER_TOKEN_SECRET,
      canonical({
        domain: "ec1/provider-request/v1",
        body: b,
        owner: owner?.player_id ?? null,
      }),
    );
    let subject: string;
    if (challenge.used_at) {
      if (
        challenge.proof_hash !== requestHash ||
        !challenge.verified_subject ||
        now() - challenge.used_at > 120
      )
        throw new AuthError("invalid_or_used_challenge", 401);
      subject = challenge.verified_subject;
    } else {
      try {
        subject = await providerProof(c.env, provider, b, challenge.nonce);
      } catch (error) {
        if (error instanceof TypeError || error instanceof DOMException)
          throw new AuthError("provider_unavailable", 503);
        throw error;
      }
      const consumed = await stmt(
        c.env,
        "UPDATE auth_challenge SET used_at=?,proof_hash=?,verified_subject=? WHERE id=? AND used_at IS NULL",
        now(),
        requestHash,
        subject,
        challengeId,
      ).run();
      if (!consumed.meta.changes) {
        const winner = await stmt(
          c.env,
          "SELECT proof_hash,verified_subject FROM auth_challenge WHERE id=?",
          challengeId,
        ).first<{ proof_hash: string; verified_subject: string }>();
        if (
          winner?.proof_hash !== requestHash ||
          winner.verified_subject !== subject
        )
          throw new AuthError("invalid_or_used_challenge", 401);
      }
    }
    const identity = await stmt(
      c.env,
      "SELECT player_id FROM auth_identity WHERE provider=? AND subject=?",
      provider,
      subject,
    ).first<{ player_id: string }>();
    if (intent === "create")
      return c.json(await create(c.env, b, provider, subject));
    if (intent === "signin") {
      if (!identity) throw new AuthError("identity_not_registered", 404);
      return c.json(
        await openSession(
          c.env,
          identity.player_id,
          provider,
          typeof b.deviceId === "string" ? b.deviceId : null,
          `provider/${challengeId}/${requestHash}`,
        ),
      );
    }
    if (intent !== "link" || !owner) throw new AuthError("invalid_intent");
    if (owner.scope === "migration") {
      const proof = await stmt(
        c.env,
        "SELECT google_subject FROM migration_identity_proof WHERE player_id=?",
        owner.player_id,
      ).first<{ google_subject: string | null }>();
      if (
        provider !== "google" ||
        !proof?.google_subject ||
        proof.google_subject !== subject
      )
        throw new AuthError("legacy_identity_proof_required", 403);
    }
    if (identity && identity.player_id !== owner.player_id)
      throw new AuthError("identity_already_claimed", 409);
    await stmt(
      c.env,
      "INSERT OR IGNORE INTO auth_identity(provider,subject,player_id,created_at) VALUES(?,?,?,?)",
      provider,
      subject,
      owner.player_id,
      now(),
    ).run();
    const linked = await stmt(
      c.env,
      "SELECT player_id FROM auth_identity WHERE provider=? AND subject=?",
      provider,
      subject,
    ).first<{ player_id: string }>();
    if (linked?.player_id !== owner.player_id)
      throw new AuthError("identity_link_conflict", 409);
    return c.json(
      await openSession(
        c.env,
        owner.player_id,
        provider,
        owner.device_id,
        `provider/${challengeId}/${requestHash}`,
      ),
    );
  });
  app.post("/link/email", requirePlayer, async (c) => {
    const b = await body(c),
      subject = email(b),
      salt = random(),
      player = c.get("player"),
      pass = text(b, "password", 256);
    const seed = await mac(
      c.env.PLAYER_TOKEN_SECRET,
      canonical({
        domain: "ec1/email-link/v1",
        session: player.sessionId,
        subject,
        password: pass,
      }),
    );
    const resume = async () => {
      const existing = await stmt(
        c.env,
        "SELECT player_id,password_hash,salt FROM auth_identity WHERE provider='email' AND subject=?",
        subject,
      ).first<{ player_id: string; password_hash: string; salt: string }>();
      if (!existing) return false;
      if (
        existing.player_id !== player.playerId ||
        existing.password_hash !== (await passwordHash(pass, existing.salt))
      )
        throw new AuthError("identity_link_conflict", 409);
      return true;
    };
    if (!(await resume())) {
      if (player.scope !== "migration") password(b);
      if (player.scope === "migration")
        await verifyLegacyEmail(c.env, player.playerId, subject, pass);
      try {
        await stmt(
          c.env,
          "INSERT INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)",
          "email",
          subject,
          player.playerId,
          await passwordHash(pass, salt),
          salt,
          now(),
        ).run();
      } catch (error) {
        if (!(await resume())) {
          if (
            await stmt(
              c.env,
              "SELECT player_id FROM auth_identity WHERE provider='email' AND player_id=?",
              player.playerId,
            ).first()
          )
            throw new AuthError("identity_link_conflict", 409);
          throw error;
        }
      }
    }
    return c.json(
      await openSession(
        c.env,
        player.playerId,
        "email",
        player.deviceId,
        `link-email/${seed}`,
      ),
    );
  });
}

async function verifyLegacyEmail(
  env: Env,
  playerId: string,
  email: string,
  password: string,
) {
  if (!env.PLAYFAB_TITLE_ID || !/^[A-Za-z0-9]+$/.test(env.PLAYFAB_TITLE_ID))
    throw new AuthError("legacy_not_configured", 503);
  if (
    !(await stmt(
      env,
      "SELECT player_id FROM migration_identity_proof WHERE player_id=?",
      playerId,
    ).first())
  )
    throw new AuthError("legacy_identity_proof_required", 403);
  let response: Response;
  try {
    response = await fetch(
      `https://${env.PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithEmailAddress`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          TitleId: env.PLAYFAB_TITLE_ID,
          Email: email,
          Password: password,
          CreateAccount: false,
        }),
      },
    );
  } catch {
    throw new AuthError("legacy_unavailable", 503);
  }
  if (!response.ok)
    throw new AuthError(
      response.status >= 500 || response.status === 429
        ? "legacy_unavailable"
        : "invalid_legacy_credentials",
      response.status >= 500 || response.status === 429 ? 503 : 401,
    );
  let proof: { code?: number; data?: { PlayFabId?: string } };
  try {
    proof = (await response.json()) as typeof proof;
  } catch {
    throw new AuthError("legacy_unavailable", 503);
  }
  if (proof.code !== 200 || typeof proof.data?.PlayFabId !== "string")
    throw new AuthError("legacy_unavailable", 503);
  if (proof.data.PlayFabId.toUpperCase() !== playerId)
    throw new AuthError("legacy_identity_mismatch", 403);
}

/** Only call after read-only legacy ownership proof. Does not confer gameplay access. */
export async function mintMigrationSession(
  env: Env,
  verifiedLegacyPlayerId: string,
  deviceId: string | null,
) {
  if (env.LEGACY_MIGRATION_ENABLED !== "true")
    throw new AuthError("migration_disabled", 403);
  if (!/^[A-Fa-f0-9]{8,32}$/.test(verifiedLegacyPlayerId))
    throw new AuthError("invalid_legacy_id");
  const id = verifiedLegacyPlayerId.toUpperCase();
  await active(env, id);
  if (
    (await stmt(
      env,
      "SELECT player_id FROM auth_identity WHERE player_id=? AND provider<>'guest'",
      id,
    ).first()) ||
    (await hasDeviceCredential(env, id))
  )
    throw new AuthError("native_signin_required", 409);
  await stmt(
    env,
    "INSERT OR IGNORE INTO player(id,save_state,device_id,created_at,updated_at) VALUES(?,'migration_pending',?,?,?)",
    id,
    deviceId,
    now(),
    now(),
  ).run();
  const session: Session = {
    id: random(),
    player_id: id,
    provider: "legacy",
    scope: "migration",
    device_id: deviceId,
    expires_at: now() + 900,
    revoked_at: null,
  };
  const refresh = random();
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO auth_session(id,player_id,provider,device_id,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      session.id,
      id,
      "legacy",
      deviceId,
      "migration",
      now(),
      session.expires_at,
    ),
    stmt(
      env,
      "INSERT INTO auth_refresh(hash,session_id,expires_at) VALUES(?,?,?)",
      await hash(refresh),
      session.id,
      session.expires_at,
    ),
  ]);
  return result(env, session, refresh);
}
