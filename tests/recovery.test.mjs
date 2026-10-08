import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
let mf, db, session;
const secret = "synthetic-recovery-only-signing-key-32characters";
const input = {
  bootstrapId: "recovery-new-user",
  bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
  email: "recovery@fixture.invalid",
  password: "original-password-fixture",
};
before(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import{Hono}from'hono';import{createAuthApp}from'./src/auth';import{createRecoveryApp}from'./src/recovery';const app=new Hono();app.route('/api/auth',createAuthApp());app.use('/api/recovery/*',async(c,next)=>{c.env.EMAIL={send:async message=>{const fail=await c.env.DB.prepare('SELECT fail FROM fixture_control').first();if(fail.fail)throw new Error('synthetic delivery failure');await c.env.DB.prepare('INSERT INTO fixture_message(body)VALUES(?)').bind(message.text).run();}};await next();});app.route('/api/recovery',createRecoveryApp());export default app;`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      d1Databases: { DB: "recovery" },
      bindings: {
        PLAYER_TOKEN_SECRET: secret,
        ALLOW_NEW_ACCOUNTS: "true",
        RECOVERY_ENABLED: "true",
        MAIL_FROM: "noreply@fixture.invalid",
        PASSWORD_RESET_ORIGIN: "https://ec1.fixture.invalid",
      },
      outboundService: () => {
        throw new Error("No external service allowed");
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of [
    "001_auth.sql",
    "010_recovery.sql",
    "021_device_credentials.sql",
  ])
    for (const sql of (await readFile(`migrations/${file}`, "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  await db.prepare("CREATE TABLE fixture_message(body TEXT)").run();
  await db.prepare("CREATE TABLE fixture_control(fail INTEGER)").run();
  await db.prepare("INSERT INTO fixture_control(fail)VALUES(0)").run();
  session = await req("/api/auth/register", input);
  assert.equal(session.status, 200);
});
after(async () => await mf?.dispose());
async function req(path, body, access) {
  const res = await mf.dispatchFetch(`https://ec1.fixture.invalid${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    body: JSON.stringify(body),
  });
  await res.waitUntil?.();
  return { status: res.status, ...(await res.json()) };
}
async function requestToken(email = input.email) {
  const res = await req("/api/recovery/request", { email });
  assert.equal(res.status, 202);
  const message = await db
    .prepare("SELECT body FROM fixture_message ORDER BY rowid DESC LIMIT 1")
    .first();
  return message.body.match(/#token=([A-Za-z0-9_-]+)/)[1];
}
test("unknown and known recovery requests return generic acceptance; stored tokens are hashed", async () => {
  const unknown = await req("/api/recovery/request", {
    email: "absent@fixture.invalid",
  });
  const token = await requestToken();
  assert.deepEqual(unknown, {
    status: 202,
    accepted: true,
    message: "If that EC1 email account exists, a reset link will be sent.",
  });
  const stored = await db
    .prepare("SELECT token_hash,status FROM password_recovery")
    .first();
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.status, "ready");
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM fixture_message").first()).n,
    1,
  );
});
test("password reset revokes sessions, device and bootstrap proofs; preserves player and rejects changed replay", async () => {
  const message = await db
      .prepare("SELECT body FROM fixture_message ORDER BY rowid DESC LIMIT 1")
      .first(),
    token = message.body.match(/#token=([A-Za-z0-9_-]+)/)[1],
    payload = {
      token,
      password: "changed-password-fixture",
      operationId: "reset-operation-one",
    };
  await db
    .prepare(
      "INSERT INTO auth_device_credential(id,player_id,secret_hash,device_id,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      "recovery-synthetic-device",
      session.playerId,
      "fixture-secret-hash",
      "fixture-device",
      Math.floor(Date.now() / 1000),
    )
    .run();
  const [a, b] = await Promise.all([
    req("/api/recovery/reset", payload),
    req("/api/recovery/reset", payload),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(
    (await req("/api/auth/logout", {}, session.accessToken)).status,
    401,
  );
  assert.equal(
    (
      await req("/api/auth/login", {
        email: input.email,
        password: input.password,
      })
    ).error,
    "invalid_credentials",
  );
  assert.ok(
    (
      await db
        .prepare("SELECT revoked_at FROM auth_device_credential WHERE id=?")
        .bind("recovery-synthetic-device")
        .first()
    ).revoked_at,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_bootstrap WHERE player_id=?")
        .bind(session.playerId)
        .first()
    ).n,
    0,
  );
  // Simulate later auth housekeeping: old creation proof must not resurrect a session.
  await db
    .prepare(
      "DELETE FROM auth_refresh WHERE session_id IN(SELECT id FROM auth_session WHERE player_id=?)",
    )
    .bind(session.playerId)
    .run();
  await db
    .prepare("DELETE FROM auth_session WHERE player_id=?")
    .bind(session.playerId)
    .run();
  const oldCreate = await req("/api/auth/register", input);
  assert.equal(oldCreate.status, 409);
  assert.equal(oldCreate.error, "identity_already_registered");
  const login = await req("/api/auth/login", {
    email: input.email,
    password: payload.password,
  });
  assert.equal(login.playerId, session.playerId);
  assert.equal(
    (
      await req("/api/recovery/reset", {
        ...payload,
        password: "different-password-fixture",
      })
    ).error,
    "reset_link_used",
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM recovery_event").first()).n,
    1,
  );
});
test("failed delivery and stale links cannot modify a password or reach legacy services", async () => {
  await db.prepare("UPDATE fixture_control SET fail=1").run();
  assert.equal(
    (await req("/api/recovery/request", { email: input.email })).status,
    202,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM password_recovery WHERE status='failed'",
        )
        .first()
    ).n,
    1,
  );
  await db.prepare("UPDATE fixture_control SET fail=0").run();
  const token = await requestToken();
  await db
    .prepare("UPDATE password_recovery SET expires_at=1 WHERE status='ready'")
    .run();
  assert.equal(
    (
      await req("/api/recovery/reset", {
        token,
        password: "another-password-fixture",
        operationId: "expired-reset-operation",
      })
    ).error,
    "reset_link_expired",
  );
  assert.equal(
    (
      await req("/api/auth/login", {
        email: input.email,
        password: "changed-password-fixture",
      })
    ).status,
    200,
  );
});
test("request caps cannot be bypassed by unknown identities", async () => {
  assert.equal(
    (await req("/api/recovery/request", { email: input.email })).error,
    "rate_limited",
  );
});
