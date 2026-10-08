/**
 * Google Play + Apple StoreKit 2 receipt verification. Offline, no library,
 * `crypto.subtle` directly — see server/jwt-verify.ts for the style this
 * follows (that file is a JWKS/RS256 ID-token verifier, the wrong shape for
 * either receipt format, but its posture is what this copies: no library,
 * every rule unconditional, errors that do not leak which rule failed to the
 * caller).
 *
 * This module verifies a receipt was genuinely signed by the store for our
 * app and extracts the fields the ledger needs. It does not decide what a
 * product is worth, it does not grant anything, and — for both platforms —
 * it does not call out to any store API on the purchase path. Google's check
 * is a local RSA signature verification against the Play Console public key
 * configured in wrangler.toml [vars]. Apple's check (below) is a local ES256
 * JWS verification with the certificate chain validated up to a pinned
 * Apple Root CA constant, no App Store Server API credential involved.
 */

export interface VerifiedPurchase {
  platform: "google" | "apple";
  transactionId: string;
  productId: string;
  purchaseToken: string | null;
  purchaseTimeMs: number | null;
  receiptSha256: string;
  appleData?: {
    environment: unknown;
    price: unknown;
    currency: unknown;
    quantity: unknown;
    storefront: unknown;
    revocationDate: unknown;
    revocationPercentage: unknown;
    appAccountToken: unknown;
  };
}

export class ReceiptError extends Error {
  constructor(public readonly code: string) {
    super(`receipt verify failed: ${code}`);
    this.name = "ReceiptError";
  }
}

// Google's documented INAPP_PURCHASE_DATA shape (Android Publisher /
// in-app billing). Confirmed field names, not guessed:
//   orderId        - store order reference; absent for some purchases
//   packageName    - the app that made the purchase
//   productId      - the SKU purchased
//   purchaseTime   - purchase timestamp, epoch millis
//   purchaseState  - 0 = purchased, 1 = cancelled, 2 = pending
//   purchaseToken  - globally unique purchase identity, including test purchases.
// See https://developer.android.com/google/play/billing/security
interface GooglePurchaseData {
  orderId?: string;
  packageName?: string;
  productId?: string;
  purchaseTime?: number;
  purchaseState?: number;
  purchaseToken?: string;
  [key: string]: unknown;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer> | ArrayBuffer,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies a Google Play `INAPP_PURCHASE_DATA` receipt against the Play
 * Console public key and returns the fields the ledger needs.
 *
 * Every rule below is unconditional. Do not soften any of them.
 */
export async function verifyGooglePlayReceipt(opts: {
  publicKeyBase64: string;
  packageName: string;
  receiptJson: string;
  signatureBase64: string;
  claimedProductId?: string | null;
}): Promise<VerifiedPurchase> {
  // Rule 1: import the Play Console key as SPKI DER and verify with
  // SHA1withRSA. This is what Google actually signs INAPP_PURCHASE_DATA
  // with — it is not a choice and not an oversight. Do not "upgrade" it to
  // SHA-256; verification will simply always fail. This SHA-1 use is
  // signature verification against a Google-held private key, not a hash we
  // rely on for collision resistance, so it is not a weakness in the sense
  // SHA-1 is normally deprecated for.
  let publicKey: CryptoKey;
  try {
    const der = b64ToBytes(opts.publicKeyBase64);
    publicKey = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
      false,
      ["verify"],
    );
  } catch {
    throw new ReceiptError("bad_public_key");
  }

  // Rule 2: verify over the EXACT bytes of receiptJson as received. Never
  // re-serialize before verifying — JSON.parse then JSON.stringify reorders
  // and reformats, and the signature is over the original bytes. Parse only
  // after the signature passes (below).
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = b64ToBytes(opts.signatureBase64);
  } catch {
    throw new ReceiptError("malformed_signature");
  }

  const receiptBytes = new TextEncoder().encode(opts.receiptJson);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signatureBytes,
    receiptBytes,
  );
  if (!valid) throw new ReceiptError("bad_signature");

  const receiptSha256 = await sha256Hex(receiptBytes);

  let payload: GooglePurchaseData;
  try {
    payload = JSON.parse(opts.receiptJson) as GooglePurchaseData;
  } catch {
    throw new ReceiptError("malformed_json");
  }
  if (!payload || typeof payload !== "object") {
    throw new ReceiptError("malformed_json");
  }

  // Rule 3: packageName inside the parsed payload must equal ours.
  if (payload.packageName !== opts.packageName) {
    throw new ReceiptError("wrong_package");
  }

  // Rule 4: purchaseState must be 0 (purchased). 1 = cancelled, 2 = pending.
  if (payload.purchaseState !== 0) {
    throw new ReceiptError("not_purchased");
  }

  // Rule 5: require the signed purchase token. Migration 017 enforces token
  // uniqueness as well as the legacy order-id key, so a receipt acquiring an
  // orderId later cannot enter the ledger twice. Hash the fallback identity
  // to avoid exposing the purchase token in responses and audit logs.
  const purchaseToken = payload.purchaseToken;
  if (typeof purchaseToken !== "string" || purchaseToken.trim().length === 0) {
    throw new ReceiptError("missing_purchase_token");
  }
  const orderId = payload.orderId;
  const transactionId =
    typeof orderId === "string" && orderId.length > 0
      ? orderId
      : `google-token:${await sha256Hex(new TextEncoder().encode(purchaseToken))}`;

  // Rule 6: the product id comes from the signed payload, never the request
  // body. If the caller sent one, compare and reject on mismatch; never
  // trust it outright — accepting it would let a player present a genuine
  // cheap receipt and claim it was an expensive pack.
  const productId = payload.productId;
  if (typeof productId !== "string" || productId.length === 0) {
    throw new ReceiptError("missing_product_id");
  }
  if (opts.claimedProductId != null && opts.claimedProductId !== productId) {
    throw new ReceiptError("product_id_mismatch");
  }

  return {
    platform: "google",
    transactionId,
    productId,
    purchaseToken,
    purchaseTimeMs:
      typeof payload.purchaseTime === "number" ? payload.purchaseTime : null,
    receiptSha256,
  };
}

// ─── Apple StoreKit 2 JWS receipt verification (session 2) ────────────────
//
// Unity IAP 5.0.1's iOS store implementation hands the app a StoreKit 2
// signed transaction via `IAppleOrderInfo.jwsRepresentation`
// (`Runtime/Purchasing/Core/Purchasing/Models/AppleOrderInfo.cs`, package
// com.unity.purchasing@821fd0bcef6f):
//
//   public string? jwsRepresentation { get; set; }
//   ...
//   jwsRepresentation = signatureJws;
//
// populated in `Runtime/Stores/AppleAppStore/AppleStoreImpl.cs` straight
// from the native layer's `purchaseDetails.TryGetString("signatureJws")` —
// i.e. StoreKit 2's own `Transaction.jwsRepresentation`, untouched. This is
// a compact JWS: `header.payload.signature`, ES256, with the signing
// certificate chain in the header's `x5c`. It is NOT the same string as
// `order.Info.Receipt` — that property (`OrderInfo.cs`) resolves through
// `Apple.AppReceipt`, the legacy base64 App Store receipt blob, for any
// Apple order. Session 3's client code must read
// `order.Info.Apple?.jwsRepresentation`, not `order.Info.Receipt`, to get
// the JWS this verifier expects.
//
// The JWS payload is Apple's documented `JWSTransactionDecodedPayload`
// (App Store Server API / StoreKit 2 — stable, long-published field names:
// `transactionId`, `originalTransactionId`, `bundleId`, `productId`,
// `purchaseDate`, `revocationDate`, `revocationReason`, ...). Unity's
// package never decodes this payload — it only carries the opaque JWS
// string through — so, same as session 1's Google field names, these are
// taken from Apple's stable public documentation from training knowledge,
// not re-verified against a live fetch of Apple's current docs in this
// session. Both a transaction id and the bundle id are present inside the
// signed payload, which is what makes offline verification viable per the
// session brief's Step 1 gate.
//
// Chain validation: `x5c` is attacker-controlled input, exactly like a JWT
// `kid` naming an attacker-hosted JWKS would be — verifying the leaf
// signature against a self-supplied chain proves nothing on its own. The
// chain here is walked from the leaf up, each certificate's signature
// checked against the next certificate's public key, and the final link
// must terminate at the pinned Apple Root CA - G3 constant below — never at
// whatever root the token's own chain happens to claim.

// Apple Root CA - G3, DER, base64. Fetched directly from Apple's published
// PKI page (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer)
// during this session — not shipped from memory. SHA-256 fingerprint of
// this DER: 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:
// 30:17:B3:A8:C4:88:C3:65:3E:91:79 — matches the fingerprint Apple publishes
// for "Apple Root CA - G3" on that same page. This is a public root
// certificate, not a secret; it is pinned by value (compared byte-for-byte,
// never fetched at request time) so that no chain the client supplies can
// ever substitute a different trust anchor.
const APPLE_ROOT_CA_G3_DER_BASE64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

// ── Minimal DER (ASN.1) reader — just enough X.509 to walk a cert chain ──
// No library: same posture as the RSA/SPKI handling above. Every node is
// read generically (tag, length, content, and recursively-parsed children
// for constructed tags); certificate-specific structure is imposed by the
// callers below, not by this reader.
interface DerNode {
  tag: number;
  raw: Uint8Array<ArrayBuffer>; // full TLV bytes: tag + length + content
  content: Uint8Array<ArrayBuffer>;
  children: DerNode[]; // populated only for constructed tags
}

function parseDerNode(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number,
): { node: DerNode; next: number } {
  if (offset + 2 > bytes.length) throw new ReceiptError("bad_cert_der");
  const tag = bytes[offset];
  const lenByte = bytes[offset + 1];
  let length: number;
  let contentStart: number;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
    contentStart = offset + 2;
  } else {
    const numBytes = lenByte & 0x7f;
    if (numBytes === 0 || numBytes > 4) throw new ReceiptError("bad_cert_der");
    let lenOffset = offset + 2;
    length = 0;
    for (let i = 0; i < numBytes; i++)
      length = (length << 8) | bytes[lenOffset + i];
    contentStart = lenOffset + numBytes;
  }
  const contentEnd = contentStart + length;
  if (length < 0 || contentEnd > bytes.length)
    throw new ReceiptError("bad_cert_der");

  const constructed = (tag & 0x20) !== 0;
  const children: DerNode[] = [];
  if (constructed) {
    let p = contentStart;
    while (p < contentEnd) {
      const parsed = parseDerNode(bytes, p);
      children.push(parsed.node);
      p = parsed.next;
    }
    if (p !== contentEnd) throw new ReceiptError("bad_cert_der");
  }

  return {
    node: {
      tag,
      raw: bytes.slice(offset, contentEnd),
      content: bytes.slice(contentStart, contentEnd),
      children,
    },
    next: contentEnd,
  };
}

function parseDer(bytes: Uint8Array<ArrayBuffer>): DerNode {
  return parseDerNode(bytes, 0).node;
}

function bytesEqual(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
}

// DER content bytes of the OIDs this verifier needs to recognize. Compared
// as raw bytes rather than decoded to dotted strings — cheaper and just as
// exact for a fixed, small set of known OIDs.
const OID_ECDSA_SHA256 = new Uint8Array([
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
]); // 1.2.840.10045.4.3.2
const OID_ECDSA_SHA384 = new Uint8Array([
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03,
]); // 1.2.840.10045.4.3.3
const OID_P256 = new Uint8Array([
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
]); // 1.2.840.10045.3.1.7 (secp256r1)
const OID_P384 = new Uint8Array([0x2b, 0x81, 0x04, 0x00, 0x22]); // 1.3.132.0.34 (secp384r1)

interface ParsedCert {
  notBefore: number;
  notAfter: number;
  extensionOids: string[];
  isCA: boolean;
  fullRaw: Uint8Array<ArrayBuffer>; // entire Certificate SEQUENCE, for exact-byte root pinning
  tbsRaw: Uint8Array<ArrayBuffer>; // tbsCertificate, exactly the bytes the signature covers
  issuerRaw: Uint8Array<ArrayBuffer>; // issuer Name, full TLV
  subjectRaw: Uint8Array<ArrayBuffer>; // subject Name, full TLV
  spkiRaw: Uint8Array<ArrayBuffer>; // subjectPublicKeyInfo, full TLV — feeds crypto.subtle "spki" import directly
  sigValueRaw: Uint8Array<ArrayBuffer>; // DER SEQUENCE(r, s), decoded out of the outer BIT STRING
  curve: "P-256" | "P-384"; // this cert's own key's curve
  hash: "SHA-256" | "SHA-384"; // hash this cert was itself signed with
}

// Parses one X.509 certificate (DER) into exactly the fields chain
// validation needs. Anything not read here (extensions, validity dates,
// serial number, ...) is intentionally not relied on — this is not a
// general-purpose X.509 library, it is the minimum to prove "this leaf was
// signed by this intermediate, which was signed by the pinned Apple root".
function parseCertificate(der: Uint8Array<ArrayBuffer>): ParsedCert {
  const cert = parseDer(der);
  if (cert.tag !== 0x30 || cert.children.length < 3)
    throw new ReceiptError("bad_cert_der");
  const [tbs, sigAlgNode, sigValNode] = cert.children;
  if (tbs.tag !== 0x30 || sigAlgNode.tag !== 0x30)
    throw new ReceiptError("bad_cert_der");

  const sigAlgOidNode = sigAlgNode.children[0];
  if (!sigAlgOidNode || sigAlgOidNode.tag !== 0x06)
    throw new ReceiptError("bad_cert_der");
  let hash: "SHA-256" | "SHA-384";
  if (bytesEqual(sigAlgOidNode.content, OID_ECDSA_SHA256)) hash = "SHA-256";
  else if (bytesEqual(sigAlgOidNode.content, OID_ECDSA_SHA384))
    hash = "SHA-384";
  else throw new ReceiptError("unsupported_signature_alg");

  // tbsCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber,
  //   signature, issuer, validity, subject, subjectPublicKeyInfo, ... }
  // version is an explicit context tag (0xA0) present on every modern (v3)
  // cert; skip it if present rather than assume it is.
  let idx = 0;
  if (tbs.children[0] && tbs.children[0].tag === 0xa0) idx = 1;
  const issuer = tbs.children[idx + 2];
  const validity = tbs.children[idx + 3];
  const subject = tbs.children[idx + 4];
  const spki = tbs.children[idx + 5];
  if (
    !issuer ||
    issuer.tag !== 0x30 ||
    !subject ||
    subject.tag !== 0x30 ||
    !spki ||
    spki.tag !== 0x30
  ) {
    throw new ReceiptError("bad_cert_der");
  }
  const date = (node: DerNode | undefined) => {
    if (!node || ![0x17, 0x18].includes(node.tag))
      throw new ReceiptError("bad_cert_validity");
    const raw = new TextDecoder().decode(node.content),
      match = raw.match(
        node.tag === 0x17
          ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/
          : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/,
      );
    if (!match) throw new ReceiptError("bad_cert_validity");
    const year =
      node.tag === 0x17
        ? Number(match[1]) + (Number(match[1]) >= 50 ? 1900 : 2000)
        : Number(match[1]);
    const value = Date.UTC(
      year,
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
    if (!Number.isFinite(value)) throw new ReceiptError("bad_cert_validity");
    return value;
  };
  const extensions =
    tbs.children.find((n) => n.tag === 0xa3)?.children[0]?.children || [];
  const oid = (n: DerNode) =>
    Array.from(n.content, (v) => v.toString(16).padStart(2, "0")).join("");
  const extensionOids = extensions.map((n) => oid(n.children[0]));
  const constraints = extensions
    .find((n) => oid(n.children[0]) === "551d13")
    ?.children.find((n) => n.tag === 0x04);
  const isCA = constraints
    ? parseDer(constraints.content).children.some(
        (n) => n.tag === 0x01 && n.content[0] !== 0,
      )
    : false;

  const spkiAlg = spki.children[0];
  const namedCurveOid = spkiAlg?.children[1];
  if (!namedCurveOid || namedCurveOid.tag !== 0x06)
    throw new ReceiptError("unsupported_key_type");
  let curve: "P-256" | "P-384";
  if (bytesEqual(namedCurveOid.content, OID_P256)) curve = "P-256";
  else if (bytesEqual(namedCurveOid.content, OID_P384)) curve = "P-384";
  else throw new ReceiptError("unsupported_key_type");

  // signatureValue ::= BIT STRING wrapping a DER SEQUENCE(INTEGER r, INTEGER
  // s). The first content byte of a BIT STRING is the "unused bits" count;
  // for a DER value it is always 0.
  if (
    sigValNode.tag !== 0x03 ||
    sigValNode.content.length < 1 ||
    sigValNode.content[0] !== 0
  ) {
    throw new ReceiptError("bad_cert_der");
  }

  return {
    notBefore: date(validity?.children[0]),
    notAfter: date(validity?.children[1]),
    extensionOids,
    isCA,
    fullRaw: cert.raw,
    tbsRaw: tbs.raw,
    issuerRaw: issuer.raw,
    subjectRaw: subject.raw,
    spkiRaw: spki.raw,
    sigValueRaw: sigValNode.content.slice(1),
    curve,
    hash,
  };
}

// Converts a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs) into the
// fixed-length raw r||s format crypto.subtle expects. X.509 certificate
// signatures are DER; JOSE/JWS ECDSA signatures (used for the JWS itself,
// below) are already raw per RFC 7518 §3.4 and need no conversion.
function derEcdsaSignatureToRaw(
  der: Uint8Array<ArrayBuffer>,
  byteLen: number,
): Uint8Array<ArrayBuffer> {
  const seq = parseDer(der);
  if (seq.tag !== 0x30 || seq.children.length !== 2)
    throw new ReceiptError("bad_signature_encoding");
  const toFixed = (intNode: DerNode): Uint8Array<ArrayBuffer> => {
    if (intNode.tag !== 0x02) throw new ReceiptError("bad_signature_encoding");
    let bytes = intNode.content;
    while (bytes.length > byteLen && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length > byteLen)
      throw new ReceiptError("bad_signature_encoding");
    const out = new Uint8Array(byteLen);
    out.set(bytes, byteLen - bytes.length);
    return out;
  };
  const r = toFixed(seq.children[0]);
  const s = toFixed(seq.children[1]);
  const out = new Uint8Array(byteLen * 2);
  out.set(r, 0);
  out.set(s, byteLen);
  return out;
}

async function importEcSpki(
  spkiDer: Uint8Array<ArrayBuffer>,
  curve: "P-256" | "P-384",
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "spki",
      spkiDer,
      { name: "ECDSA", namedCurve: curve },
      false,
      ["verify"],
    );
  } catch {
    throw new ReceiptError("bad_cert_key");
  }
}

const APPLE_ROOT_CERT = parseCertificate(
  b64ToBytes(APPLE_ROOT_CA_G3_DER_BASE64),
);

// Validates an `x5c` chain (RFC 7515 §4.1.6: leaf first, each subsequent
// certificate certifies the one before it) up to the pinned Apple root and
// returns the leaf certificate, whose key verifies the JWS itself.
//
// Two shapes are accepted for where the chain "ends":
//   - the last supplied certificate IS the root (self-signed) — its bytes
//     must equal the pinned root's bytes exactly;
//   - the last supplied certificate is NOT self-signed (Apple's real StoreKit
//     2 chains typically omit the root) — it must be signed by the pinned
//     root's key, and its issuer name must equal the pinned root's subject
//     name.
// Either way, trust terminates at the embedded constant, never at whatever
// the chain claims about itself. A chain that is internally consistent
// (each link's signature genuinely verifies) but ends at a *different* root
// is rejected here — this is the case that proves chain validation is real
// rather than decorative.
async function verifyAppleCertChain(
  x5c: string[],
  signedDate: number,
): Promise<ParsedCert> {
  if (x5c.length < 2 || x5c.length > 3 || x5c.some((c) => c.length > 12000))
    throw new ReceiptError("bad_cert_chain");

  let certs: ParsedCert[];
  try {
    certs = x5c.map((b64) => parseCertificate(b64ToBytes(b64)));
  } catch (err) {
    if (err instanceof ReceiptError) throw err;
    throw new ReceiptError("bad_cert_der");
  }
  if (
    !certs[0].extensionOids.includes("2a864886f76364060b01") ||
    !certs[1].extensionOids.includes("2a864886f76364060201") ||
    !certs[1].isCA
  )
    throw new ReceiptError("invalid_apple_signing_purpose");
  for (const cert of [...certs, APPLE_ROOT_CERT])
    if (
      signedDate < cert.notBefore - 60000 ||
      signedDate > cert.notAfter + 60000
    )
      throw new ReceiptError("certificate_outside_validity");

  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i];
    const parent = certs[i + 1];
    if (!bytesEqual(child.issuerRaw, parent.subjectRaw)) {
      throw new ReceiptError("cert_chain_name_mismatch");
    }
    const parentKey = await importEcSpki(parent.spkiRaw, parent.curve);
    const sigRaw = derEcdsaSignatureToRaw(
      child.sigValueRaw,
      parent.curve === "P-384" ? 48 : 32,
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: child.hash },
      parentKey,
      sigRaw,
      child.tbsRaw,
    );
    if (!ok) throw new ReceiptError("bad_cert_chain_signature");
  }

  const last = certs[certs.length - 1];
  const lastIsSelfSigned = bytesEqual(last.issuerRaw, last.subjectRaw);
  if (lastIsSelfSigned) {
    if (!bytesEqual(last.fullRaw, APPLE_ROOT_CERT.fullRaw)) {
      throw new ReceiptError("untrusted_root");
    }
  } else {
    if (!bytesEqual(last.issuerRaw, APPLE_ROOT_CERT.subjectRaw)) {
      throw new ReceiptError("untrusted_root");
    }
    const rootKey = await importEcSpki(
      APPLE_ROOT_CERT.spkiRaw,
      APPLE_ROOT_CERT.curve,
    );
    const sigRaw = derEcdsaSignatureToRaw(
      last.sigValueRaw,
      APPLE_ROOT_CERT.curve === "P-384" ? 48 : 32,
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: last.hash },
      rootKey,
      sigRaw,
      last.tbsRaw,
    );
    if (!ok) throw new ReceiptError("untrusted_root");
  }

  return certs[0];
}

// Apple's documented JWSTransactionDecodedPayload shape (App Store Server
// API / StoreKit 2). Only the fields this verifier's rules use are typed;
// everything else passes through untouched.
interface AppleTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  [key: string]: unknown;
}

/**
 * Verifies a StoreKit 2 signed transaction (compact JWS) against the pinned
 * Apple root and returns the fields the ledger needs.
 *
 * Every rule below is unconditional. Do not soften any of them.
 */
export async function verifyAppleReceipt(opts: {
  bundleId: string;
  receipt: string;
  claimedProductId?: string | null;
  allowRevoked?: boolean; // Server reconciliation only; client validation always rejects revocation.
}): Promise<VerifiedPurchase> {
  const parts = opts.receipt.split(".");
  if (parts.length !== 3) throw new ReceiptError("malformed_token");
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header: Record<string, unknown>;
  let payload: AppleTransactionPayload;
  try {
    header = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(headerSeg)),
    ) as Record<string, unknown>;
    payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(payloadSeg)),
    ) as AppleTransactionPayload;
  } catch {
    throw new ReceiptError("malformed_token");
  }

  // Rule 1: reject alg:"none" and anything other than ES256, the same
  // posture as jwt-verify.ts rule 1 — the header's own claim about alg is
  // never trusted beyond this single equality check.
  if (header.alg !== "ES256") {
    throw new ReceiptError("unsupported_alg");
  }

  const x5c = header.x5c;
  if (
    !Array.isArray(x5c) ||
    x5c.length === 0 ||
    !x5c.every((entry) => typeof entry === "string")
  ) {
    throw new ReceiptError("missing_cert_chain");
  }

  // Rule 2: validate the chain to the pinned Apple root before trusting
  // anything about the payload or even the leaf signature's key.
  const signedDate = payload.signedDate;
  if (
    typeof signedDate !== "number" ||
    !Number.isSafeInteger(signedDate) ||
    signedDate <= 0 ||
    signedDate > Date.now() + 60000
  )
    throw new ReceiptError("invalid_signed_date");
  const leafCert = await verifyAppleCertChain(x5c as string[], signedDate);
  if (leafCert.curve !== "P-256") {
    // Apple issues ES256 (P-256) leaf signing certs for StoreKit 2 JWS. A
    // chain that verifies but hands back a different curve at the leaf is
    // not the shape this route exists to accept.
    throw new ReceiptError("unsupported_key_type");
  }
  const leafKey = await importEcSpki(leafCert.spkiRaw, leafCert.curve);

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = b64urlToBytes(sigSeg);
  } catch {
    throw new ReceiptError("malformed_token");
  }
  if (signatureBytes.length !== 64) {
    throw new ReceiptError("bad_signature_encoding");
  }
  const signedInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    leafKey,
    signatureBytes,
    signedInput,
  );
  if (!valid) throw new ReceiptError("bad_signature");

  const receiptSha256 = await sha256Hex(new TextEncoder().encode(opts.receipt));

  // Rule 3: bundleId inside the signed payload must equal APPLE_CLIENT_ID.
  if (payload.bundleId !== opts.bundleId) {
    throw new ReceiptError("wrong_bundle_id");
  }

  // Rule 4: the ledger key is transactionId, never originalTransactionId —
  // for a consumable bought repeatedly, originalTransactionId repeats, so
  // keying on it would make every purchase after the first look like a
  // replay and be refused.
  const transactionId = payload.transactionId;
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new ReceiptError("missing_transaction_id");
  }

  // Rule 5: productId comes from the signed payload only, never the request
  // body — same reasoning as verifyGooglePlayReceipt rule 6.
  const productId = payload.productId;
  if (typeof productId !== "string" || productId.length === 0) {
    throw new ReceiptError("missing_product_id");
  }
  if (opts.claimedProductId != null && opts.claimedProductId !== productId) {
    throw new ReceiptError("product_id_mismatch");
  }

  // Rule 6: reject a revoked transaction when the payload carries a
  // revocation field. This is a single-field check, not a revocation sweep
  // (out of scope — see the session file).
  if (payload.revocationDate != null && !opts.allowRevoked) {
    throw new ReceiptError("revoked_transaction");
  }

  return {
    platform: "apple",
    transactionId,
    productId,
    purchaseToken: null,
    purchaseTimeMs:
      typeof payload.purchaseDate === "number" ? payload.purchaseDate : null,
    receiptSha256,
    appleData: {
      environment: payload.environment,
      price: payload.price,
      currency: payload.currency,
      quantity: payload.quantity,
      storefront: payload.storefront,
      revocationDate: payload.revocationDate,
      revocationPercentage: payload.revocationPercentage,
      appAccountToken: payload.appAccountToken,
    },
  };
}
