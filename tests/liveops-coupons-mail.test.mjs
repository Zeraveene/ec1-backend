import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
let mf, db;
const actor = { id: "synthetic-admin", name: "Synthetic" },
  secret = "synthetic-test-token-key-no-network";
function token(id = "owner", scope = "player") {
  const b = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }),
    payload = b({
      iss: "ec1-backend",
      aud: "ec1-player",
      sub: id,
      sid: `session-${id}-${scope}`,
      provider: "email",
      scope,
      deviceId: null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
  return `${head}.${payload}.${createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url")}`;
}
async function request(url, body, owner = "owner") {
  const response = await mf.dispatchFetch("https://synthetic.local" + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(owner ? { Authorization: `Bearer ${token(owner)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
let seq = 0;
async function admin(operation, args = {}, role = "manager") {
  return request("/admin", {
    operation,
    args: {
      ...args,
      ...(!/\.(list|detail|history)$/.test(operation)
        ? { operationId: args.operationId ?? `operation-${++seq}` }
        : {}),
    },
    role,
  });
}
async function coupon(patch = {}) {
  const r = await admin("coupons.create", {
    code: `CODE-${++seq}`,
    title: "Synthetic coupon",
    rewards: [{ id: "gold", amount: 10 }],
    ...patch,
  });
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.body.coupon;
}
async function mail(patch = {}) {
  const r = await admin("mail.send", {
    playerId: "owner",
    title: "Synthetic mail",
    body: "Hello",
    rewards: [{ id: "ruby", amount: 2 }],
    ...patch,
  });
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.body.mail;
}
before(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import {Hono} from 'hono';import {createCouponApp,dispatchCouponAdmin} from './src/liveops/coupons';import {createMailApp,dispatchMailAdmin} from './src/liveops/mail';import {createGrantsApp} from './src/liveops/grants';const app=new Hono();app.route('/coupons',createCouponApp());app.route('/mail',createMailApp());app.route('/grants',createGrantsApp());app.post('/admin',async c=>{const b=await c.req.json();const f=b.operation.startsWith('coupons.')?dispatchCouponAdmin:dispatchMailAdmin;const r=await f(c.env,${JSON.stringify(actor)},b.role,b.operation,b.args);return c.json(r.body,r.status)});app.onError((e,c)=>c.json({error:'parent_generic_failure'},500));export default app;`,
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
      d1Databases: { DB: "isolated-liveops" },
      r2Buckets: { AUDIT_BLOBS: 'isolated-story-reports' },
      bindings: { PLAYER_TOKEN_SECRET: secret, STORY_TEST_ENABLED: 'true', STORY_TEST_PLAYERS: 'owner', STORY_TEST_COUPON: 'SYNTHETIC-STORY-RUN' },
      outboundService: () => {
        throw Error("Outbound network forbidden");
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const f of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile("migrations/" + f, "utf8"))
        .replace(/--[^\n]*/g, "")
        .replace(/\n/g, " "),
    );
  for (const id of ["owner", "other", "third"]) {
    await db
      .prepare("INSERT INTO player(id,created_at,updated_at) VALUES(?,?,?)")
      .bind(id, 1, 1)
      .run();
    for (const scope of ["player", "migration"])
      await db
        .prepare(
          "INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          `session-${id}-${scope}`,
          id,
          "email",
          scope,
          1,
          Math.floor(Date.now() / 1000) + 10000,
        )
        .run();
  }
});
after(async () => await mf?.dispose());

test('developer story coupon starts only for targeted player and never becomes a grant', async () => {
  const check = await request('/coupons/check', { code: ' synthetic-story-run ' });
  assert.equal(check.status, 200); assert.equal(check.body.diagnostic, 'full-story');
  assert.equal(check.body.grant, undefined);
  assert.equal((await request('/coupons/check', { code: 'SYNTHETIC-STORY-RUN' }, 'other')).status, 404);
  assert.equal((await request('/coupons/story-test/start', { code: 'SYNTHETIC-STORY-RUN' }, 'other')).status, 404);
  assert.equal((await request('/coupons/story-test/start', { code: 'SYNTHETIC-STORY-RUN' }, null)).status, 401);
  const started = await request('/coupons/story-test/start', { code: 'SYNTHETIC-STORY-RUN' });
  assert.equal(started.status, 200); assert.equal(started.body.playerId, 'owner');
  const saved = await request('/coupons/story-test/report', { runId: started.body.runId, report: { passed: false, errors: ['x'.repeat(8000)] } });
  assert.equal(saved.status, 200);
  const bucket = await mf.getR2Bucket('AUDIT_BLOBS');
  assert.ok(await bucket.get(`story-tests/owner/${started.body.runId}/result.json`));
  const grants = await db.prepare("SELECT COUNT(*) n FROM liveops_grant WHERE player_id='owner'").first();
  assert.equal(grants.n, 0);
  const unauthorizedReport = await request('/coupons/story-test/report', { runId: started.body.runId, report: {} }, 'other');
  assert.equal(unauthorizedReport.status, 404);
});
test("permanent unlock mail supports mixed rewards and immutable replay without a backup", async () => {
  const ids = ['louisaUnlock', 'soulUnlock', 'premium', 'more_exp', 'double_loot', 'booster_pack',
    ...['alaster', 'edna', 'louisa', 'soul'].flatMap(h => Array.from({ length: 8 }, (_, i) => `costume_${h}_${i + 1}`))];
  const m = await mail({ rewards: [...ids.map(id => ({ id, amount: 1 })), { id: 'ruby', amount: 5 }] });
  const claimed = await request(`/mail/${m.id}/claim`, {});
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.body.grant.rewards.map(r => r.id), [...ids, 'ruby']);
  assert.ok(claimed.body.grant.rewards.filter(r => ids.slice(0, 6).includes(r.id)).every(r => r.name && r.itemCategory === undefined));
  assert.deepEqual((await request(`/mail/${m.id}/claim`, {})).body.grant, claimed.body.grant);
  assert.equal((await request(`/grants/${claimed.body.grant.id}/ack`, {})).status, 200);
  assert.equal((await db.prepare("SELECT save_version FROM player WHERE id='owner'").first()).save_version, 0);
  for (const id of ids) {
    const bad = await admin('mail.send', { playerId: 'owner', title: 'Invalid amount', rewards: [{ id, amount: 2 }] });
    assert.equal(bad.body.error, 'invalid_rewards', id);
  }
  for (const id of ['dualTaken', 'stepUp1', 'setPref', '__proto__', 'costume_soul_9']) {
    assert.equal((await admin('mail.send', { playerId: 'owner', title: 'Unsupported', rewards: [{ id, amount: 1 }] })).status, 422);
  }
});
test("player auth, migration scope, no public coupon list or target list", async () => {
  assert.equal(
    (await request("/coupons/check", { code: "ANY" }, null)).status,
    401,
  );
  const response = await mf.dispatchFetch(
    "https://synthetic.local/coupons/check",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token("owner", "migration")}`,
        "Content-Type": "application/json",
      },
      body: '{"code":"ANY"}',
    },
  );
  assert.equal(response.status, 403);
  assert.equal(
    (
      await mf.dispatchFetch("https://synthetic.local/coupons", {
        headers: { Authorization: `Bearer ${token()}` },
      })
    ).status,
    404,
  );
  const c = await coupon({ playerIds: ["owner"] });
  const check = await request("/coupons/check", { code: c.code.toLowerCase() });
  assert.equal(check.body.eligible, true);
  assert.equal(JSON.stringify(check.body).includes("playerIds"), false);
  assert.equal(
    (await request("/coupons/check", { code: c.code }, "other")).status,
    409,
  );
  assert.equal(
    (await request("/coupons/claim", { code: c.code }, "other")).status,
    409,
  );
});
test("concurrent coupon cap, replay after disable/expiry and immutable receipts", async () => {
  const c = await coupon({ maxClaims: 1 });
  const claims = await Promise.all(
    ["owner", "other", "third"].map((owner) =>
      request("/coupons/claim", { code: c.code }, owner),
    ),
  );
  assert.equal(claims.filter((x) => x.status === 200).length, 1);
  const winner = ["owner", "other", "third"][
      claims.findIndex((x) => x.status === 200)
    ],
    receipt = claims.find((x) => x.status === 200).body.grant;
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM liveops_coupon_claim WHERE coupon_id=?",
        )
        .bind(c.id)
        .first()
    ).n,
    1,
  );
  await admin("coupons.disable", { id: c.id, expectedRevision: 1 });
  await db
    .prepare("UPDATE liveops_coupon SET expires_at=1,rewards_json=? WHERE id=?")
    .bind('[{"id":"gold","amount":999}]', c.id)
    .run();
  const replay = await request("/coupons/claim", { code: c.code }, winner);
  assert.deepEqual(replay.body.grant, receipt);
  await assert.rejects(
    db
      .prepare("UPDATE liveops_grant SET rewards_json=? WHERE id=?")
      .bind("[]", receipt.id)
      .run(),
    /immutable_grant/,
  );
});
test("coupon dates, reward validation, admin revision and request retry", async () => {
  for (const patch of [
    { startsAt: Date.now() + 100000 },
    { expiresAt: 1 },
    { enabled: false },
  ]) {
    const c = await coupon(patch);
    assert.equal(
      (await request("/coupons/claim", { code: c.code })).status,
      409,
    );
  }
  const requestArgs = {
    operationId: "same-create-request",
    code: "IDEMPOTENT",
    title: "Retry safe",
    rewards: [{ id: "gold", amount: 1 }],
  };
  const a = await admin("coupons.create", requestArgs),
    b = await admin("coupons.create", requestArgs);
  assert.deepEqual(a, b);
  assert.equal(
    (await admin("coupons.create", { ...requestArgs, title: "Changed" }))
      .status,
    409,
  );
  const c = a.body.coupon;
  const changes = await Promise.all(
    [2, 3].map((n) =>
      admin("coupons.update", {
        id: c.id,
        expectedRevision: 1,
        title: `Title ${n}`,
      }),
    ),
  );
  assert.deepEqual(changes.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    (
      await admin("coupons.create", {
        code: "INVALID",
        title: "Bad",
        rewards: [{ id: "ec2_item", amount: 1 }],
      })
    ).status,
    422,
  );
  assert.equal(
    (await admin("coupons.disable", { id: c.id, expectedRevision: 2 }, "guest"))
      .status,
    403,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM admin_audit WHERE action=? AND detail_json LIKE ?",
        )
        .bind("coupons.create", "%IDEMPOTENT%")
        .first()
    ).n,
    1,
  );
});
test("mail owner isolation, rewardless mail, read/claim concurrency and replay", async () => {
  const m = await mail({ rewards: [] });
  assert.equal(
    (await request(`/mail/${m.id}`, undefined, "other")).status,
    404,
  );
  assert.equal((await request(`/mail/${m.id}/claim`, {}, "other")).status, 404);
  assert.equal((await request(`/mail/${m.id}/read`, {}, "other")).status, 404);
  assert.equal((await request(`/mail/${m.id}/read`, {})).body.read, true);
  const reads = await request(`/mail/${m.id}`);
  assert.ok(reads.body.mail.readAt);
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => request(`/mail/${m.id}/claim`, {})),
  );
  assert.ok(claims.every((x) => x.status === 200));
  assert.equal(new Set(claims.map((x) => x.body.grant.id)).size, 1);
  assert.deepEqual(claims[0].body.grant.rewards, []);
  await admin("mail.disable", { id: m.id, expectedRevision: 1 });
  await db
    .prepare("UPDATE liveops_mail SET expires_at=1 WHERE id=?")
    .bind(m.id)
    .run();
  assert.deepEqual(
    (await request(`/mail/${m.id}/claim`, {})).body.grant,
    claims[0].body.grant,
  );
  const expired = await mail();
  await db
    .prepare("UPDATE liveops_mail SET expires_at=1 WHERE id=?")
    .bind(expired.id)
    .run();
  assert.equal((await request(`/mail/${expired.id}/claim`, {})).status, 404);
});
test("mail send retries, transaction rollback and pagination with timestamp ties", async () => {
  const args = {
    operationId: "send-once-request",
    playerId: "owner",
    title: "Once",
    rewards: [],
  };
  const [a, b] = await Promise.all([
    admin("mail.send", args),
    admin("mail.send", args),
  ]);
  assert.deepEqual(a, b);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await mail()).id);
  for (const id of ids)
    await db
      .prepare("UPDATE liveops_mail SET created_at=100 WHERE id=?")
      .bind(id)
      .run();
  let before = "101",
    seen = [];
  do {
    const r = await admin("mail.history", {
      playerId: "owner",
      limit: 1,
      before,
    });
    seen.push(...r.body.mail.map((x) => x.id));
    before = r.body.nextBefore;
  } while (before);
  assert.deepEqual(new Set(seen), new Set(ids));
  await db.exec(
    "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action='mail.send' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;",
  );
  const failed = await admin("mail.send", {
    operationId: "rollback-request",
    playerId: "owner",
    title: "Rollback",
  });
  assert.equal(failed.status, 500);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM liveops_mail WHERE title=?")
        .bind("Rollback")
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM liveops_admin_operation WHERE operation_id=?",
        )
        .bind("rollback-request")
        .first()
    ).n,
    0,
  );
  await db.exec("DROP TRIGGER synthetic_audit_failure;");
  assert.equal(
    (
      await db
        .prepare("SELECT save_version FROM player WHERE id=?")
        .bind("owner")
        .first()
    ).save_version,
    0,
  );
});

test("receipt recovery owner scope, stable acknowledgement and coupon input limits", async () => {
  const listed = await request("/grants?limit=1");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.grants.length, 1);
  const id = listed.body.grants[0].id;
  assert.equal(
    (await request(`/grants/${id}`, undefined, "other")).status,
    404,
  );
  assert.equal((await request(`/grants/${id}/ack`, {}, "other")).status, 404);
  const acknowledgements = await Promise.all(
    Array.from({ length: 5 }, () => request(`/grants/${id}/ack`, {})),
  );
  assert.ok(acknowledgements.every((x) => x.status === 200));
  assert.equal(
    new Set(acknowledgements.map((x) => x.body.acknowledgedAt)).size,
    1,
  );
  assert.equal(
    (await request(`/grants/${id}`)).body.acknowledgedAt,
    acknowledgements[0].body.acknowledgedAt,
  );
  const large = await request(
    "/coupons/check",
    { code: "A".repeat(5000) },
    "third",
  );
  assert.equal(large.status, 413);
  for (let i = 0; i < 32; i++)
    await request("/coupons/check", { code: "UNKNOWN" }, "third");
  const throttled = await request(
    "/coupons/claim",
    { code: "UNKNOWN" },
    "third",
  );
  assert.equal(throttled.status, 429);
  assert.ok(throttled.body.retryAfterSeconds > 0);
});

test("duplicate rewards and unknown admin roles fail closed", async () => {
  for (const rewards of [
    [
      { id: "gold", amount: 2147483647 },
      { id: "gold", amount: 1 },
    ],
    [
      { id: "ruby", amount: 1 },
      { id: "ruby", amount: 1 },
    ],
  ]) {
    assert.equal(
      (
        await admin("coupons.create", {
          code: "DUPLICATE",
          title: "Invalid",
          rewards,
        })
      ).body.error,
      "duplicate_reward",
    );
    assert.equal(
      (
        await admin("mail.send", {
          playerId: "owner",
          title: "Invalid",
          rewards,
        })
      ).body.error,
      "duplicate_reward",
    );
  }
  for (const role of [null, "owner", "administrator", ""]) {
    assert.equal((await admin("coupons.list", {}, role)).status, 403);
    assert.equal(
      (await admin("mail.history", { playerId: "owner" }, role)).status,
      403,
    );
    assert.equal(
      (
        await admin(
          "mail.send",
          { playerId: "owner", title: "Forbidden" },
          role,
        )
      ).status,
      403,
    );
  }
});

test("feature error boundaries preserve auth/business errors and hide database failures", async () => {
  await db
    .prepare(
      "INSERT INTO player_ban(player_id,reason,created_at) VALUES(?,?,?)",
    )
    .bind("third", "Synthetic ban", 1)
    .run();
  for (const route of ["/mail", "/grants"]) {
    const response = await request(route, undefined, "third");
    assert.equal(response.status, 403);
    assert.equal(response.body.error, "player_banned");
  }
  await db
    .prepare("DELETE FROM player_ban WHERE player_id=?")
    .bind("third")
    .run();
  const invalid = await mf.dispatchFetch(
    "https://synthetic.local/coupons/check",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: "{broken",
    },
  );
  assert.equal(invalid.status, 400);
  await db.exec("ALTER TABLE liveops_mail RENAME TO synthetic_hidden_mail;");
  const failed = await request("/mail");
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, "liveops_unavailable");
  await db.exec("ALTER TABLE synthetic_hidden_mail RENAME TO liveops_mail;");
});
test("grant insertion failure rolls back coupon eligibility and mail claim state", async () => {
  const c = await coupon(),
    m = await mail();
  await db.exec(
    "CREATE TRIGGER synthetic_grant_failure BEFORE INSERT ON liveops_grant BEGIN SELECT RAISE(ABORT,'synthetic_grant_failure'); END;",
  );
  assert.equal((await request("/coupons/claim", { code: c.code })).status, 503);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM liveops_coupon_claim WHERE coupon_id=?",
        )
        .bind(c.id)
        .first()
    ).n,
    0,
  );
  assert.equal((await request(`/mail/${m.id}/claim`, {})).status, 503);
  assert.equal(
    (
      await db
        .prepare("SELECT claimed_at FROM liveops_mail WHERE id=?")
        .bind(m.id)
        .first()
    ).claimed_at,
    null,
  );
  await db.exec("DROP TRIGGER synthetic_grant_failure;");
  assert.equal((await request("/coupons/claim", { code: c.code })).status, 200);
  assert.equal((await request(`/mail/${m.id}/claim`, {})).status, 200);
});

test("concurrent creates recover same request and type distinct-operation code collisions", async () => {
  const args = {
    code: "CONCURRENT-SAME",
    title: "Same",
    rewards: [{ id: "gold", amount: 1 }],
    operationId: "same-concurrent-create",
  };
  const repeated = await Promise.all([
    admin("coupons.create", args),
    admin("coupons.create", args),
  ]);
  assert.deepEqual(repeated[0], repeated[1]);
  assert.equal(repeated[0].status, 201);
  const collisions = await Promise.all([
    admin("coupons.create", {
      ...args,
      code: "CONCURRENT-COLLISION",
      operationId: "distinct-create-one",
    }),
    admin("coupons.create", {
      ...args,
      code: "CONCURRENT-COLLISION",
      operationId: "distinct-create-two",
    }),
  ]);
  assert.deepEqual(collisions.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    collisions.find((r) => r.status === 409).body.error,
    "coupon_code_exists",
  );
});
