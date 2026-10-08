import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
let mf,
  db,
  temp,
  jwk,
  key,
  requests = [],
  providerUnavailable = false,
  legacyMismatch = false;
const secret = "local-synthetic-player-secret-at-least-32-characters";
const b64 = (v) =>
  Buffer.from(
    typeof v === "string" || ArrayBuffer.isView(v) ? v : JSON.stringify(v),
  ).toString("base64url");
async function token(claims) {
  const header = b64({ alg: "RS256", kid: "fixture" }),
    body = b64(claims),
    signature = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(`${header}.${body}`),
    );
  return `${header}.${body}.${b64(new Uint8Array(signature))}`;
}
before(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "ec1-auth-"));
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  key = pair.privateKey;
  jwk = {
    ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "fixture",
    alg: "RS256",
  };
  const bundled = await build({
    stdin: {
      contents: `import {Hono} from 'hono';import {createAuthApp,requirePlayer,mintMigrationSession,cleanupAuthState} from './src/auth/index';const app=new Hono();app.use('/api/auth/*',async(c,next)=>{c.env.ALLOW_NEW_ACCOUNTS=c.req.header('X-Test-Disable-Creation')==='true'?'false':'true';await next();});app.use('/api/auth/*',async(c,next)=>{const target=c.req.header('X-Test-Reset-Bootstrap');if(!target){await next();return;}const original=c.env.DB;let batches=0;c.env.DB={prepare:(...args)=>original.prepare(...args),batch:async statements=>{if(batches++===1){await original.prepare('DELETE FROM auth_bootstrap WHERE id=?').bind(target).run();}return original.batch(statements);}};try{await next();}finally{c.env.DB=original;}});app.route('/api/auth',createAuthApp());app.get('/protected',requirePlayer,c=>c.json(c.get('player')));app.get('/api/game/readiness',requirePlayer,c=>c.json(c.get('player')));app.post('/test/cleanup',async c=>c.json(await cleanupAuthState(c.env,2)));app.post('/test/mint',async c=>c.json(await mintMigrationSession(c.env,(await c.req.json()).playerId,null)));app.onError((e,c)=>c.json({error:e.code||'auth_unavailable'},e.status||503));export default app;`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      d1Databases: { DB: "auth-test" },
      bindings: {
        PLAYER_TOKEN_SECRET: secret,
        ALLOW_NEW_ACCOUNTS: "true",
        LEGACY_MIGRATION_ENABLED: "true",
        PLAYFAB_TITLE_ID: "SYNTHETIC",
        GOOGLE_CLIENT_IDS: "ec1-google-fixture",
        DISCORD_GAME_CLIENT_ID: "fixture-client",
        DISCORD_GAME_CLIENT_SECRET: "synthetic-discord-secret",
        DISCORD_GAME_REDIRECT_URIS: "ec1fixture://discord",
      },
      outboundService: async (request) => {
        requests.push(request.url);
        if (providerUnavailable)
          return new Response("fixture outage", { status: 503 });
        if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
          return new Response(JSON.stringify({ keys: [jwk] }));
        if (request.url === "https://discord.com/api/oauth2/token") {
          const form = new URLSearchParams(await request.text());
          assert.equal(
            form.get("code_verifier"),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
          );
          assert.equal(form.get("redirect_uri"), "ec1fixture://discord");
          return new Response(
            JSON.stringify({ access_token: "synthetic-discord-bearer" }),
          );
        }
        if (request.url === "https://discord.com/api/users/@me") {
          assert.equal(
            request.headers.get("Authorization"),
            "Bearer synthetic-discord-bearer",
          );
          return new Response(
            JSON.stringify({ id: "discord-synthetic-subject" }),
          );
        }
        if (
          request.url.toLowerCase() ===
          "https://synthetic.playfabapi.com/client/loginwithemailaddress"
        ) {
          assert.equal((await request.json()).CreateAccount, false);
          return new Response(
            JSON.stringify({
              code: 200,
              data: {
                PlayFabId: legacyMismatch
                  ? "FFFFFFFFFFFFFFFF"
                  : "1234567890ABCDEF",
              },
            }),
          );
        }
        throw new Error("Unexpected outbound request");
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of ["001_auth.sql", "021_device_credentials.sql"])
    for (const statement of (await readFile("migrations/" + file, "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  await db
    .prepare(
      "CREATE TABLE migration_identity_proof(player_id TEXT PRIMARY KEY,google_subject TEXT,email TEXT,custom_id_hash TEXT,created_at INTEGER)",
    )
    .run();
});
after(async () => {
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
});
async function request(
  route,
  body,
  access,
  method = "POST",
  disableCreation = false,
) {
  const response = await mf.dispatchFetch(`https://ec1.local${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(disableCreation ? { "X-Test-Disable-Creation": "true" } : {}),
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...(await response.json()) };
}
const boot = (id) => ({
  bootstrapId: id,
  bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
});
const device = (id) => ({
  deviceCredentialId: `device-credential-${id}`,
  deviceSecret: `${id.padEnd(43, "X")}`,
  deviceId: `installation-${id.padEnd(16, "Z")}`,
});

test("guest creation atomically binds durable hashed device credential; expired refresh recovers same profile with creation disabled and no legacy calls", async () => {
  const proof = device("durable-guest"),
    input = { ...boot("durable-device-guest"), ...proof },
    before = requests.length;
  const race = await Promise.all([
    request("/api/auth/guest", input),
    request("/api/auth/guest", input),
  ]);
  assert.ok(race.every((r) => r.status === 200));
  assert.equal(race[0].playerId, race[1].playerId);
  const row = await db
    .prepare("SELECT * FROM auth_device_credential WHERE id=?")
    .bind(proof.deviceCredentialId)
    .first();
  assert.equal(row.player_id, race[0].playerId);
  assert.notEqual(row.secret_hash, proof.deviceSecret);
  assert.equal(row.secret_hash.length, 43);
  assert.equal(
    (
      await request("/api/auth/guest", {
        ...input,
        deviceSecret: "Z".repeat(43),
      })
    ).error,
    "bootstrap_conflict",
  );
  await db
    .prepare("UPDATE auth_session SET expires_at=1 WHERE player_id=?")
    .bind(row.player_id)
    .run();
  await db
    .prepare(
      "UPDATE auth_refresh SET expires_at=1 WHERE session_id IN(SELECT id FROM auth_session WHERE player_id=?)",
    )
    .bind(row.player_id)
    .run();
  assert.equal(
    (
      await request("/api/auth/refresh", {
        refreshToken: race[0].refreshToken,
        operationId: "expired-device-refresh",
      })
    ).error,
    "invalid_refresh",
  );
  const login = await request(
    "/api/auth/device/login",
    proof,
    null,
    "POST",
    true,
  );
  assert.equal(login.status, 200);
  assert.equal(login.playerId, row.player_id);
  assert.equal(login.saveState, "native_uninitialized");
  assert.equal(
    (await request("/protected", null, login.accessToken, "GET")).provider,
    "device",
  );
  assert.equal(
    (
      await request(
        "/api/auth/guest",
        { ...boot("disabled-native-create"), ...device("disabled-guest") },
        null,
        "POST",
        true,
      )
    ).error,
    "new_accounts_disabled",
  );
  const count = (await db.prepare("SELECT COUNT(*) n FROM player").first()).n;
  assert.equal(
    (
      await request("/api/auth/device/login", {
        ...proof,
        deviceSecret: "X".repeat(43),
      })
    ).error,
    "invalid_device_credentials",
  );
  assert.equal(
    (
      await request("/api/auth/device/login", {
        ...proof,
        deviceId: "different-installation-identity",
      })
    ).error,
    "invalid_device_credentials",
  );
  assert.equal(
    (await request("/api/auth/device/login", device("unknown-durable-guest")))
      .error,
    "device_credentials_not_found",
  );
  assert.equal(
    (
      await request("/api/auth/device/login", {
        ...proof,
        deviceSecret: "short",
      })
    ).error,
    "invalid_device_credential",
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM player").first()).n,
    count,
  );
  assert.equal(requests.length, before);
  // Credential revocation invalidates existing access and refresh, including sessions minted during recovery races.
  await db
    .prepare("UPDATE auth_device_credential SET revoked_at=? WHERE id=?")
    .bind(Math.floor(Date.now() / 1000), proof.deviceCredentialId)
    .run();
  assert.equal(
    (await request("/protected", null, login.accessToken, "GET")).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/refresh", {
        refreshToken: login.refreshToken,
        operationId: "revoked-device-refresh",
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("/api/auth/device/login", proof)).error,
    "invalid_device_credentials",
  );
});

test("device bindings never transfer between players; concurrent same-owner links retry, revoked credentials and bans cannot login", async () => {
  const a = await request("/api/auth/guest", boot("device-link-owner")),
    b = await request("/api/auth/guest", boot("device-link-other")),
    proof = device("linked-owner");
  const results = await Promise.all([
    request("/api/auth/link/device", proof, a.accessToken),
    request("/api/auth/link/device", proof, a.accessToken),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  assert.ok(results.every((r) => r.playerId === a.playerId));
  assert.equal(
    (await request("/api/auth/link/device", proof, b.accessToken)).error,
    "device_credential_conflict",
  );
  assert.equal(
    (
      await request(
        "/api/auth/link/device",
        { ...proof, deviceSecret: "Y".repeat(43) },
        a.accessToken,
      )
    ).error,
    "device_credential_conflict",
  );
  assert.equal(
    (
      await request("/api/auth/guest", {
        ...boot("device-reused-create"),
        ...proof,
      })
    ).error,
    "device_credential_conflict",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_device_credential WHERE id=?")
        .bind(proof.deviceCredentialId)
        .first()
    ).n,
    1,
  );
  const second = device("linked-second");
  assert.equal(
    (await request("/api/auth/link/device", second, a.accessToken)).playerId,
    a.playerId,
  );
  await db
    .prepare(
      "INSERT INTO player_ban(player_id,reason,created_at) VALUES(?,?,?)",
    )
    .bind(a.playerId, "Synthetic device ban", Math.floor(Date.now() / 1000))
    .run();
  assert.equal(
    (await request("/api/auth/device/login", second)).error,
    "player_banned",
  );
});

test("unknown device signin has a bounded credential attempt cap and creates no profile or source request", async () => {
  const proof = device("rate-limited-unknown"),
    count = (await db.prepare("SELECT COUNT(*) n FROM player").first()).n,
    before = requests.length;
  for (let i = 0; i < 15; i++)
    assert.equal(
      (await request("/api/auth/device/login", proof)).error,
      "device_credentials_not_found",
    );
  const limited = await request("/api/auth/device/login", proof);
  assert.equal(limited.status, 429);
  assert.equal(limited.error, "rate_limited");
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM player").first()).n,
    count,
  );
  assert.equal(requests.length, before);
});

test("public migration readiness fails closed without a session, database or legacy requests", async () => {
  const bundled = await build({
    stdin: {
      contents: `import {Hono} from 'hono';import {createAuthApp} from './src/auth/index';const app=new Hono();app.route('/api/auth',createAuthApp());export default app;`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
  });
  for (const enabled of ["false", undefined, "TRUE"]) {
    let calls = 0;
    const paused = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: "2026-10-06",
        bindings: {
          PLAYER_TOKEN_SECRET: secret,
          ...(enabled ? { LEGACY_MIGRATION_ENABLED: enabled } : {}),
        },
        outboundService: () => {
          calls++;
          throw new Error("Paused readiness must not contact legacy source");
        },
      }),
    );
    try {
      const response = await paused.dispatchFetch(
        "https://ec1.local/api/auth/migration/readiness",
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { game: "ec1", enabled: false });
      assert.equal(calls, 0);
    } finally {
      await paused.dispose();
    }
  }
  const live = await request(
    "/api/auth/migration/readiness",
    null,
    null,
    "GET",
  );
  assert.equal(live.enabled, true);
});
test("fresh guest retries resolve one canonical backend-only profile without save", async () => {
  const input = boot("guest-creation");
  const [a, b] = await Promise.all([
    request("/api/auth/guest", input),
    request("/api/auth/guest", input),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.playerId, b.playerId);
  assert.equal(a.refreshToken, b.refreshToken);
  assert.match(a.playerId, /^EC1X/);
  assert.equal(a.saveVersion, 0);
  assert.equal(a.saveState, "native_uninitialized");
  assert.equal(requests.length, 0);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM player WHERE id=?")
        .bind(a.playerId)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await request("/api/auth/guest", {
        ...input,
        bootstrapSecret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      })
    ).error,
    "bootstrap_conflict",
  );
});

test("expired creation bootstrap cannot recreate cleaned sessions or refresh proof; first-create reset race cannot publish a session", async () => {
  const input = boot("expired-bootstrap-acknowledgment"),
    created = await request("/api/auth/guest", input),
    before = requests.length;
  assert.equal(created.status, 200);
  await db
    .prepare("UPDATE auth_bootstrap SET created_at=? WHERE id=?")
    .bind(Math.floor(Date.now() / 1000) - 121, input.bootstrapId)
    .run();
  // Expiry blocks retries even before housekeeping removes the original session.
  assert.equal(
    (await request("/api/auth/guest", input)).error,
    "bootstrap_retry_expired",
  );
  await db
    .prepare("UPDATE auth_session SET expires_at=-1 WHERE player_id=?")
    .bind(created.playerId)
    .run();
  await db
    .prepare(
      "UPDATE auth_refresh SET expires_at=-1 WHERE session_id IN(SELECT id FROM auth_session WHERE player_id=?)",
    )
    .bind(created.playerId)
    .run();
  await request("/test/cleanup", {});
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_session WHERE player_id=?")
        .bind(created.playerId)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_bootstrap WHERE id=?")
        .bind(input.bootstrapId)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (await request("/api/auth/guest", input)).error,
    "bootstrap_retry_expired",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_session WHERE player_id=?")
        .bind(created.playerId)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_refresh WHERE hash=?")
        .bind(
          b64(
            new Uint8Array(
              await webcrypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(created.refreshToken),
              ),
            ),
          ),
        )
        .first()
    ).n,
    0,
  );

  const raced = boot("reset-before-initial-session"),
    response = await mf.dispatchFetch("https://ec1.local/api/auth/guest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Reset-Bootstrap": raced.bootstrapId,
      },
      body: JSON.stringify(raced),
    });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "bootstrap_retry_expired");
  const owner = await db
    .prepare(
      "SELECT player_id FROM auth_identity WHERE provider='guest' AND subject=?",
    )
    .bind(
      b64(
        new Uint8Array(
          await webcrypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              `${raced.bootstrapId}/${raced.bootstrapSecret}`,
            ),
          ),
        ),
      ),
    )
    .first();
  assert.ok(owner);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM auth_session WHERE player_id=?")
        .bind(owner.player_id)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (await request("/api/auth/guest", raced)).error,
    "identity_already_registered",
  );
  assert.equal(requests.length, before);
});
test("email create retries, duplicate identity races, signin and no-save readiness", async () => {
  const input = {
    ...boot("email-create"),
    email: "Example@fixture.invalid",
    password: "good-fixture-password",
  };
  const created = await request("/api/auth/register", input);
  assert.equal(created.status, 200);
  assert.equal(
    (await request("/api/auth/register", input)).playerId,
    created.playerId,
  );
  const duplicate = await request("/api/auth/register", {
    ...input,
    ...boot("different-op"),
  });
  assert.equal(duplicate.error, "identity_already_registered");
  const login = await request("/api/auth/login", {
    email: input.email,
    password: input.password,
  });
  assert.equal(login.playerId, created.playerId);
  assert.equal(
    (
      await request("/api/auth/login", {
        email: input.email,
        password: "wrong-password",
      })
    ).error,
    "invalid_credentials",
  );
  const readiness = await request(
    "/api/auth/readiness",
    null,
    login.accessToken,
    "GET",
  );
  assert.equal(readiness.saveState, "native_uninitialized");
  assert.equal(readiness.saveVersion, 0);
  assert.equal(requests.length, 0);
  const concurrent = {
    ...boot("race-a"),
    email: "race@fixture.invalid",
    password: "strong-fixture-password",
  };
  const race = await Promise.all([
    request("/api/auth/register", concurrent),
    request("/api/auth/register", { ...concurrent, ...boot("race-b") }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM auth_identity WHERE subject='race@fixture.invalid'",
        )
        .first()
    ).n,
    1,
  );
});
test("refresh rotation lost-ack retry and reuse revokes family including access token", async () => {
  const guest = await request("/api/auth/guest", boot("refresh-guest"));
  const payload = {
    refreshToken: guest.refreshToken,
    operationId: "refresh-operation",
  };
  const [a, b] = await Promise.all([
    request("/api/auth/refresh", payload),
    request("/api/auth/refresh", payload),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.refreshToken, b.refreshToken);
  assert.notEqual(a.refreshToken, guest.refreshToken);
  assert.equal(
    (
      await request("/api/auth/refresh", {
        ...payload,
        operationId: "replay-different",
      })
    ).error,
    "refresh_reuse",
  );
  assert.equal(
    (await request("/protected", null, a.accessToken, "GET")).status,
    401,
  );
  const rows = (await db.prepare("SELECT hash FROM auth_refresh").all())
    .results;
  assert.ok(
    rows.every(
      (row) => row.hash !== a.refreshToken && row.hash !== guest.refreshToken,
    ),
  );
});
test("EC2 JWT, expired JWT, and signature alteration cannot access EC1", async () => {
  const guest = await request("/api/auth/guest", boot("isolation-guest"));
  const parts = guest.accessToken.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  const hmac = async (payload) => {
    const body = b64(payload);
    const k = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return `${parts[0]}.${body}.${b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${parts[0]}.${body}`))))}`;
  };
  for (const access of [
    await hmac({ ...claims, aud: "ec2-player" }),
    await hmac({ ...claims, iss: "ec2-backend" }),
    await hmac({ ...claims, exp: 1 }),
    `${guest.accessToken}bad`,
  ])
    assert.equal(
      (await request("/protected", null, access, "GET")).status,
      401,
    );
});
test("provider proofs require issuer/audience/nonce; explicit signin never creates; missing config never falls back", async () => {
  assert.equal(
    (await request("/api/auth/provider/apple/challenge", { intent: "create" }))
      .error,
    "provider_not_configured",
  );
  const challenge = await request("/api/auth/provider/google/challenge", {
    intent: "signin",
  });
  const claims = {
    iss: "https://accounts.google.com",
    aud: "ec1-google-fixture",
    sub: "synthetic-google",
    nonce: challenge.nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const wrong = await request("/api/auth/provider/google", {
    intent: "signin",
    challengeId: challenge.challengeId,
    idToken: await token({ ...claims, aud: "ec2-google" }),
  });
  assert.equal(wrong.error, "invalid_provider_proof");
  const signin = await request("/api/auth/provider/google", {
    intent: "signin",
    challengeId: challenge.challengeId,
    idToken: await token(claims),
  });
  assert.equal(signin.error, "identity_not_registered");
  const createChallenge = await request("/api/auth/provider/google/challenge", {
    intent: "create",
  });
  const created = await request("/api/auth/provider/google", {
    intent: "create",
    challengeId: createChallenge.challengeId,
    idToken: await token({ ...claims, nonce: createChallenge.nonce }),
    ...boot("provider-new"),
  });
  assert.equal(created.status, 200);
  assert.equal(created.saveState, "native_uninitialized");
  assert.ok(
    requests.every(
      (url) => url === "https://www.googleapis.com/oauth2/v3/certs",
    ),
  );
});
test("guest email link becomes recoverable; last durable method cannot be unlinked; logout and bans enforce sessions", async () => {
  const guest = await request("/api/auth/guest", boot("linked-guest"));
  const linked = await request(
    "/api/auth/link/email",
    { email: "link@fixture.invalid", password: "linked-fixture-password" },
    guest.accessToken,
  );
  assert.equal(linked.playerId, guest.playerId);
  assert.equal(
    (
      await request(
        "/api/auth/link/email",
        { email: "link@fixture.invalid", password: "linked-fixture-password" },
        guest.accessToken,
      )
    ).refreshToken,
    linked.refreshToken,
  );
  assert.equal(
    (
      await request(
        "/api/auth/identities/email",
        null,
        linked.accessToken,
        "DELETE",
      )
    ).error,
    "last_identity_or_missing",
  );
  await db
    .prepare(
      "INSERT INTO player_ban(player_id,reason,created_at) VALUES(?,?,?)",
    )
    .bind(linked.playerId, "synthetic", Math.floor(Date.now() / 1000))
    .run();
  assert.equal(
    (await request("/protected", null, linked.accessToken, "GET")).error,
    "player_banned",
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        email: "link@fixture.invalid",
        password: "linked-fixture-password",
      })
    ).error,
    "player_banned",
  );
  await db
    .prepare("UPDATE player_ban SET revoked_at=1 WHERE player_id=?")
    .bind(linked.playerId)
    .run();
  assert.equal(
    (await request("/api/auth/logout", {}, linked.accessToken)).status,
    200,
  );
  assert.equal(
    (await request("/protected", null, linked.accessToken, "GET")).status,
    401,
  );
});
test("Discord state and PKCE proof create independent EC1 account without fallback", async () => {
  const verifier = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    challenge = Buffer.from(
      await webcrypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      ),
    ).toString("base64url");
  const pending = await request("/api/auth/provider/discord/challenge", {
    intent: "create",
    redirectUri: "ec1fixture://discord",
    codeChallenge: challenge,
  });
  assert.equal(pending.status, 200);
  assert.ok(pending.authorizeUrl.includes("code_challenge_method=S256"));
  const input = {
    intent: "create",
    challengeId: pending.challengeId,
    state: pending.state,
    code: "fixture-code",
    codeVerifier: verifier,
    redirectUri: "ec1fixture://discord",
    ...boot("discord-create"),
  };
  assert.equal(
    (
      await request("/api/auth/provider/discord", {
        ...input,
        state: "wrong-state",
      })
    ).error,
    "invalid_state_or_pkce",
  );
  const created = await request("/api/auth/provider/discord", input);
  assert.equal(created.status, 200);
  assert.equal(created.saveState, "native_uninitialized");
  const outbound = requests.length;
  const replay = await request("/api/auth/provider/discord", input);
  assert.equal(replay.refreshToken, created.refreshToken);
  assert.equal(requests.length, outbound);
  assert.equal(
    (
      await request("/api/auth/provider/discord", {
        ...input,
        bootstrapId: "changed-intent-operation",
      })
    ).error,
    "invalid_or_used_challenge",
  );
  assert.ok(requests.every((url) => !url.toLowerCase().includes("playfab")));
});
test("provider outages stay typed retryable errors and cannot create profiles", async () => {
  const pending = await request("/api/auth/provider/google/challenge", {
      intent: "create",
    }),
    seconds = Math.floor(Date.now() / 1000);
  const proof = await token({
    iss: "https://accounts.google.com",
    aud: "ec1-google-fixture",
    sub: "outage-subject",
    nonce: pending.nonce,
    iat: seconds,
    exp: seconds + 3600,
  });
  const before = (await db.prepare("SELECT count(*) n FROM player").first()).n;
  providerUnavailable = true;
  try {
    const failed = await request("/api/auth/provider/google", {
      intent: "create",
      challengeId: pending.challengeId,
      idToken: proof,
      ...boot("provider-outage"),
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.error, "provider_unavailable");
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM player").first()).n,
      before,
    );
  } finally {
    providerUnavailable = false;
  }
});
test("legacy proof helper mints restricted scope and durable linking permits native session only", async () => {
  const migration = await request("/test/mint", {
    playerId: "1234567890ABCDEF",
  });
  assert.equal(migration.status, 200);
  assert.equal(migration.playerId, "1234567890ABCDEF");
  assert.equal(migration.saveState, "migration_pending");
  assert.equal(
    (await request("/protected", null, migration.accessToken, "GET")).error,
    "insufficient_scope",
  );
  assert.equal(
    (await request("/api/game/readiness", null, migration.accessToken, "GET"))
      .scope,
    "migration",
  );
  assert.equal(
    (
      await request(
        "/api/auth/link/email",
        {
          email: "migration@fixture.invalid",
          password: "migration-fixture-password",
        },
        migration.accessToken,
      )
    ).error,
    "legacy_identity_proof_required",
  );
  await db
    .prepare(
      "INSERT INTO migration_identity_proof(player_id,created_at) VALUES(?,?)",
    )
    .bind(migration.playerId, Math.floor(Date.now() / 1000))
    .run();
  legacyMismatch = true;
  try {
    assert.equal(
      (
        await request(
          "/api/auth/link/email",
          {
            email: "migration@fixture.invalid",
            password: "migration-fixture-password",
          },
          migration.accessToken,
        )
      ).error,
      "legacy_identity_mismatch",
    );
  } finally {
    legacyMismatch = false;
  }
  const linked = await request(
    "/api/auth/link/email",
    { email: "migration@fixture.invalid", password: "old" },
    migration.accessToken,
  );
  assert.equal(linked.status, 200);
  const outbound = requests.length;
  assert.equal(
    (
      await request(
        "/api/auth/link/email",
        { email: "migration@fixture.invalid", password: "old" },
        migration.accessToken,
      )
    ).refreshToken,
    linked.refreshToken,
  );
  assert.equal(requests.length, outbound);
  assert.equal(
    (
      await request("/api/auth/login", {
        email: "migration@fixture.invalid",
        password: "old",
      })
    ).playerId,
    migration.playerId,
  );
  assert.equal(
    (
      await request(
        "/api/auth/link/email",
        { email: "migration@fixture.invalid", password: "old" },
        linked.accessToken,
      )
    ).playerId,
    migration.playerId,
  );
  assert.equal(
    (await request("/protected", null, linked.accessToken, "GET")).scope,
    "player",
  );
  assert.equal(
    (await request("/test/mint", { playerId: migration.playerId })).error,
    "native_signin_required",
  );
});
test("migration Google linking rejects unrelated proofs and binds only the source-owned subject", async () => {
  const migration = await request("/test/mint", {
    playerId: "22222222ABCDEF99",
  });
  await db
    .prepare(
      "INSERT INTO migration_identity_proof(player_id,google_subject,created_at) VALUES(?,?,?)",
    )
    .bind(
      migration.playerId,
      "legacy-google-subject",
      Math.floor(Date.now() / 1000),
    )
    .run();
  const link = async (sub) => {
    const pending = await request(
      "/api/auth/provider/google/challenge",
      { intent: "link" },
      migration.accessToken,
    );
    const seconds = Math.floor(Date.now() / 1000);
    return request(
      "/api/auth/provider/google",
      {
        intent: "link",
        challengeId: pending.challengeId,
        idToken: await token({
          iss: "https://accounts.google.com",
          aud: "ec1-google-fixture",
          sub,
          nonce: pending.nonce,
          iat: seconds,
          exp: seconds + 3600,
        }),
      },
      migration.accessToken,
    );
  };
  assert.equal(
    (await link("unrelated-google-subject")).error,
    "legacy_identity_proof_required",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM auth_identity WHERE player_id=?")
        .bind(migration.playerId)
        .first()
    ).n,
    0,
  );
  const verified = await link("legacy-google-subject");
  assert.equal(verified.status, 200);
  assert.equal(verified.playerId, migration.playerId);
  assert.equal(
    (await request("/protected", null, verified.accessToken, "GET")).scope,
    "player",
  );
});
test("guest, registration and provider challenge issuance have enforced per-IP caps", async () => {
  const outbound = requests.length;
  for (const [route, maximum] of [
    ["guest", 20],
    ["register", 10],
    ["provider/google/challenge", 30],
  ]) {
    for (let i = 0; i <= maximum; i++) {
      const input = route.endsWith("challenge")
        ? { intent: "signin" }
        : route === "register"
          ? {
              ...boot(`limited-register-${i}`),
              email: `limited-${i}@fixture.invalid`,
              password: "limited-fixture-password",
            }
          : boot(`limited-guest-${i}`);
      const response = await mf.dispatchFetch(
        `https://ec1.local/api/auth/${route}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": route,
          },
          body: JSON.stringify(input),
        },
      );
      assert.equal(response.status, i === maximum ? 429 : 200);
      if (i === maximum)
        assert.equal((await response.json()).error, "rate_limited");
    }
  }
  assert.equal(requests.length, outbound);
});
test("expired nonce fails before provider fetch, and cleanup purges only bounded expired records", async () => {
  const pending = await request("/api/auth/provider/google/challenge", {
    intent: "signin",
  });
  await db
    .prepare("UPDATE auth_challenge SET expires_at=1 WHERE id=?")
    .bind(pending.challengeId)
    .run();
  const outbound = requests.length;
  assert.equal(
    (
      await request("/api/auth/provider/google", {
        intent: "signin",
        challengeId: pending.challengeId,
        idToken: "does-not-fetch",
      })
    ).error,
    "invalid_or_used_challenge",
  );
  assert.equal(requests.length, outbound);
  for (let i = 0; i < 5; i++)
    await db
      .prepare(
        "INSERT INTO auth_rate_limit(bucket,count,expires_at) VALUES(?,1,1)",
      )
      .bind(`expired-${i}`)
      .run();
  const activeBefore = (
    await db
      .prepare("SELECT count(*) n FROM auth_rate_limit WHERE expires_at>1")
      .first()
  ).n;
  await request("/test/cleanup", {});
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM auth_rate_limit WHERE expires_at=1")
        .first()
    ).n,
    3,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM auth_rate_limit WHERE expires_at>1")
        .first()
    ).n,
    activeBefore,
  );
});
test("database outages do not masquerade as missing credentials or call PlayFab", async () => {
  const outbound = requests.length;
  await db.prepare("DROP TABLE auth_identity").run();
  const login = await request("/api/auth/login", {
    email: "known@fixture.invalid",
    password: "synthetic-password",
  });
  assert.equal(login.status, 503);
  assert.equal(login.error, "auth_unavailable");
  const create = await request("/api/auth/guest", boot("database-outage"));
  assert.equal(create.status, 503);
  assert.equal(create.error, "auth_unavailable");
  assert.equal(requests.length, outbound);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM auth_bootstrap WHERE id='database-outage'",
        )
        .first()
    ).n,
    0,
  );
});
