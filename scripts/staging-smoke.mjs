import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
const origin = new URL(
  process.argv[2] ||
    "https://epicon1-backend-staging.johanesnindyo.workers.dev",
);
assert.ok(
  origin.hostname === "epicon1-backend-staging.johanesnindyo.workers.dev" ||
    ["127.0.0.1", "localhost"].includes(origin.hostname),
  "This smoke test only permits EC1 staging or a local Worker",
);
const fixture = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/unity-fresh-save.json", import.meta.url),
    "utf8",
  ),
);
const deviceId = randomUUID();
const deviceCredential = {
  deviceCredentialId: randomUUID(),
  deviceSecret: randomBytes(32).toString("base64url"),
  deviceId,
};
const boot = {
  bootstrapId: randomUUID(),
  bootstrapSecret: randomBytes(32).toString("base64url"),
  ...deviceCredential,
};
const email = `ec1-smoke-${randomUUID()}@fixture.invalid`,
  password = randomBytes(24).toString("base64url");
async function request(path, body, token, method) {
  const response = await fetch(new URL(path, origin), {
    method: method || (body ? "POST" : "GET"),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
function expect(result, status, phase) {
  assert.equal(
    result.status,
    status,
    `${phase}: ${result.data.error || "unexpected_status"}`,
  );
  return result.data;
}
const health = expect(await request("/api/health"), 200, "health");
assert.equal(health.game, "ec1");
assert.equal(health.migrationEnabled, false);
const first = expect(
  await request("/api/auth/guest", boot),
  200,
  "guest create",
);
assert.equal(first.saveState, "native_uninitialized");
assert.equal(first.saveVersion, 0);
const retry = expect(
  await request("/api/auth/guest", boot),
  200,
  "creation retry",
);
assert.equal(retry.playerId, first.playerId);
assert.equal(retry.refreshToken, first.refreshToken);
const empty = await request("/api/game/save", null, first.accessToken);
assert.equal(empty.status, 404);
assert.equal(empty.data.error, "no_save");
const input = {
  ...fixture,
  deviceId,
  operationId: randomUUID(),
  expectedSaveVersion: 0,
  intent: "new_game",
};
const save = expect(
  await request("/api/game/save", input, first.accessToken, "PUT"),
  200,
  "first save",
);
assert.equal(save.saveVersion, 1);
assert.deepEqual(save.data, input.data);
const saveRetry = expect(
  await request("/api/game/save", input, first.accessToken, "PUT"),
  200,
  "save retry",
);
assert.equal(saveRetry.saveVersion, 1);
assert.deepEqual(saveRetry.data, save.data);
const deviceSignin = expect(
  await request("/api/auth/device/login", deviceCredential),
  200,
  "native device signin",
);
assert.equal(deviceSignin.playerId, first.playerId);
const deviceLoad = expect(
  await request("/api/game/save", null, deviceSignin.accessToken),
  200,
  "native device readback",
);
assert.deepEqual(deviceLoad.data, fixture.data);
const linked = expect(
  await request("/api/auth/link/email", { email, password }, first.accessToken),
  200,
  "link email",
);
assert.equal(linked.playerId, first.playerId);
expect(
  await request("/api/auth/logout", {}, linked.accessToken),
  200,
  "logout",
);
const signin = expect(
  await request("/api/auth/login", { email, password, deviceId }),
  200,
  "restart email signin",
);
assert.equal(signin.playerId, first.playerId);
const loaded = expect(
  await request("/api/game/save", null, signin.accessToken),
  200,
  "restart load",
);
assert.equal(loaded.saveVersion, 1);
assert.deepEqual(loaded.data, fixture.data);
const refreshInput = {
  refreshToken: signin.refreshToken,
  operationId: randomUUID(),
};
const rotated = expect(
  await request("/api/auth/refresh", refreshInput),
  200,
  "refresh",
);
const rotationRetry = expect(
  await request("/api/auth/refresh", refreshInput),
  200,
  "refresh retry",
);
assert.equal(rotated.refreshToken, rotationRetry.refreshToken);
const daily = expect(
  await request("/api/game/daily/check", null, rotated.accessToken),
  200,
  "daily check",
);
assert.equal(daily.reset.timezone, "UTC");
assert.equal(daily.reset.eligible, true);
const resetInput = {
  period: daily.reset.period,
  expectedSaveVersion: loaded.saveVersion,
  operationId: randomUUID(),
};
const reset = expect(
  await request("/api/game/daily/reset", resetInput, rotated.accessToken),
  200,
  "daily reset",
);
assert.equal(reset.saveVersion, 2);
const resetRetry = expect(
  await request("/api/game/daily/reset", resetInput, rotated.accessToken),
  200,
  "daily reset retry",
);
assert.deepEqual(resetRetry.data, reset.data);
assert.equal(resetRetry.saveVersion, 2);
const afterDaily = expect(
  await request("/api/game/daily/check", null, rotated.accessToken),
  200,
  "daily reset readback",
);
assert.equal(afterDaily.reset.eligible, false);
const originalPrefs = JSON.parse(fixture.data.CLOUD_ALL_DATA),
  resetPrefs = JSON.parse(reset.data.CLOUD_ALL_DATA);
assert.equal(
  JSON.parse(resetPrefs.gamedata).gold,
  JSON.parse(originalPrefs.gamedata).gold,
);
assert.equal(
  JSON.parse(resetPrefs.gamedata).ruby,
  JSON.parse(originalPrefs.gamedata).ruby,
);
for (const key of [
  "alaster_attributes",
  "edna_attributes",
  "louisa_attributes",
  "soul_attributes",
  "inventory",
  "achievements_new",
  "premium",
  "double_loot",
  "more_exp",
  "elysianTaken",
])
  assert.equal(resetPrefs[key], originalPrefs[key]);
const legacy = await request("/api/game/migration/proof", {
  sessionTicket: "synthetic-no-real-account-ticket",
});
assert.ok([403, 503].includes(legacy.status));
assert.equal(legacy.data.error, "migration_disabled");
const admin = await request("/api/admin/me");
assert.equal(admin.data.error, "admin_not_configured");
await mkdir(new URL("../output/", import.meta.url), { recursive: true });
const result = {
  origin: origin.origin,
  checkedAt: new Date().toISOString(),
  playerId: first.playerId,
  saveVersion: reset.saveVersion,
  snapshotSha256: createHash("sha256")
    .update(JSON.stringify(fixture.data))
    .digest("hex"),
  checks: [
    "backend-only creation",
    "idempotent creation",
    "valid no-save state",
    "actual Unity99 first save",
    "save retry",
    "durable device signin and readback",
    "email link",
    "logout and restart signin",
    "readback exact data",
    "refresh retry",
    "server daily reset",
    "exact daily reset retry",
    "daily reset preserves progress/currencies",
    "migration disabled",
    "admin closed without config",
  ],
};
await writeFile(
  new URL("../output/staging-smoke-latest.json", import.meta.url),
  JSON.stringify(result, null, 2),
);
// Credentials remain local, ignored and silent so the synthetic staging profile can be reused for later checks.
await writeFile(
  new URL("../output/staging-smoke-credentials.json", import.meta.url),
  JSON.stringify(
    {
      origin: origin.origin,
      playerId: first.playerId,
      email,
      password,
      refreshToken: rotated.refreshToken,
      ...deviceCredential,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(result, null, 2));
