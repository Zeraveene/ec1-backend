// Explicit synthetic staging smoke. No real providers, mail or PlayFab requests.
// Password/tokens remain in memory and are deliberately absent from diagnostics.
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = "https://epicon1-backend-staging.johanesnindyo.workers.dev";
const email = `editor-smoke-${randomUUID()}@example.invalid`;
const password = randomBytes(32).toString("base64url");
async function request(path, body, access, method = "POST") {
  const response = await fetch(origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `${path}: ${response.status} ${result.error || "request_failed"}`,
    );
  return result;
}
const created = await request("/api/auth/register", {
  email,
  password,
  bootstrapId: randomUUID(),
  bootstrapSecret: randomBytes(32).toString("base64url"),
  deviceId: "synthetic-editor-smoke",
});
assert.equal(created.saveState, "native_uninitialized");
assert.equal(created.saveVersion, 0);
const snapshot = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/unity-fresh-save.json", import.meta.url),
    "utf8",
  ),
);
const profile = JSON.parse(snapshot.data.CLOUD_ALL_DATA);
profile.editor_smoke_unknown = "preserved";
snapshot.data.CLOUD_ALL_DATA = JSON.stringify(profile);
const saved = await request(
  "/api/game/save",
  {
    ...snapshot,
    expectedSaveVersion: 0,
    operationId: randomUUID(),
    deviceId: "synthetic-editor-smoke",
    intent: "new_game",
  },
  created.accessToken,
  "PUT",
);
assert.equal(saved.playerId, created.playerId);
assert.equal(saved.saveVersion, 1);
await request("/api/auth/logout", {}, created.accessToken);
// A new sign-in without a retained bearer/refresh simulates a fresh process.
const signin = await request("/api/auth/login", {
  email,
  password,
  deviceId: "synthetic-editor-smoke-restart",
});
assert.equal(signin.playerId, created.playerId);
assert.equal(signin.saveState, "native_ready");
const readback = await request(
  "/api/game/save",
  null,
  signin.accessToken,
  "GET",
);
assert.equal(readback.saveVersion, 1);
assert.deepEqual(readback.data, snapshot.data);
await request("/api/auth/logout", {}, signin.accessToken);
console.log(
  JSON.stringify({
    result: "EC1_STAGING_EMAIL_SMOKE_PASSED",
    playerId: created.playerId,
    saveVersion: 1,
    profileFieldCount: Object.keys(profile).length,
    sameProfileAfterFreshSignin: true,
    mailSent: false,
    productionContacted: false,
  }),
);
