import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import {
  webcrypto,
  createHash,
  X509Certificate,
  createPrivateKey,
  sign,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
let mf,
  db,
  player,
  other,
  binding,
  otherBinding,
  receiptKey,
  certificateDirectory,
  appleLeafKey,
  appleChain,
  requests = [],
  facts = new Map(),
  storeUnavailable = false;
const origin = "https://ec1.local",
  packageName = "com.gacogames.epiccon";
const base64 = (bytes) => Buffer.from(bytes).toString("base64");
before(async () => {
  certificateDirectory = await mkdtemp(
    path.join(tmpdir(), "ec1-purchase-cert-"),
  );
  const openssl =
      process.platform === "win32"
        ? "C:/Program Files/Git/usr/bin/openssl.exe"
        : "openssl",
    run = promisify(execFile),
    certCommand = async (args) =>
      run(openssl, args, { cwd: certificateDirectory });
  for (const name of ["root", "intermediate", "leaf"])
    await certCommand([
      "ecparam",
      "-name",
      "prime256v1",
      "-genkey",
      "-noout",
      "-out",
      `${name}.key`,
    ]);
  await certCommand([
    "req",
    "-new",
    "-x509",
    "-key",
    "root.key",
    "-subj",
    "/CN=Synthetic EC1 Receipt Root",
    "-days",
    "2",
    "-sha256",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-out",
    "root.pem",
  ]);
  await writeFile(
    path.join(certificateDirectory, "intermediate.ext"),
    "basicConstraints=critical,CA:TRUE\n1.2.840.113635.100.6.2.1=DER:05:00\n",
  );
  await writeFile(
    path.join(certificateDirectory, "leaf.ext"),
    "basicConstraints=critical,CA:FALSE\n1.2.840.113635.100.6.11.1=DER:05:00\n",
  );
  for (const [name, parent] of [
    ["intermediate", "root"],
    ["leaf", "intermediate"],
  ]) {
    await certCommand([
      "req",
      "-new",
      "-key",
      `${name}.key`,
      "-subj",
      `/CN=Synthetic EC1 ${name}`,
      "-out",
      `${name}.csr`,
    ]);
    await certCommand([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${parent}.pem`,
      "-CAkey",
      `${parent}.key`,
      "-CAcreateserial",
      "-days",
      "2",
      "-sha256",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.pem`,
    ]);
  }
  appleLeafKey = createPrivateKey(
    await readFile(path.join(certificateDirectory, "leaf.key")),
  );
  appleChain = await Promise.all(
    ["leaf", "intermediate", "root"].map(async (name) =>
      new X509Certificate(
        await readFile(path.join(certificateDirectory, `${name}.pem`)),
      ).raw.toString("base64"),
    ),
  );
  const receiptPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-1",
    },
    true,
    ["sign", "verify"],
  );
  receiptKey = receiptPair.privateKey;
  const publisherPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const credential = JSON.stringify({
    type: "service_account",
    client_email: "synthetic-ec1@fixture.invalid",
    private_key: `-----BEGIN PRIVATE KEY-----\n${base64(await webcrypto.subtle.exportKey("pkcs8", publisherPair.privateKey))}\n-----END PRIVATE KEY-----`,
  });
  const contents = `import {Hono} from 'hono';import {createAuthApp} from './src/auth';import {createPurchasesApp} from './src/purchases';import {createGameApp,publishSnapshot} from './src/game';import {nativeKeys} from './src/game/validation';const app=new Hono();app.route('/api/auth',createAuthApp());app.route('/api/game',createGameApp());app.route('/api/purchases',createPurchasesApp());app.post('/test/disabled',async c=>createPurchasesApp().fetch(new Request('https://ec1.local/claim',c.req.raw),{...c.env,IAP_PURCHASES_ENABLED:'false'},c.executionCtx));app.all('/test/paused/*',c=>new Hono().route('/api/purchases',createPurchasesApp()).fetch(new Request('https://ec1.local/api/purchases/'+c.req.path.slice('/test/paused/'.length)+new URL(c.req.url).search,c.req.raw),{...c.env,ALLOW_NEW_ACCOUNTS:'false',IAP_PURCHASES_ENABLED:'false'},c.executionCtx));app.post('/test/save',async c=>{const b=await c.req.json(),prefs=Object.fromEntries(nativeKeys.map(k=>[k,'0'])),attributes=JSON.stringify({level:1,exp:0,s_top:'',s_glove:'',s_shoes:'',s_weapon:''});Object.assign(prefs,{alaster_attributes:attributes,edna_attributes:attributes,louisa_attributes:'',soul_attributes:'',gamedata:JSON.stringify({gold:0,ruby:0,stageProgress:1,tutorialProgress:0,timeCounter:10,usedCoupons:[],stageInfo:[],stat_goldEarned:0,stat_rubyEarned:0}),inventory:'^^',consumable:'',LastRewardTime:'',selected:'alaster',achievements_new:Array(27).fill('0').join('|'),lbId:'',lbName:''});return c.json(await publishSnapshot(c.env,b.playerId,{game:'ec1',schemaVersion:1,playtime:10,data:{CLOUD_ALL_DATA:JSON.stringify(prefs),Playtime:'10'},expectedSaveVersion:0,operationId:b.operationId,intent:'new_game'}));});app.onError((e,c)=>c.json({error:e.code||'error'},e.status||503));export default app;`;
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd() },
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
    plugins: [
      {
        name: "synthetic-apple-root-only-in-isolated-test",
        setup(build) {
          build.onLoad(
            { filter: /purchases[\\/]receipts\.ts$/ },
            async (args) => {
              const production = await readFile(args.path, "utf8");
              assert.ok(production.includes("MIICQzCCAcmg"));
              return {
                contents: production.replace(
                  /const APPLE_ROOT_CA_G3_DER_BASE64\s*=\s*"[^"]+";/,
                  `const APPLE_ROOT_CA_G3_DER_BASE64 = "${appleChain[2]}";`,
                ),
                loader: "ts",
              };
            },
          );
        },
      },
    ],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      d1Databases: { DB: "purchase-test" },
      r2Buckets: ["PLAYER_SAVES", "AUDIT_BLOBS", "LEGACY_ARCHIVE"],
      bindings: {
        PLAYER_TOKEN_SECRET:
          "synthetic-purchase-player-secret-at-least-32-chars",
        ALLOW_NEW_ACCOUNTS: "true",
        IAP_PURCHASES_ENABLED: "true",
        IAP_GOOGLE_PUBLIC_KEY: base64(
          await webcrypto.subtle.exportKey("spki", receiptPair.publicKey),
        ),
        IAP_GOOGLE_SERVICE_ACCOUNT: credential,
        IAP_GOOGLE_PACKAGE_NAME: packageName,
        IAP_APPLE_BUNDLE_ID: packageName,
        IAP_APPLE_VERIFICATION_MODE: "receipt",
      },
      outboundService: async (request) => {
        requests.push(request.url);
        if (request.url === "https://oauth2.googleapis.com/token") {
          const form = new URLSearchParams(await request.text()),
            parts = form.get("assertion").split("."),
            claims = JSON.parse(Buffer.from(parts[1], "base64url"));
          assert.equal(claims.iss, "synthetic-ec1@fixture.invalid");
          assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
          assert.equal(
            claims.scope,
            "https://www.googleapis.com/auth/androidpublisher",
          );
          assert.equal(
            await webcrypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              publisherPair.publicKey,
              Buffer.from(parts[2], "base64url"),
              new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
            ),
            true,
          );
          return new Response(
            JSON.stringify({
              access_token: "synthetic-publisher-bearer",
              expires_in: 3600,
            }),
          );
        }
        if (
          request.url.startsWith("https://androidpublisher.googleapis.com/")
        ) {
          assert.equal(
            request.headers.get("Authorization"),
            "Bearer synthetic-publisher-bearer",
          );
          assert.ok(
            request.url.includes(
              `/applications/${packageName}/purchases/productsv2/tokens/`,
            ),
          );
          if (storeUnavailable)
            return new Response("synthetic outage", { status: 503 });
          const token = decodeURIComponent(
              new URL(request.url).pathname.split("/").at(-1),
            ),
            purchase = facts.get(token);
          if (!purchase) return new Response("missing", { status: 404 });
          return new Response(JSON.stringify(purchase));
        }
        throw new Error("Unexpected store/PlayFab request");
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
    "020_purchases.sql",
    "021_device_credentials.sql",
    "035_purchase_grants.sql",
  ])
    for (const statement of (await readFile(`migrations/${file}`, "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  player = await request(
    "/api/auth/guest",
    {
      bootstrapId: "purchase-player",
      bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    },
    "POST",
    null,
  );
  other = await request(
    "/api/auth/guest",
    {
      bootstrapId: "purchase-other",
      bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    },
    "POST",
    null,
  );
  binding = await request("/api/purchases/account-binding");
  otherBinding = await request(
    "/api/purchases/account-binding",
    null,
    "GET",
    other.accessToken,
  );
  assert.equal(
    (
      await request(
        "/test/save",
        { playerId: player.playerId, operationId: "purchase-first-save" },
        "POST",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/test/save",
        { playerId: other.playerId, operationId: "other-first-save" },
        "POST",
      )
    ).status,
    200,
  );
});
after(async () => {
  await mf?.dispose();
  if (certificateDirectory) {
    assert.ok(
      certificateDirectory.startsWith(
        path.join(tmpdir(), "ec1-purchase-cert-"),
      ),
    );
    await rm(certificateDirectory, { recursive: true, force: true });
  }
});
async function request(
  route,
  body,
  method = "GET",
  token = player?.accessToken,
) {
  const response = await mf.dispatchFetch(`${origin}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP":
        body?.platform === "apple" ? "synthetic-ios" : "synthetic-android",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ...(await response.json()), status: response.status };
}
async function proof(
  productId,
  token,
  owner = binding.googleObfuscatedAccountId,
  overrides = {},
) {
  const receiptJson = JSON.stringify({
    packageName,
    productId,
    purchaseToken: token,
    purchaseTime: Date.now(),
    purchaseState: 0,
    ...overrides,
  });
  facts.set(token, {
    purchaseStateContext: { purchaseState: "PURCHASED" },
    productLineItem: [{ productId, productOfferDetails: { quantity: 1 } }],
    obfuscatedExternalAccountId: owner,
    purchaseCompletionTime: new Date().toISOString(),
  });
  return {
    platform: "google",
    productId,
    receiptJson,
    signatureBase64: base64(
      await webcrypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        receiptKey,
        new TextEncoder().encode(receiptJson),
      ),
    ),
    expectedSaveVersion: 1,
    operationId: `purchase-${token}`,
  };
}
test("disabled/untrusted/wrong-app/wrong-product receipts grant nothing and make no fallback requests", async () => {
  const valid = await proof("ruby1", "disabled-token"),
    outbound = requests.length;
  assert.equal(
    (await request("/test/disabled", valid, "POST")).error,
    "purchases_disabled",
  );
  assert.equal(requests.length, outbound);
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        { ...valid, receiptJson: valid.receiptJson + " " },
        "POST",
      )
    ).error,
    "invalid_purchase_receipt",
  );
  const wrongApp = await proof(
    "ruby1",
    "wrong-app",
    binding.googleObfuscatedAccountId,
    { packageName: "com.gacogames.epicon2" },
  );
  assert.equal(
    (await request("/api/purchases/claim", wrongApp, "POST")).reason,
    "wrong_package",
  );
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        { ...valid, productId: "ruby2" },
        "POST",
      )
    ).reason,
    "product_id_mismatch",
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM purchase_ledger").first()).n,
    0,
  );
  assert.equal(requests.length, outbound);
});
test("store state, quantity, account provenance and outages fail closed before reservation/grant", async () => {
  for (const [token, override, error] of [
    [
      "pending-token",
      { purchaseStateContext: { purchaseState: "PENDING" } },
      "purchase_pending",
    ],
    [
      "revoked-token",
      { purchaseStateContext: { purchaseState: "CANCELLED" } },
      "invalid_purchase_receipt",
    ],
    [
      "wrong-owner",
      { obfuscatedExternalAccountId: otherBinding.googleObfuscatedAccountId },
      "purchase_owner_mismatch",
    ],
    [
      "quantity-token",
      {
        productLineItem: [
          { productId: "ruby1", productOfferDetails: { quantity: 2 } },
        ],
      },
      "purchase_quantity_unsupported",
    ],
    ["test-token", { testPurchaseContext: {} }, "test_purchase_not_allowed"],
  ]) {
    const input = await proof("ruby1", token);
    facts.set(token, { ...facts.get(token), ...override });
    assert.equal(
      (await request("/api/purchases/claim", input, "POST")).error,
      error,
    );
  }
  const outage = await proof("ruby1", "outage-token");
  storeUnavailable = true;
  try {
    assert.equal(
      (await request("/api/purchases/claim", outage, "POST")).error,
      "purchase_store_unavailable",
    );
  } finally {
    storeUnavailable = false;
  }
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM purchase_ledger").first()).n,
    0,
  );
});
test("genuine signed/API proof grants once; lost responses and later order IDs resolve canonical transaction", async () => {
  const input = await proof("ruby1", "canonical-token");
  const first = await request(
    "/api/purchases/claim",
    { ...input, price: 999999, amount: 123456 },
    "POST",
  );
  assert.equal(first.status, 200);
  assert.equal(first.confirmPurchase, true);
  assert.equal(first.saveVersion, 2);
  assert.equal(
    JSON.parse(JSON.parse(first.data.CLOUD_ALL_DATA).gamedata).ruby,
    9,
  );
  const replay = await request("/api/purchases/claim", input, "POST");
  assert.equal(replay.saveVersion, 2);
  assert.equal(replay.replayed, true);
  const changed = await proof(
    "ruby1",
    "canonical-token",
    binding.googleObfuscatedAccountId,
    { orderId: "GPA.SYNTHETIC-ORDER" },
  );
  const canonical = await request("/api/purchases/claim", changed, "POST");
  assert.equal(canonical.saveVersion, 2);
  assert.equal(canonical.purchaseKey, first.purchaseKey);
  assert.equal(
    (await request("/api/purchases/claim", input, "POST", other.accessToken))
      .error,
    "purchase_already_claimed",
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM purchase_ledger").first()).n,
    1,
  );
});
test("parallel same-owner purchase delivery returns one committed winner; competing player cannot claim", async () => {
  const input = await proof("ruby2", "parallel-token");
  input.expectedSaveVersion = 2;
  const [a, b] = await Promise.all([
    request("/api/purchases/claim", input, "POST"),
    request("/api/purchases/claim", input, "POST"),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.saveVersion, b.saveVersion);
  assert.equal(a.saveVersion, 3);
  const different = await request(
    "/api/purchases/claim",
    { ...input, operationId: "parallel-other-operation" },
    "POST",
  );
  assert.equal(different.error, "purchase_already_granted");
  assert.equal(different.latestSaveVersion, 3);
  assert.equal(different.data, undefined);
  assert.equal(JSON.parse(JSON.parse(a.data.CLOUD_ALL_DATA).gamedata).ruby, 41);
  assert.equal(
    (await request("/api/purchases/claim", input, "POST", other.accessToken))
      .error,
    "purchase_already_claimed",
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM grant_receipt WHERE source_id LIKE 'purchase:%'",
        )
        .first()
    ).n,
    2,
  );
});
test("publication failure holds verified transaction, then retry commits ledger, reward and paid flags atomically", async () => {
  const input = await proof("premium", "premium-token");
  input.expectedSaveVersion = 3;
  await db
    .prepare(
      "CREATE TRIGGER fail_purchase_grant BEFORE INSERT ON grant_receipt BEGIN SELECT RAISE(FAIL,'synthetic publish failure'); END",
    )
    .run();
  const failed = await request("/api/purchases/claim", input, "POST");
  assert.equal(failed.status, 503);
  assert.equal(failed.confirmPurchase, undefined);
  const pending = await db
    .prepare("SELECT * FROM purchase_ledger WHERE product_id='premium'")
    .first();
  assert.equal(pending.status, "verified_pending");
  assert.equal(pending.save_version, null);
  assert.equal(
    (
      await db
        .prepare("SELECT save_version FROM player WHERE id=?")
        .bind(player.playerId)
        .first()
    ).save_version,
    3,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM purchase_entitlement").first()).n,
    0,
  );
  await db.prepare("DROP TRIGGER fail_purchase_grant").run();
  const granted = await request("/api/purchases/claim", input, "POST");
  assert.equal(granted.status, 200);
  assert.equal(granted.saveVersion, 4);
  assert.equal(JSON.parse(granted.data.CLOUD_ALL_DATA).premium, "1");
  const prefs = JSON.parse(granted.data.CLOUD_ALL_DATA);
  prefs.premium = "0";
  const uploaded = await request(
    "/api/game/save",
    {
      game: "ec1",
      schemaVersion: 1,
      playtime: 10,
      data: { ...granted.data, CLOUD_ALL_DATA: JSON.stringify(prefs) },
      expectedSaveVersion: 4,
      operationId: "cannot-erase-premium",
    },
    "PUT",
  );
  assert.equal(uploaded.status, 200);
  assert.equal(JSON.parse(uploaded.data.CLOUD_ALL_DATA).premium, "1");
  const stale = await request(
    "/api/purchases/claim",
    { ...input, expectedSaveVersion: 5, operationId: "paid-new-operation" },
    "POST",
  );
  assert.equal(stale.error, "purchase_already_granted");
  assert.equal(stale.latestSaveVersion, 5);
  assert.equal(stale.data, undefined);
});
test("audited starter and canonical item bundles match EC1 quantities; one-time paid flags prevent regrant", async () => {
  const starter = await proof("starter", "starter-token");
  starter.expectedSaveVersion = 5;
  const grant = await request("/api/purchases/claim", starter, "POST");
  assert.equal(grant.status, 200);
  assert.equal(grant.saveVersion, 6);
  const prefs = JSON.parse(grant.data.CLOUD_ALL_DATA),
    gd = JSON.parse(prefs.gamedata);
  assert.equal(gd.ruby, 191);
  assert.equal(gd.gold, 150000);
  assert.equal(prefs.getOffer, "1");
  const again = await proof("starter", "starter-second-token");
  again.expectedSaveVersion = 6;
  assert.equal(
    (await request("/api/purchases/claim", again, "POST")).error,
    "purchase_entitlement_already_owned",
  );
  const step = await proof("stepup_1", "stepup-token");
  step.expectedSaveVersion = 6;
  const itemGrant = await request("/api/purchases/claim", step, "POST");
  assert.equal(itemGrant.status, 200);
  assert.equal(itemGrant.saveVersion, 7);
  const inventory = JSON.parse(itemGrant.data.CLOUD_ALL_DATA).inventory.split(
    "^",
  );
  const materials = inventory[1].split("|").map(JSON.parse),
    consumables = inventory[2].split("|").map(JSON.parse);
  assert.equal(materials.find((i) => i.id === "ironbar").amount, 100);
  assert.equal(materials.find((i) => i.id === "jewel_courage_e").amount, 15);
  assert.equal(consumables.find((i) => i.id === "medred").amount, 20);
});
test("Apple unsigned or attacker supplied chain cannot grant; ledger outputs omit receipts and provider secrets", async () => {
  const payload = Buffer.from(
    JSON.stringify({
      bundleId: packageName,
      productId: "ruby1",
      transactionId: "fake-apple-transaction",
      signedDate: Date.now(),
      quantity: 1,
      environment: "Production",
      appAccountToken: binding.appleAppAccountToken,
    }),
  ).toString("base64url");
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", x5c: ["AA==", "AA=="] }),
  ).toString("base64url");
  const invalid = await request(
    "/api/purchases/claim",
    {
      platform: "apple",
      productId: "ruby1",
      jwsReceipt: `${header}.${payload}.AA`,
      expectedSaveVersion: 7,
      operationId: "invalid-apple-proof",
    },
    "POST",
  );
  assert.equal(invalid.error, "invalid_purchase_receipt");
  const ledger = await request("/api/purchases/ledger");
  assert.equal(ledger.status, 200);
  assert.ok(ledger.purchases.length >= 5);
  assert.ok(
    ledger.purchases.every(
      (p) =>
        !("receipt_hash" in p) &&
        !("facts_json" in p) &&
        !("purchaseToken" in p),
    ),
  );
  assert.ok(
    requests.every(
      (url) =>
        url.startsWith("https://oauth2.googleapis.com/") ||
        url.startsWith("https://androidpublisher.googleapis.com/"),
    ),
  );
});
test("competing operation IDs for one purchase deliver once and return no stale data to the loser", async () => {
  const input = await proof(
    "ruby1",
    "different-operations-token",
    otherBinding.googleObfuscatedAccountId,
  );
  const responses = await Promise.all([
    request("/api/purchases/claim", input, "POST", other.accessToken),
    request(
      "/api/purchases/claim",
      { ...input, operationId: "competing-purchase-operation" },
      "POST",
      other.accessToken,
    ),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const loser = responses.find((r) => r.status === 409);
  assert.equal(loser.error, "purchase_already_granted");
  assert.equal(loser.data, undefined);
  assert.equal(loser.latestSaveVersion, 2);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM purchase_ledger WHERE player_id=? AND status=?",
        )
        .bind(other.playerId, "granted")
        .first()
    ).n,
    1,
  );
});
test("Apple receipt path validates isolated certificate purpose/chain/date and account binding, then grants durably", async () => {
  const proof = (payload) => {
    const header = Buffer.from(
        JSON.stringify({ alg: "ES256", x5c: appleChain }),
      ).toString("base64url"),
      body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), { key: appleLeafKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const payload = {
    bundleId: packageName,
    productId: "ruby1",
    transactionId: "synthetic-apple-paid",
    purchaseDate: Date.now(),
    signedDate: Date.now(),
    quantity: 1,
    environment: "Production",
    appAccountToken: otherBinding.appleAppAccountToken,
  };
  const input = {
    platform: "apple",
    productId: "ruby1",
    jwsReceipt: proof(payload),
    expectedSaveVersion: 2,
    operationId: "synthetic-apple-grant",
  };
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        {
          ...input,
          jwsReceipt: proof({ ...payload, bundleId: "com.gacogames.epicon2" }),
        },
        "POST",
        other.accessToken,
      )
    ).reason,
    "wrong_bundle_id",
  );
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        {
          ...input,
          jwsReceipt: proof({
            ...payload,
            appAccountToken: binding.appleAppAccountToken,
          }),
        },
        "POST",
        other.accessToken,
      )
    ).error,
    "purchase_owner_mismatch",
  );
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        { ...input, jwsReceipt: proof({ ...payload, signedDate: 1 }) },
        "POST",
        other.accessToken,
      )
    ).reason,
    "certificate_outside_validity",
  );
  assert.equal(
    (
      await request(
        "/api/purchases/claim",
        {
          ...input,
          jwsReceipt: proof({ ...payload, revocationDate: Date.now() }),
        },
        "POST",
        other.accessToken,
      )
    ).reason,
    "revoked_transaction",
  );
  const outbound = requests.length,
    granted = await request(
      "/api/purchases/claim",
      input,
      "POST",
      other.accessToken,
    );
  assert.equal(granted.status, 200);
  assert.equal(granted.saveVersion, 3);
  assert.equal(
    JSON.parse(JSON.parse(granted.data.CLOUD_ALL_DATA).gamedata).ruby,
    18,
  );
  assert.equal(
    (await request("/api/purchases/claim", input, "POST", other.accessToken))
      .saveVersion,
    3,
  );
  assert.equal(requests.length, outbound);
});
test("fresh account without initial save retains verified pending purchase and resumes after its first save", async () => {
  const fresh = await request(
      "/api/auth/guest",
      {
        bootstrapId: "purchase-before-save",
        bootstrapSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
      },
      "POST",
      null,
    ),
    account = await request(
      "/api/purchases/account-binding",
      null,
      "GET",
      fresh.accessToken,
    );
  const input = await proof(
    "ruby1",
    "no-initial-save",
    account.googleObfuscatedAccountId,
  );
  input.expectedSaveVersion = 0;
  const held = await request(
    "/api/purchases/claim",
    input,
    "POST",
    fresh.accessToken,
  );
  assert.equal(held.status, 404);
  assert.equal(held.error, "no_save");
  assert.equal(held.confirmPurchase, undefined);
  const pending = await db
    .prepare(
      "SELECT status,save_version FROM purchase_ledger WHERE player_id=?",
    )
    .bind(fresh.playerId)
    .first();
  assert.equal(pending.status, "verified_pending");
  assert.equal(pending.save_version, null);
  assert.equal(
    (
      await request(
        "/test/save",
        {
          playerId: fresh.playerId,
          operationId: "fresh-purchase-initial-save",
        },
        "POST",
      )
    ).status,
    200,
  );
  const grant = await request(
    "/api/purchases/claim",
    { ...input, expectedSaveVersion: 1 },
    "POST",
    fresh.accessToken,
  );
  assert.equal(grant.status, 200);
  assert.equal(grant.saveVersion, 2);
  assert.equal(
    JSON.parse(JSON.parse(grant.data.CLOUD_ALL_DATA).gamedata).ruby,
    9,
  );
});

const hex = s => createHash('sha256').update(s).digest('hex');
let guestSession, guestBinding;
async function modernProof(sku, name, owner=guestSession.playerId, account=guestBinding.googleObfuscatedAccountId) {
 const p=await proof(sku,name,account);
 delete p.expectedSaveVersion;
 p.protocol='ec1-grants-v1';p.mode='purchase';
 p.operationId=hex('ec1/purchase/v1/'+owner+'/google:'+hex(name));
 return p;
}
test('guest checkout needs no game login; capability is stable, scoped and secret-bound',async()=>{
 const credential={id:'a'.repeat(32),secret:'b'.repeat(64)};
 guestSession=await request('/api/purchases/guest-session',credential,'POST',null);
 assert.equal(guestSession.status,200,JSON.stringify(guestSession));
 assert.equal(guestSession.playerId,'EC1G_'+credential.id);
 assert.equal((await request('/api/purchases/guest-session',credential,'POST',null)).playerId,guestSession.playerId);
 assert.equal((await request('/api/purchases/guest-session',{...credential,secret:'c'.repeat(64)},'POST',null)).status,401);
 assert.equal((await request('/api/game/readiness',null,'GET',guestSession.accessToken)).status,401);
 assert.equal((await request('/api/purchases/ledger',null,'GET',guestSession.accessToken)).status,403);
 assert.equal((await request('/api/purchases/account-binding',null,'GET',null)).status,401);
 guestBinding=await request('/api/purchases/account-binding',null,'GET',guestSession.accessToken);
 assert.equal(guestBinding.deliveryProtocol,'ec1-grants-v1');
 assert.match(guestBinding.googleObfuscatedAccountId,/^[a-f0-9]{64}$/);
 assert.ok(guestBinding.enabledProductIds.includes('ruby1'));
 assert.ok(!guestBinding.enabledProductIds.includes('starter'));
 assert.equal((await db.prepare('SELECT count(*) n FROM auth_identity WHERE player_id=?').bind(guestSession.playerId).first()).n,0);
});
test('production grants are immutable across concurrent validation and create no gameplay backups',async()=>{
 const input=await modernProof('ruby1','modern-sale');
 const send=()=>request('/api/purchases/validate',input,'POST',guestSession.accessToken);
 const [a,b]=await Promise.all([send(),send()]);
 assert.equal(a.status,200,JSON.stringify(a));assert.deepEqual(a,b);
 assert.equal(a.purchaseKey,'google:'+hex('modern-sale'));assert.equal(a.rewards[0].amount,9);
 assert.equal(a.data,undefined);assert.equal(a.saveVersion,undefined);
 assert.equal((await db.prepare('SELECT count(*) n FROM save_revision WHERE player_id=?').bind(guestSession.playerId).first()).n,0);
 storeUnavailable=true;
 assert.deepEqual(await send(),a);
 storeUnavailable=false;
 const ack='/api/purchases/grants/'+a.grantId+'/ack';
 assert.equal((await request(ack,{operationId:input.operationId},'POST',other.accessToken)).status,404);
 assert.equal((await request(ack,{operationId:input.operationId},'POST',guestSession.accessToken)).status,200);
 assert.equal((await request(ack,{operationId:input.operationId},'POST',guestSession.accessToken)).status,200);
 assert.equal((await db.prepare('SELECT status FROM purchase_ledger WHERE purchase_key=?').bind(a.purchaseKey).first()).status,'granted');
});
test('forged, pending, foreign, wrong quantity, test payments and client rewards never issue grants',async()=>{
 for(const [name,patch] of [['pending',{purchaseStateContext:{purchaseState:'PENDING'}}],['quantity',{productLineItem:[{productId:'ruby1',productOfferDetails:{quantity:2}}]}],['foreign',{obfuscatedExternalAccountId:'foreign'}],['test',{testPurchaseContext:{fopType:'TEST'}}]]){
  const input=await modernProof('ruby1','modern-'+name);
  Object.assign(facts.get('modern-'+name),patch);
  const r=await request('/api/purchases/validate',input,'POST',guestSession.accessToken);assert.notEqual(r.status,200,JSON.stringify(r));
  assert.equal((await db.prepare('SELECT count(*) n FROM purchase_grant WHERE purchase_key=?').bind('google:'+hex('modern-'+name)).first()).n,0);
 }
 const p=await modernProof('ruby1','modern-forged');
 assert.equal((await request('/api/purchases/validate',{...p,receiptJson:p.receiptJson+' '},'POST',guestSession.accessToken)).status,401);
 assert.equal((await request('/api/purchases/validate',{...p,rewards:[{id:'ruby',amount:999}]},'POST',guestSession.accessToken)).status,400);
 assert.equal((await request('/api/purchases/validate',p,'POST',other.accessToken)).status,409);
});
test('restore grants return only permanent flags and never replay currency or material bundles',async()=>{
 const p=await modernProof('stepup_1','modern-stepup');
 const sale=await request('/api/purchases/validate',p,'POST',guestSession.accessToken);assert.equal(sale.status,200,JSON.stringify(sale));
 assert.ok(sale.rewards.length>1);assert.equal(sale.entitlements.stepUp1,1);
 const restored=await request('/api/purchases/validate',{...p,mode:'restore'},'POST',guestSession.accessToken);
 assert.equal(restored.status,200,JSON.stringify(restored));assert.deepEqual(restored.rewards,[]);assert.equal(restored.kind,'entitlement-restore');
 assert.equal(restored.entitlements.stepUp1,1);assert.notEqual(restored.grantId,sale.grantId);
 assert.deepEqual(await request('/api/purchases/validate',{...p,mode:'restore'},'POST',guestSession.accessToken),restored);
 const q=await modernProof('ruby1','modern-currency-restore');q.mode='restore';
 assert.equal((await request('/api/purchases/validate',q,'POST',guestSession.accessToken)).status,422);
 const second=await modernProof('stepup_1','modern-stepup-second');
 assert.equal((await request('/api/purchases/validate',second,'POST',guestSession.accessToken)).status,409);
 const old=await modernProof('stepup_2','modern-restore-first');old.mode='restore';
 assert.equal((await request('/api/purchases/validate',old,'POST',guestSession.accessToken)).status,200);
 assert.equal((await request('/api/purchases/validate',{...old,mode:'purchase'},'POST',guestSession.accessToken)).status,409);
});
test('grant publication failure rolls back reservation and can be retried without duplicate value',async()=>{
 const p=await modernProof('ruby2','modern-rollback');
 await db.prepare("CREATE TRIGGER fail_modern_grant BEFORE INSERT ON purchase_grant BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
 assert.equal((await request('/api/purchases/validate',p,'POST',guestSession.accessToken)).status,503);
 assert.equal((await db.prepare('SELECT count(*) n FROM purchase_ledger WHERE purchase_key=?').bind('google:'+hex('modern-rollback')).first()).n,0);
 await db.prepare('DROP TRIGGER fail_modern_grant').run();
 assert.equal((await request('/api/purchases/validate',p,'POST',guestSession.accessToken)).status,200);
});

test('Apple signed production grant and entitlement-only restore use the same guest contract',async()=>{
 const payload={bundleId:packageName,productId:'iap_premium',transactionId:'modern-apple-paid',purchaseDate:Date.now(),signedDate:Date.now(),quantity:1,environment:'Production',appAccountToken:guestBinding.appleAppAccountToken};
 const signed=value=>{
  const h=Buffer.from(JSON.stringify({alg:'ES256',x5c:appleChain})).toString('base64url'),p=Buffer.from(JSON.stringify(value)).toString('base64url');
  return h+'.'+p+'.'+sign('sha256',Buffer.from(h+'.'+p),{key:appleLeafKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 };
 const input={protocol:'ec1-grants-v1',platform:'apple',mode:'purchase',productId:'iap_premium',operationId:hex('ec1/purchase/v1/'+guestSession.playerId+'/apple:modern-apple-paid'),jwsReceipt:signed(payload)};
 const sale=await request('/api/purchases/validate',input,'POST',guestSession.accessToken);
 assert.equal(sale.status,200,JSON.stringify(sale));assert.equal(sale.entitlements.premium,1);assert.equal(sale.environment,'production');
 assert.equal((await db.prepare('SELECT transaction_id FROM purchase_ledger WHERE purchase_key=?').bind(sale.purchaseKey).first()).transaction_id,'modern-apple-paid');
 const restore=await request('/api/purchases/validate',{...input,mode:'restore'},'POST',guestSession.accessToken);
 assert.equal(restore.status,200);assert.equal(restore.kind,'entitlement-restore');assert.deepEqual(restore.rewards,[]);
 const revoked=await request('/api/purchases/validate',{...input,mode:'restore',jwsReceipt:signed({...payload,revocationDate:Date.now()})},'POST',guestSession.accessToken);
 assert.equal(revoked.status,401);
});

test('guest recovery survives paused checkout with new account creation disabled',async()=>{
 const credential={id:'a'.repeat(32),secret:'b'.repeat(64)};
 assert.equal((await request('/test/paused/guest-session',credential,'POST',null)).status,200);
 assert.equal((await request('/test/paused/guest-session',{id:'d'.repeat(32),secret:'e'.repeat(64)},'POST',null)).status,503);
 const b=await request('/test/paused/account-binding',null,'GET',guestSession.accessToken);
 assert.equal(b.purchasesEnabled,false);assert.deepEqual(b.enabledProductIds,[]);assert.equal(b.deliveryProtocol,'ec1-grants-v1');
 const p=await modernProof('ruby1','modern-sale');storeUnavailable=true;
 const r=await request('/test/paused/validate',p,'POST',guestSession.accessToken);storeUnavailable=false;
 assert.equal(r.status,200);assert.equal(r.rewards[0].amount,9);
 const pending=await modernProof('ruby1','modern-paid-before-pause');
 assert.equal((await request('/test/paused/validate',pending,'POST',guestSession.accessToken)).status,200);
});

test('signed-in accounts use the grant API and cannot claim its value again through the old save writer',async()=>{
 const input=await modernProof('ruby1','modern-account-sale',player.playerId,binding.googleObfuscatedAccountId);
 const originalVersion=(await db.prepare('SELECT save_version FROM player WHERE id=?').bind(player.playerId).first()).save_version;
 const r=await request('/api/purchases/validate',input,'POST');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.playerId,player.playerId);
 const legacy={...input,expectedSaveVersion:originalVersion,operationId:'legacy-double-spend'};
 const again=await request('/api/purchases/claim',legacy,'POST');assert.equal(again.status,409);assert.equal(again.error,'purchase_delivery_protocol_required');
 assert.equal((await db.prepare('SELECT save_version FROM player WHERE id=?').bind(player.playerId).first()).save_version,originalVersion);
 await db.prepare("UPDATE purchase_ledger SET status='revoked' WHERE purchase_key=?").bind(r.purchaseKey).run();
 assert.equal((await request('/api/purchases/validate',input,'POST')).status,403);
 assert.equal((await request('/api/purchases/grants/'+r.grantId+'/ack',{operationId:input.operationId},'POST')).status,403);
});

test('native binding advertises only its configured platform catalogue',async()=>{
 const google=await request('/api/purchases/account-binding?platform=google',null,'GET',guestSession.accessToken);
 const apple=await request('/api/purchases/account-binding?platform=apple',null,'GET',guestSession.accessToken);
 assert.ok(google.enabledProductIds.includes('premium'));assert.ok(!google.enabledProductIds.includes('iap_premium'));
 assert.ok(apple.enabledProductIds.includes('iap_premium'));assert.ok(!apple.enabledProductIds.includes('premium'));
 assert.ok(google.enabledProductIds.includes('ruby1')&&apple.enabledProductIds.includes('ruby1'));
 assert.equal((await request('/api/purchases/account-binding?platform=invalid',null,'GET',guestSession.accessToken)).status,400);
});
