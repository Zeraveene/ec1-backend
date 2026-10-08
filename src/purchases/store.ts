import type { Env } from "../env";
import { base64, hash } from "../auth/crypto";
import { ReceiptError, type VerifiedPurchase } from "./receipts";
export class PurchaseError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public detail?: Record<string, unknown>,
  ) {
    super(code);
  }
}
const encoder = new TextEncoder(),
  tokens = new Map<string, { token: string; expires: number }>();
async function publisherToken(credential: string) {
  let config: { type: string; client_email: string; private_key: string };
  try {
    config = JSON.parse(credential);
  } catch {
    throw new PurchaseError("purchase_not_configured", 503);
  }
  if (
    config.type !== "service_account" ||
    typeof config.client_email !== "string" ||
    typeof config.private_key !== "string"
  )
    throw new PurchaseError("purchase_not_configured", 503);
  const fingerprint = await hash(credential),
    cached = tokens.get(fingerprint);
  if (cached && cached.expires > Date.now()) return cached.token;
  const seconds = Math.floor(Date.now() / 1000),
    header = base64(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    payload = base64(
      JSON.stringify({
        iss: config.client_email,
        scope: "https://www.googleapis.com/auth/androidpublisher",
        aud: "https://oauth2.googleapis.com/token",
        iat: seconds,
        exp: seconds + 3600,
      }),
    );
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(
        atob(
          config.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
        ),
        (c) => c.charCodeAt(0),
      ),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new PurchaseError("purchase_not_configured", 503);
  }
  const assertion = `${header}.${payload}.${base64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)))}`;
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch {
    throw new PurchaseError("purchase_store_unavailable", 503);
  }
  if (!response.ok) throw new PurchaseError("purchase_store_unavailable", 503);
  const result = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (typeof result.access_token !== "string")
    throw new PurchaseError("purchase_store_unavailable", 503);
  if (tokens.size >= 8) tokens.clear();
  tokens.set(fingerprint, {
    token: result.access_token,
    expires:
      Date.now() + Math.min(result.expires_in || 3600, 3600) * 1000 - 60000,
  });
  return result.access_token;
}
export interface StoreFacts {
  environment: "production" | "test";
  quantity: number;
  source: "google_api" | "apple_signed_receipt";
  purchaseTime: number | null;
  orderId: string;
  accountBinding: string;
}
export async function verifyStore(
  env: Env,
  verified: VerifiedPurchase,
  account: { google_account_id: string; apple_account_token: string },
): Promise<StoreFacts> {
  if (verified.platform === "apple") {
    if (env.IAP_APPLE_VERIFICATION_MODE !== "receipt")
      throw new PurchaseError("purchase_not_configured", 503);
    const data = verified.appleData;
    if (!data || !["Production", "Sandbox"].includes(String(data.environment)))
      throw new ReceiptError("invalid_environment");
    if (
      typeof data.appAccountToken !== "string" ||
      data.appAccountToken.toLowerCase() !==
        account.apple_account_token.toLowerCase()
    )
      throw new PurchaseError("purchase_owner_mismatch", 403);
    if (data.revocationDate !== undefined && data.revocationDate !== null)
      throw new ReceiptError("revoked_transaction");
    if (data.quantity !== 1)
      throw new PurchaseError("purchase_quantity_unsupported", 422);
    if (
      data.environment === "Sandbox" &&
      env.IAP_ALLOW_TEST_PURCHASES !== "true"
    )
      throw new PurchaseError("test_purchase_not_allowed", 403);
    return {
      environment: data.environment === "Production" ? "production" : "test",
      quantity: 1,
      source: "apple_signed_receipt",
      purchaseTime: verified.purchaseTimeMs,
      orderId: verified.transactionId,
      accountBinding: account.apple_account_token,
    };
  }
  if (
    !env.IAP_GOOGLE_SERVICE_ACCOUNT ||
    !env.IAP_GOOGLE_PACKAGE_NAME ||
    !verified.purchaseToken
  )
    throw new PurchaseError("purchase_not_configured", 503);
  const token = await publisherToken(env.IAP_GOOGLE_SERVICE_ACCOUNT);
  let response: Response;
  try {
    response = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.IAP_GOOGLE_PACKAGE_NAME)}/purchases/productsv2/tokens/${encodeURIComponent(verified.purchaseToken)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    throw new PurchaseError("purchase_store_unavailable", 503);
  }
  if (response.status === 404)
    throw new ReceiptError("store_purchase_not_found");
  if (!response.ok) throw new PurchaseError("purchase_store_unavailable", 503);
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new PurchaseError("purchase_store_unavailable", 503);
  }
  if (result.purchaseStateContext?.purchaseState === "PENDING")
    throw new PurchaseError("purchase_pending", 409);
  if (result.purchaseStateContext?.purchaseState !== "PURCHASED")
    throw new ReceiptError("not_purchased");
  if (
    !Array.isArray(result.productLineItem) ||
    result.productLineItem.length !== 1 ||
    result.productLineItem[0].productId !== verified.productId
  )
    throw new ReceiptError("product_id_mismatch");
  if (result.productLineItem[0].productOfferDetails?.quantity !== 1)
    throw new PurchaseError("purchase_quantity_unsupported", 422);
  if (result.obfuscatedExternalAccountId !== account.google_account_id)
    throw new PurchaseError("purchase_owner_mismatch", 403);
  if (
    result.testPurchaseContext != null &&
    env.IAP_ALLOW_TEST_PURCHASES !== "true"
  )
    throw new PurchaseError("test_purchase_not_allowed", 403);
  if (
    !verified.transactionId.startsWith("google-token:") &&
    result.orderId !== verified.transactionId
  )
    throw new ReceiptError("order_id_mismatch");
  const time = Date.parse(result.purchaseCompletionTime);
  if (!Number.isFinite(time))
    throw new PurchaseError("purchase_store_unavailable", 503);
  return {
    environment: result.testPurchaseContext != null ? "test" : "production",
    quantity: 1,
    source: "google_api",
    purchaseTime: time,
    orderId: result.orderId || verified.transactionId,
    accountBinding: account.google_account_id,
  };
}
