import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
let mf,
  db,
  adminCookie,
  guest,
  providerUser = "111111111111111111",
  requests = [];
const origin = "https://ec1.local",
  secret = "synthetic-admin-secret-at-least-thirty-two-chars";
const cookie = (response, name) =>
  response.headers
    .get("set-cookie")
    ?.match(new RegExp(`${name}=([^;, ]+)`))?.[1];
async function signed(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url"),
    key = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  return `${body}.${Buffer.from(await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("base64url")}`;
}
before(async () => {
  const contents = `import {Hono} from 'hono';import {createAuthApp} from './src/auth';import {createAdminApp,createAdminAuthApp,cleanupAdminState} from './src/admin';import {publishSnapshot} from './src/game';import {nativeKeys} from './src/game/validation';const app=new Hono();app.route('/api/auth',createAuthApp());app.route('/auth',createAdminAuthApp());app.route('/api/admin',createAdminApp());app.post('/test/cleanup',async c=>c.json(await cleanupAdminState(c.env,2)));app.post('/test/publish',async c=>{const b=await c.req.json(),prefs=Object.fromEntries(nativeKeys.map(k=>[k,'0'])),attributes=JSON.stringify({level:1,exp:0,s_top:'',s_glove:'',s_shoes:'',s_weapon:''});Object.assign(prefs,{alaster_attributes:attributes,edna_attributes:attributes,louisa_attributes:'',soul_attributes:'',gamedata:JSON.stringify({gold:0,ruby:0,stageProgress:b.progress,tutorialProgress:0,timeCounter:b.time,usedCoupons:[],stageInfo:[]}),inventory:'^^',consumable:'',LastRewardTime:'',selected:'alaster',achievements_new:Array(27).fill('0').join('|'),lbId:'',lbName:''});return c.json(await publishSnapshot(c.env,b.playerId,{game:'ec1',schemaVersion:1,playtime:b.time,data:{CLOUD_ALL_DATA:JSON.stringify(prefs),Playtime:String(b.time)},expectedSaveVersion:b.version,operationId:b.operationId,intent:'new_game'}));});app.onError((e,c)=>c.json({error:e.code||'error'},e.status||503));export default {fetch(request,env,ctx){return app.fetch(request,{...env,ADMIN_AUTHORITY:{async getConfiguration(){return {configured:true,clientId:"333333333333333333"};},async exchangeIdentity(code,redirectUri){const token=await fetch("https://discord.com/api/oauth2/token",{method:"POST",body:new URLSearchParams({client_id:"333333333333333333",redirect_uri:redirectUri,code})});const identity=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:"Bearer "+(await token.json()).access_token}});return identity.json();},async isAllowed(id){const control=await env.DB.prepare("SELECT value FROM test_authority_control").first();if(control.value==="unavailable")throw new Error("synthetic failure");if(control.value==="malformed")return "true";return !!(await env.DB.prepare("SELECT id FROM test_admin_authority WHERE id=?").bind(id).first());}}},ctx);}};`;
  const result = await build({
    stdin: { contents, resolveDir: process.cwd() },
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      d1Databases: { DB: "admin-test" },
      r2Buckets: ["PLAYER_SAVES", "AUDIT_BLOBS", "LEGACY_ARCHIVE"],
      bindings: {
        PLAYER_TOKEN_SECRET:
          "synthetic-player-signing-secret-at-least-32-chars",
        ALLOW_NEW_ACCOUNTS: "true",
        ADMIN_SESSION_SECRET: secret,
        // Stale local allowlist must never override live remote removal/outage.
        ADMIN_DISCORD_IDS: "111111111111111111",
        DISCORD_ADMIN_REDIRECT_URI: `${origin}/auth/discord/callback`,
      },
      outboundService: async (request) => {
        requests.push(request.url);
        if (request.url === "https://discord.com/api/oauth2/token") {
          const form = new URLSearchParams(await request.text());
          assert.equal(form.get("client_id"), "333333333333333333");
          assert.equal(
            form.get("redirect_uri"),
            `${origin}/auth/discord/callback`,
          );
          return new Response(
            JSON.stringify({ access_token: "synthetic-admin-provider-token" }),
          );
        }
        if (request.url === "https://discord.com/api/users/@me") {
          assert.equal(
            request.headers.get("Authorization"),
            "Bearer synthetic-admin-provider-token",
          );
          return new Response(
            JSON.stringify({
              id: providerUser,
              username: "fixture-admin",
              global_name: "Fixture Admin",
            }),
          );
        }
        throw new Error("Forbidden outbound request");
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of [
    "001_auth.sql",
    "002_game.sql",
    "030_liveops_leaderboards.sql",
    "033_structured_fortress.sql",
    "003_admin.sql",
    "021_device_credentials.sql",
  ])
    for (const statement of (await readFile(`migrations/${file}`, "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  await db.prepare("CREATE TABLE test_authority_control(value TEXT)").run();
  await db
    .prepare("INSERT INTO test_authority_control VALUES ('available')")
    .run();
  await db
    .prepare("CREATE TABLE test_admin_authority(id TEXT PRIMARY KEY)")
    .run();
  await db
    .prepare("INSERT INTO test_admin_authority VALUES ('111111111111111111')")
    .run();
  guest = await request(
    "/api/auth/guest",
    {
      bootstrapId: "admin-player-fixture",
      bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    },
    "POST",
    null,
  );
});
after(async () => await mf?.dispose());
async function request(
  route,
  body,
  method = "GET",
  session = adminCookie,
  headers = {},
) {
  const response = await mf.dispatchFetch(`${origin}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Cookie: `ec1_admin=${session}` } : {}),
      ...(!["GET", "HEAD"].includes(method) ? { Origin: origin } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...(await response.json()) };
}
async function start() {
  const response = await mf.dispatchFetch(`${origin}/auth/discord`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const state = new URL(response.headers.get("location")).searchParams.get(
    "state",
  );
  return { state, stateCookie: cookie(response, "ec1_admin_state") };
}
async function finish(pending, state = pending.state) {
  return mf.dispatchFetch(
    `${origin}/auth/discord/callback?state=${state}&code=fixture-code`,
    {
      redirect: "manual",
      headers: { Cookie: `ec1_admin_state=${pending.stateCookie}` },
    },
  );
}
test("OAuth rejects invalid state without provider calls, allowlist rejects unauthorized identity, state cannot replay", async () => {
  const pending = await start(),
    outbound = requests.length;
  const invalid = await finish(pending, "wrong-state");
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error, "invalid_oauth_state");
  assert.equal(requests.length, outbound);
  providerUser = "999999999999999999";
  const denied = await finish(pending);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "admin_not_allowed");
  assert.equal(cookie(denied, "ec1_admin"), undefined);
  const replay = await finish(pending);
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error, "invalid_oauth_state");
  providerUser = "111111111111111111";
  const allowed = await finish(await start());
  assert.equal(allowed.status, 302);
  adminCookie = cookie(allowed, "ec1_admin");
  assert.ok(adminCookie);
  assert.match(allowed.headers.get("set-cookie"), /HttpOnly/);
  assert.match(allowed.headers.get("set-cookie"), /Secure/);
  assert.match(allowed.headers.get("set-cookie"), /SameSite=Lax/);
  assert.equal((await request("/api/admin/me")).admin.id, "111111111111111111");
});
test("admin rejects forged actor headers, EC2 purpose, wrong audience and player tokens; CSRF requires exact Origin", async () => {
  assert.equal(
    (
      await request("/api/admin/me", null, "GET", null, {
        "X-Admin-ID": "111111111111111111",
      })
    ).status,
    401,
  );
  const claims = JSON.parse(
    Buffer.from(adminCookie.split(".")[0], "base64url"),
  );
  for (const payload of [
    { ...claims, purpose: "ec2/admin" },
    { ...claims, aud: "https://ec2.local" },
    { ...claims, iss: "ec2-admin" },
    { ...claims, exp: 1 },
  ])
    assert.equal(
      (await request("/api/admin/me", null, "GET", await signed(payload)))
        .status,
      401,
    );
  assert.equal(
    (await request("/api/admin/me", null, "GET", guest.accessToken)).status,
    401,
  );
  for (const badOrigin of ["https://ec2.local", "null", ""])
    assert.equal(
      (
        await request(
          `/api/admin/players/${guest.playerId}/ban`,
          { reason: "synthetic" },
          "POST",
          adminCookie,
          { Origin: badOrigin },
        )
      ).error,
      "invalid_origin",
    );
  assert.equal(
    await db
      .prepare("SELECT * FROM player_ban WHERE player_id=?")
      .bind(guest.playerId)
      .first(),
    null,
  );
});
test("mail concurrent/lost-response retries create one audited message and reject changed operation payload", async () => {
  const input = {
    operationId: "mail-operation-fixture",
    title: "Synthetic mail",
    body: "A fixture",
    rewards: [{ id: "gold", amount: 10 }],
  };
  const responses = await Promise.all([
    request(`/api/admin/players/${guest.playerId}/mail`, input, "POST"),
    request(`/api/admin/players/${guest.playerId}/mail`, input, "POST"),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  assert.equal(
    (await request(`/api/admin/players/${guest.playerId}/mail`, input, "POST"))
      .replayed,
    true,
  );
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/mail`,
        { ...input, body: "changed" },
        "POST",
      )
    ).error,
    "operation_conflict",
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM mail WHERE id='mail-operation-fixture'",
        )
        .first()
    ).n,
    1,
  );
  const audits = (
    await db.prepare("SELECT * FROM admin_audit WHERE action='mail.send'").all()
  ).results;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, "111111111111111111");
  assert.equal(audits[0].player_id, guest.playerId);
});
test("ban writes and config edits roll back if audit cannot commit", async () => {
  await db
    .prepare(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(FAIL,'synthetic audit outage'); END",
    )
    .run();
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/ban`,
        { reason: "fixture" },
        "POST",
      )
    ).status,
    503,
  );
  assert.equal(
    await db
      .prepare("SELECT * FROM player_ban WHERE player_id=?")
      .bind(guest.playerId)
      .first(),
    null,
  );
  assert.equal(
    (
      await request(
        "/api/admin/config/daily",
        { rewards: [[{ id: "gold", amount: 5 }]] },
        "PUT",
      )
    ).status,
    503,
  );
  assert.equal(
    await db
      .prepare("SELECT * FROM game_config WHERE key='daily_rewards'")
      .first(),
    null,
  );
  await db.prepare("DROP TRIGGER fail_audit").run();
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/ban`,
        { reason: "fixture" },
        "POST",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT reason FROM player_ban WHERE player_id=?")
        .bind(guest.playerId)
        .first()
    ).reason,
    "fixture",
  );
  const audit = await db
    .prepare("SELECT * FROM admin_audit WHERE action='ban.update'")
    .first();
  assert.equal(audit.actor_id, "111111111111111111");
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/ban`,
        { revoked: true },
        "POST",
      )
    ).status,
    200,
  );
});
test("restore publishes a new immutable revision and audit once, preserving originals and retry semantics", async () => {
  assert.equal(
    (
      await request(
        "/test/publish",
        {
          playerId: guest.playerId,
          version: 0,
          operationId: "admin-first-save",
          progress: 1,
          time: 10,
        },
        "POST",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/test/publish",
        {
          playerId: guest.playerId,
          version: 1,
          operationId: "admin-second-save",
          progress: 5,
          time: 50,
        },
        "POST",
      )
    ).status,
    200,
  );
  const original = await db
    .prepare("SELECT * FROM save_revision WHERE player_id=? AND version=1")
    .bind(guest.playerId)
    .first();
  const restore = {
    version: 1,
    expectedSaveVersion: 2,
    operationId: "restore-operation-fixture",
  };
  const first = await request(
    `/api/admin/players/${guest.playerId}/restore`,
    restore,
    "POST",
  );
  assert.equal(first.status, 200);
  assert.equal(first.saveVersion, 3);
  assert.equal(first.playtime, 10);
  const retry = await request(
    `/api/admin/players/${guest.playerId}/restore`,
    restore,
    "POST",
  );
  assert.equal(retry.saveVersion, 3);
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM save_revision WHERE player_id=? AND version=1")
      .bind(guest.playerId)
      .first(),
    original,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM admin_audit WHERE action='save.restore'",
        )
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/restore`,
        { ...restore, operationId: "stale-restore-fixture" },
        "POST",
      )
    ).error,
    "save_conflict",
  );
  await db
    .prepare(
      "CREATE TRIGGER fail_restore_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(FAIL,'synthetic audit outage'); END",
    )
    .run();
  assert.equal(
    (
      await request(
        `/api/admin/players/${guest.playerId}/restore`,
        {
          version: 2,
          expectedSaveVersion: 3,
          operationId: "failed-restore-fixture",
        },
        "POST",
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT save_version FROM player WHERE id=?")
        .bind(guest.playerId)
        .first()
    ).save_version,
    3,
  );
  await db.prepare("DROP TRIGGER fail_restore_audit").run();
});
test("shared whitelist removal immediately denies existing sessions; outages fail closed without local fallback", async () => {
  await db.prepare("DELETE FROM test_admin_authority").run();
  assert.equal((await request("/api/admin/me")).status, 401);
  assert.equal(
    (
      await request(
        "/api/admin/players/" + guest.playerId + "/ban",
        { reason: "denied" },
        "POST",
      )
    ).status,
    401,
  );
  const denied = await finish(await start());
  assert.equal(denied.status, 403);
  assert.equal(cookie(denied, "ec1_admin"), undefined);
  await db
    .prepare("INSERT INTO test_admin_authority VALUES ('111111111111111111')")
    .run();
  for (const value of ["unavailable", "malformed"]) {
    await db
      .prepare("UPDATE test_authority_control SET value=?")
      .bind(value)
      .run();
    assert.equal((await request("/api/admin/me")).status, 503);
    const callback = await finish(await start());
    assert.equal(callback.status, 503);
    assert.equal((await callback.json()).error, "admin_authority_unavailable");
    assert.equal(cookie(callback, "ec1_admin"), undefined);
  }
  await db.prepare("UPDATE test_authority_control SET value='available'").run();
  assert.equal((await request("/api/admin/me")).admin.id, "111111111111111111");
});

test("expired OAuth state fails, cleanup is bounded, and logout revokes stolen session cookie", async () => {
  const pending = await start();
  await db
    .prepare("UPDATE admin_oauth_state SET expires_at=1 WHERE id=?")
    .bind(pending.state)
    .run();
  assert.equal((await finish(pending)).status, 403);
  for (let i = 0; i < 5; i++)
    await db
      .prepare(
        "INSERT INTO admin_session(id,actor_id,expires_at) VALUES(?,?,1)",
      )
      .bind(`expired-admin-${i}`, "111111111111111111")
      .run();
  await request("/test/cleanup", {}, "POST");
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM admin_session WHERE expires_at=1")
        .first()
    ).n,
    3,
  );
  const copiedCookie = adminCookie;
  assert.equal((await request("/api/admin/logout", {}, "POST")).status, 200);
  assert.equal(
    (await request("/api/admin/me", null, "GET", copiedCookie)).status,
    401,
  );
  assert.ok(
    requests.every((url) => url.startsWith("https://discord.com/api/")),
  );
});
