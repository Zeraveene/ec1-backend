import type { Hono } from "hono";
import type { AppEnv, Env } from "../env";
async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
import { rateLimit } from "../auth/maintenance";
import { productGrant } from "./catalog";
import { PurchaseError } from "./store";

function permitted(env: Env, playerId: string) {
  return env.IAP_EDITOR_TEST_ENABLED === "true" &&
    (env.IAP_EDITOR_TEST_PLAYERS ?? "").split(",").map(id => id.trim()).filter(Boolean).includes(playerId);
}
function activeProduct(id: string) {
  const sku = id.startsWith("iap_") ? id.slice(4) : id;
  return /^(ruby[1-8]|jewel_(red|orange|purple)|premium|archer|souru|double_loot|more_exp|dual_booster|booster_pack|stepup_[1-5])$/.test(sku);
}
interface Row { grant_json: string; product_id: string; platform: string }

// Called after the purchase module's authenticated player + scope middleware.
// No snapshots, store verification shortcuts, or client-specified rewards.
export function installEditorPurchaseRoutes(app: Hono<AppEnv>) {
  app.post("/editor-test", async c => {
    const playerId = c.get("player").playerId;
    if (!permitted(c.env, playerId)) throw new PurchaseError("editor_purchase_not_allowed", 403);
    await rateLimit(c.env, "editor-purchase", playerId, 60, 60);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); }
    catch { throw new PurchaseError("invalid_purchase_request"); }
    if (!body || Array.isArray(body) || typeof body !== "object" ||
        Object.keys(body).some(k => !["protocol","platform","productId","operationId","mode","test"].includes(k)) ||
        body.protocol !== "ec1-grants-v1" || body.mode !== "test" || body.test !== true ||
        (body.platform !== "google" && body.platform !== "apple") ||
        typeof body.productId !== "string" || body.productId.length > 128 || !activeProduct(body.productId) ||
        typeof body.operationId !== "string" || !/^[a-f0-9]{64}$/.test(body.operationId))
      throw new PurchaseError("invalid_purchase_request");
    const { platform, productId, operationId } = body;
    const read = () => c.env.DB.prepare("SELECT grant_json,product_id,platform FROM purchase_editor_grant WHERE player_id=? AND operation_id=?")
      .bind(playerId, operationId).first<Row>();
    const replay = (row: Row) => {
      if (row.product_id !== productId || row.platform !== platform) throw new PurchaseError("operation_conflict", 409);
      return c.json(JSON.parse(row.grant_json));
    };
    const existing = await read();
    if (existing) return replay(existing);
    const definition = productGrant(platform, productId);
    const purchaseKey = "editor:" + await hash(playerId + "/" + operationId);
    const grantId = "editor_" + await hash(purchaseKey), createdAt = Date.now();
    const grant = {
      protocol: "ec1-grants-v1", game: "ec1", grantId, rewardRevision: "catalog-v1",
      playerId, purchaseKey, platform, productId, quantity: 1,
      environment: "test", verificationSource: "unity_editor",
      rewards: definition.rewards,
      entitlements: Object.fromEntries(Object.entries(definition.entitlements).map(([k,v]) => [k, Number(v)])),
    };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,operation_id,created_at) VALUES(?,?,?,?,?,?,1,'test','unity_editor',?,?,?)")
        .bind(purchaseKey, platform, purchaseKey, playerId, productId, await hash(JSON.stringify(body)),
          JSON.stringify({ environment: "test", source: "unity_editor", quantity: 1, purchaseTime: createdAt }), operationId, createdAt),
      c.env.DB.prepare("INSERT OR IGNORE INTO purchase_editor_grant(grant_id,player_id,operation_id,purchase_key,product_id,platform,grant_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(grantId, playerId, operationId, purchaseKey, productId, platform, JSON.stringify(grant), createdAt),
    ]);
    const saved = await read();
    if (!saved) throw new PurchaseError("purchase_service_unavailable", 503);
    return replay(saved);
  });
  app.post("/editor-test/:grantId/ack", async c => {
    const playerId = c.get("player").playerId, grantId = c.req.param("grantId");
    if (!/^editor_[a-f0-9]{64}$/.test(grantId)) throw new PurchaseError("invalid_purchase_request");
    let body: { operationId?: unknown };
    try { body = await c.req.json(); } catch { throw new PurchaseError("invalid_purchase_request"); }
    if (!body || typeof body.operationId !== "string" || !/^[a-f0-9]{64}$/.test(body.operationId))
      throw new PurchaseError("invalid_purchase_request");
    const row = await c.env.DB.prepare("SELECT purchase_key FROM purchase_editor_grant WHERE grant_id=? AND player_id=? AND operation_id=?")
      .bind(grantId, playerId, body.operationId).first<{ purchase_key: string }>();
    if (!row) throw new PurchaseError("purchase_grant_not_found", 404);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE purchase_editor_grant SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE grant_id=? AND player_id=?")
        .bind(now, grantId, playerId),
      c.env.DB.prepare("UPDATE purchase_ledger SET status='granted',granted_at=COALESCE(granted_at,?) WHERE purchase_key=? AND player_id=? AND environment='test' AND verification_source='unity_editor'")
        .bind(now, row.purchase_key, playerId),
    ]);
    return c.json({ acknowledged: true, environment: "test" });
  });
}
