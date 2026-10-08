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
export async function providerProof(
  env: Env,
  provider: string,
  input: Record<string, unknown>,
  nonce: string,
): Promise<string> {
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
    const user = (await me.json()) as { id?: string };
    if (!user.id) throw new AuthError("invalid_provider_proof", 401);
    return user.id;
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
    return payload.sub;
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
