import type { Env } from "../env";
import { decode, hash, now } from "./crypto";
export class AuthError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400,
  ) {
    super(code);
  }
}
// Provider email is display metadata only; provider + subject remains the identity key.
export interface ProviderProof { subject: string; email: string | null }
function verifiedEmail(value: unknown, verified: unknown): string | null {
  if (verified !== true && verified !== "true") return null;
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export async function providerProof(
  env: Env,
  provider: string,
  input: Record<string, unknown>,
  nonce: string,
): Promise<ProviderProof> {
  let exchangedGoogleCode = false;
  // Editor code flow exchanges only on the server, then uses the same signed JWT,
  // audience and per-attempt nonce verification as the native Google path.
  if (provider === "google" && input.code != null) {
    if (
      !env.GOOGLE_EDITOR_CLIENT_ID ||
      !env.GOOGLE_EDITOR_CLIENT_SECRET ||
      !env.GOOGLE_CLIENT_IDS?.split(",")
        .map((s) => s.trim())
        .includes(env.GOOGLE_EDITOR_CLIENT_ID)
    )
      throw new AuthError("provider_not_configured", 503);
    if (
      typeof input.code !== "string" ||
      !input.code ||
      input.code.length > 4096 ||
      typeof input.codeVerifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
      typeof input.redirectUri !== "string" ||
      !env.GOOGLE_EDITOR_REDIRECT_URIS?.split(",")
        .map((s) => s.trim())
        .includes(input.redirectUri)
    )
      throw new AuthError("invalid_provider_proof", 401);
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_EDITOR_CLIENT_ID,
          client_secret: env.GOOGLE_EDITOR_CLIENT_SECRET,
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
        }),
      });
    } catch {
      throw new AuthError("provider_unavailable", 503);
    }
    if (!response.ok)
      throw new AuthError(
        response.status >= 500 || response.status === 429
          ? "provider_unavailable"
          : "invalid_provider_proof",
        response.status >= 500 || response.status === 429 ? 503 : 401,
      );
    let result: { id_token?: string };
    try {
      result = await response.json();
    } catch {
      throw new AuthError("provider_unavailable", 503);
    }
    if (!result.id_token) throw new AuthError("invalid_provider_proof", 401);
    input = { ...input, idToken: result.id_token };
    exchangedGoogleCode = true;
  }
  if (provider === "discord") {
    if (
      !env.DISCORD_GAME_CLIENT_ID ||
      !env.DISCORD_GAME_CLIENT_SECRET ||
      !env.DISCORD_GAME_REDIRECT_URIS
    )
      throw new AuthError("provider_not_configured", 503);
    const redirect = String(input.redirectUri || "");
    if (
      !env.DISCORD_GAME_REDIRECT_URIS.split(",")
        .map((s) => s.trim())
        .includes(redirect)
    )
      throw new AuthError("invalid_redirect");
    if (
      typeof input.code !== "string" ||
      typeof input.codeVerifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
    )
      throw new AuthError("invalid_provider_proof");
    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_GAME_CLIENT_ID,
        client_secret: env.DISCORD_GAME_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: redirect,
      }),
    });
    if (!response.ok)
      throw new AuthError(
        response.status >= 500 || response.status === 429
          ? "provider_unavailable"
          : "invalid_provider_proof",
        response.status >= 500 || response.status === 429 ? 503 : 401,
      );
    const token = (await response.json()) as { access_token?: string };
    if (!token.access_token) throw new AuthError("provider_unavailable", 503);
    const me = await fetch("https://discord.com/api/users/@me", {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!me.ok) throw new AuthError("provider_unavailable", 503);
    const user = (await me.json()) as { id?: string; email?: string; verified?: boolean };
    if (!user.id) throw new AuthError("invalid_provider_proof", 401);
    return { subject: user.id, email: verifiedEmail(user.email, user.verified) };
  }
  if (provider !== "google" && provider !== "apple")
    throw new AuthError("unsupported_provider");
  const audiences = (
    provider === "google" ? env.GOOGLE_CLIENT_IDS : env.APPLE_CLIENT_IDS
  )
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!audiences?.length) throw new AuthError("provider_not_configured", 503);
  if (typeof input.idToken !== "string" || input.idToken.length > 16000)
    throw new AuthError("invalid_provider_proof", 401);
  try {
    const parts = input.idToken.split(".");
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (header.alg !== "RS256" || typeof header.kid !== "string")
      throw new Error();
    const response = await fetch(
      provider === "google"
        ? "https://www.googleapis.com/oauth2/v3/certs"
        : "https://appleid.apple.com/auth/keys",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new AuthError("provider_unavailable", 503);
    let jwks: { keys: (JsonWebKey & { kid: string })[] };
    try {
      jwks = (await response.json()) as typeof jwks;
      if (!Array.isArray(jwks.keys)) throw new Error();
    } catch {
      throw new AuthError("provider_unavailable", 503);
    }
    const jwk = jwks.keys.find(
      (k) =>
        k.kid === header.kid &&
        k.kty === "RSA" &&
        (!k.alg || k.alg === "RS256"),
    );
    if (!jwk) throw new Error();
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      throw new Error();
    const issuers =
      provider === "google"
        ? ["accounts.google.com", "https://accounts.google.com"]
        : ["https://appleid.apple.com"];
    if (
      !issuers.includes(payload.iss) ||
      !audiences.includes(payload.aud) ||
      (exchangedGoogleCode && payload.aud !== env.GOOGLE_EDITOR_CLIENT_ID) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      payload.exp <= now() ||
      typeof payload.iat !== "number" ||
      payload.iat > now() + 30 ||
      (payload.nbf && payload.nbf > now() + 30) ||
      payload.nonce !== nonce
    )
      throw new Error();
    return { subject: payload.sub, email: verifiedEmail(payload.email, payload.email_verified) };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (
      error instanceof TypeError ||
      (error instanceof DOMException &&
        ["TimeoutError", "AbortError"].includes(error.name))
    )
      throw new AuthError("provider_unavailable", 503);
    throw new AuthError("invalid_provider_proof", 401);
  }
}
export { hash };
