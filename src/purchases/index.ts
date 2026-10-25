import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { requirePlayer } from "../auth";
import { AuthError } from "../auth/providers";
import { hash } from "../auth/crypto";
import { rateLimit } from "../auth/maintenance";
import {
  loadSnapshot,
  publishSnapshot,
  replayOperation,
} from "../game/storage";
import { GameError } from "../game/validation";
import { applyRewards, applyRewardFlags } from "../game/rewards";
import {
  ReceiptError,
  verifyGooglePlayReceipt,
  verifyAppleReceipt,
} from "./receipts";
import { PurchaseError, verifyStore } from "./store";
import { productGrant } from "./catalog";
type Binding = { google_account_id: string; apple_account_token: string };
async function accountBinding(env: Env, id: string): Promise<Binding> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO purchase_account_binding(player_id,google_account_id,apple_account_token,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      id,
      await hash(`ec1/store-account/v1/${id}`),
      crypto.randomUUID(),
      Date.now(),
    )
    .run();
  const row = await env.DB.prepare(
    "SELECT google_account_id,apple_account_token FROM purchase_account_binding WHERE player_id=?",
  )
    .bind(id)
    .first<Binding>();
  if (!row) throw new PurchaseError("purchase_service_unavailable", 503);
  return row;
}
function field(body: Record<string, unknown>, key: string, max = 65536) {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max)
    throw new PurchaseError("invalid_purchase_request");
  return value;
}
async function committedReceipt(
  env: Env,
  playerId: string,
  row: { operation_id: string; save_version: number },
  operationId: string,
  purchaseKey: string,
) {
  if (row.operation_id !== operationId) {
    const current = await env.DB.prepare(
      "SELECT save_version FROM player WHERE id=?",
    )
      .bind(playerId)
      .first<{ save_version: number }>();
    throw new PurchaseError("purchase_already_granted", 409, {
      receipt: {
        playerId,
        purchaseKey,
        saveVersion: row.save_version,
        operationId: row.operation_id,
      },
      latestSaveVersion: current?.save_version,
    });
  }
  const saved = await replayOperation(env, playerId, row.operation_id);
  if (!saved) throw new PurchaseError("purchase_service_unavailable", 503);
  return {
    ...saved,
    purchaseKey,
    status: "granted",
    confirmPurchase: true,
    replayed: true,
  };
}
export function createPurchasesApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    error instanceof AuthError ||
    error instanceof GameError ||
    error instanceof PurchaseError
      ? c.json(
          {
            error: error.code,
            ...(error instanceof PurchaseError ? error.detail : {}),
          },
          error.status as any,
        )
      : error instanceof ReceiptError
        ? error.code === "bad_public_key"
          ? c.json({ error: "purchase_not_configured" }, 503)
          : c.json(
              { error: "invalid_purchase_receipt", reason: error.code },
              401,
            )
        : c.json({ error: "purchase_service_unavailable" }, 503),
  );
  app.use("*", requirePlayer);
  app.use("*", async (c, next) => {
    if (c.get("player").scope !== "player")
      return c.json({ error: "insufficient_scope" }, 403);
    await next();
  });
  app.get("/account-binding", async (c) => {
    const b = await accountBinding(c.env, c.get("player").playerId);
    return c.json({
      game: "ec1",
      googleObfuscatedAccountId: b.google_account_id,
      appleAppAccountToken: b.apple_account_token,
      purchasesEnabled: c.env.IAP_PURCHASES_ENABLED === "true",
    });
  });
  app.get("/ledger", async (c) =>
    c.json({
      purchases: (
        await c.env.DB.prepare(
          "SELECT purchase_key,platform,product_id,status,save_version,created_at,granted_at FROM purchase_ledger WHERE player_id=? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(c.get("player").playerId)
          .all()
      ).results,
    }),
  );
  app.post("/claim", async (c) => {
    // The legacy delivery path publishes gameplay saves. Keep checkout disabled in manual-backup mode
    // until independent durable grant receipts and client delivery acknowledgement exist.
    if (c.env.EC1_MANUAL_BACKUPS_ENABLED === "true")
      throw new PurchaseError("manual_purchase_delivery_not_ready", 503);
    if (c.env.IAP_PURCHASES_ENABLED !== "true")
      throw new PurchaseError("purchases_disabled", 503);
    await rateLimit(
      c.env,
      "purchase-claim",
      c.req.header("CF-Connecting-IP") || "local",
      30,
    );
    let b: Record<string, unknown>;
    try {
      b = await c.req.json();
      if (!b || Array.isArray(b) || typeof b !== "object") throw 0;
    } catch {
      throw new PurchaseError("invalid_purchase_request");
    }
    const playerId = c.get("player").playerId,
      platform = field(b, "platform", 16),
      productId = field(b, "productId", 128),
      operationId = field(b, "operationId", 128);
    if (
      (platform !== "google" && platform !== "apple") ||
      !Number.isSafeInteger(b.expectedSaveVersion) ||
      Number(b.expectedSaveVersion) < 0 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(operationId)
    )
      throw new PurchaseError("invalid_purchase_request");
    const product = productGrant(platform, productId),
      binding = await accountBinding(c.env, playerId);
    if (
      (platform === "google" &&
        (!c.env.IAP_GOOGLE_PUBLIC_KEY || !c.env.IAP_GOOGLE_PACKAGE_NAME)) ||
      (platform === "apple" &&
        (!c.env.IAP_APPLE_BUNDLE_ID ||
          c.env.IAP_APPLE_VERIFICATION_MODE !== "receipt"))
    )
      throw new PurchaseError("purchase_not_configured", 503);
    const verified =
      platform === "google"
        ? await verifyGooglePlayReceipt({
            publicKeyBase64: c.env.IAP_GOOGLE_PUBLIC_KEY!,
            packageName: c.env.IAP_GOOGLE_PACKAGE_NAME!,
            receiptJson: field(b, "receiptJson"),
            signatureBase64: field(b, "signatureBase64", 4096),
            claimedProductId: productId,
          })
        : await verifyAppleReceipt({
            bundleId: c.env.IAP_APPLE_BUNDLE_ID!,
            receipt: field(b, "jwsReceipt"),
            claimedProductId: productId,
          });
    const purchaseKey = `${platform}:${platform === "google" ? await hash(verified.purchaseToken!) : verified.transactionId}`;
    let row = await c.env.DB.prepare(
      "SELECT * FROM purchase_ledger WHERE purchase_key=?",
    )
      .bind(purchaseKey)
      .first<any>();
    if (row) {
      if (row.player_id !== playerId)
        throw new PurchaseError("purchase_already_claimed", 409);
      if (row.product_id !== productId)
        throw new PurchaseError("purchase_proof_conflict", 409);
      if (row.status === "revoked")
        throw new PurchaseError("purchase_revoked", 403);
      if (row.status === "granted")
        return c.json(
          await committedReceipt(
            c.env,
            playerId,
            row,
            operationId,
            purchaseKey,
          ),
        );
    }
    const facts = await verifyStore(c.env, verified, binding);
    try {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          purchaseKey,
          platform,
          platform === "google" ? purchaseKey : verified.transactionId,
          playerId,
          productId,
          verified.receiptSha256,
          facts.quantity,
          facts.environment,
          facts.source,
          JSON.stringify(facts),
          Date.now(),
        )
        .run();
    } catch {
      throw new PurchaseError("purchase_service_unavailable", 503);
    }
    row = await c.env.DB.prepare(
      "SELECT * FROM purchase_ledger WHERE purchase_key=?",
    )
      .bind(purchaseKey)
      .first<any>();
    if (!row || row.player_id !== playerId)
      throw new PurchaseError("purchase_already_claimed", 409);
    if (row.product_id !== productId)
      throw new PurchaseError("purchase_proof_conflict", 409);
    if (row.status === "granted")
      return c.json(
        await committedReceipt(c.env, playerId, row, operationId, purchaseKey),
      );
    if (
      product.oneTimeKey &&
      (await c.env.DB.prepare(
        "SELECT value FROM purchase_entitlement WHERE player_id=? AND key=?",
      )
        .bind(playerId, product.oneTimeKey)
        .first())
    )
      throw new PurchaseError("purchase_entitlement_already_owned", 409);
    const saved = await loadSnapshot(c.env, playerId);
    if (saved.saveVersion !== b.expectedSaveVersion)
      throw new GameError("save_conflict", 409);
    const data = applyRewardFlags(
      product.rewards.length
        ? applyRewards(saved.data, product.rewards)
        : saved.data,
      product.entitlements,
    );
    try {
      const granted = await publishSnapshot(
        c.env,
        playerId,
        {
          game: "ec1",
          schemaVersion: 1,
          playtime: saved.playtime,
          data,
          expectedSaveVersion: saved.saveVersion,
          operationId,
        },
        {
          grant: { sourceId: `purchase:${purchaseKey}` },
          purchase: { key: purchaseKey, entitlements: product.entitlements },
        },
      );
      if (granted.operationId !== operationId)
        return c.json(
          await committedReceipt(
            c.env,
            playerId,
            {
              operation_id: granted.operationId,
              save_version: granted.saveVersion,
            },
            operationId,
            purchaseKey,
          ),
        );
      return c.json({
        ...granted,
        purchaseKey,
        status: "granted",
        confirmPurchase: true,
      });
    } catch (error) {
      const winner = await c.env.DB.prepare(
        "SELECT operation_id,save_version FROM purchase_ledger WHERE purchase_key=? AND player_id=? AND status='granted'",
      )
        .bind(purchaseKey, playerId)
        .first<{ operation_id: string; save_version: number }>();
      if (winner)
        return c.json(
          await committedReceipt(
            c.env,
            playerId,
            winner,
            operationId,
            purchaseKey,
          ),
        );
      throw error;
    }
  });
  return app;
}
