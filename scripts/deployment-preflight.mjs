import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
const targets = [
  "https://ec1mod.codezrv.com",
  "https://ec1.gacogames.com",
  "https://epicon1-backend.johanesnindyo.workers.dev",
];
const evidence = [];
for (const origin of targets) {
  const response = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.game, "ec1");
  assert.equal(health.environment, "production-preparation");
  assert.equal(health.newAccountsEnabled, false);
  assert.equal(health.migrationEnabled, false);
  assert.equal(health.purchasesEnabled, false);
  assert.equal(health.recoveryEnabled, false);
  const blocked = await fetch(`${origin}/api/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bootstrapId: randomUUID(),
      bootstrapSecret: randomBytes(32).toString("base64url"),
    }),
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, "new_accounts_disabled");
  const admin = await fetch(`${origin}/api/admin/me`);
  assert.equal(admin.status, 503);
  assert.equal((await admin.json()).error, "admin_not_configured");
  const recovery = await fetch(`${origin}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "preflight@fixture.invalid" }),
  });
  assert.equal(recovery.status, 503);
  assert.equal((await recovery.json()).error, "recovery_not_configured");
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /assets\/index-/);
  assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
  evidence.push({
    origin,
    health,
    checks: [
      "creation paused",
      "migration paused",
      "purchases paused",
      "recovery email paused",
      "unconfigured admin closed",
      "SPA assets available",
      "security headers present",
    ],
  });
}
const local = JSON.parse(
  await readFile(
    new URL("../output/staging-smoke-credentials.json", import.meta.url),
    "utf8",
  ),
);
const signed = await fetch(`${local.origin}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: local.email, password: local.password }),
});
assert.equal(signed.status, 200);
const auth = await signed.json();
for (const origin of targets) {
  const cross = await fetch(`${origin}/api/game/save`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  assert.equal(cross.status, 401);
  assert.equal((await cross.json()).error, "unauthorized");
}
await mkdir(new URL("../output/", import.meta.url), { recursive: true });
const result = {
  checkedAt: new Date().toISOString(),
  production: evidence,
  environmentIsolation: "Staging tokens rejected on all production hosts",
};
await writeFile(
  new URL("../output/deployment-preflight-latest.json", import.meta.url),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
