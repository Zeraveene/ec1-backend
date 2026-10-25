import { Hono, type Context, type Next } from "hono";
import type { AppEnv, Env } from "../env";
import { base64, hash, mac, now } from "./crypto";
import { rateLimit } from "./maintenance";
import { AuthError, providerProof } from "./providers";
import { prepareBrowserClassicProof } from "./legacy-cutover";
import { browserCompletionResponse } from "./browser-completion";

export function browserConfig(env: Env, provider: string) {
  if (provider !== "google" && provider !== "apple" && provider !== "discord") throw new AuthError("unsupported_provider", 400);
  if (provider === "discord") {
    const redirect = env.DISCORD_GAME_REDIRECT_URIS?.split(",").map(s=>s.trim()).find(s=>s.startsWith("https://") && new URL(s).pathname === "/api/auth/discord/callback");
    if (!env.DISCORD_GAME_CLIENT_ID || !env.DISCORD_GAME_CLIENT_SECRET || !redirect) throw new AuthError("provider_not_configured",503);
    return {clientId:env.DISCORD_GAME_CLIENT_ID,redirect};
  }
  const google = provider === "google";
  const clientId = google ? env.GOOGLE_BROWSER_CLIENT_ID : env.APPLE_BROWSER_CLIENT_ID;
  const redirect = google ? env.GOOGLE_BROWSER_REDIRECT_URI : env.APPLE_BROWSER_REDIRECT_URI;
  if (!clientId || !redirect || (google ? !env.GOOGLE_BROWSER_CLIENT_SECRET : !env.APPLE_BROWSER_TEAM_ID || !env.APPLE_BROWSER_KEY_ID || !env.APPLE_BROWSER_PRIVATE_KEY)) throw new AuthError("provider_not_configured", 503);
  let url: URL;
  try { url = new URL(redirect); } catch { throw new AuthError("provider_not_configured", 503); }
  if (url.protocol !== "https:" || url.pathname !== `/api/auth/browser/${provider}/callback` || url.username || url.password || url.search || url.hash) throw new AuthError("provider_not_configured", 503);
  return { clientId, redirect };
}
async function brokerVerifier(env: Env, state: string) { return mac(env.PLAYER_TOKEN_SECRET, `ec1/browser-pkce/v1/${state}`); }
export async function browserAuthorize(env: Env, provider: string, state: string, nonce: string) {
  const config = browserConfig(env, provider);
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirect, response_type: "code", scope: "openid email", state, nonce });
  if (provider !== "apple") { if (provider === "discord") params.set("scope","identify"); params.set("code_challenge", await hash(await brokerVerifier(env, state))); params.set("code_challenge_method", "S256"); if (provider === "google") params.set("prompt", "select_account"); }
  else { params.delete("scope"); params.set("response_mode", "form_post"); }
  return `${provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : provider === "discord" ? "https://discord.com/oauth2/authorize" : "https://appleid.apple.com/auth/authorize"}?${params}`;
}
async function appleSecret(env: Env, clientId: string) {
  const header = base64(JSON.stringify({alg:"ES256",kid:env.APPLE_BROWSER_KEY_ID}));
  const payload = base64(JSON.stringify({iss:env.APPLE_BROWSER_TEAM_ID,iat:now(),exp:now()+300,aud:"https://appleid.apple.com",sub:clientId}));
  try {
    const pem = env.APPLE_BROWSER_PRIVATE_KEY!.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c=>c.charCodeAt(0)), {name:"ECDSA",namedCurve:"P-256"}, false, ["sign"]);
    const signature = await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64(signature)}`;
  } catch { throw new AuthError("provider_not_configured",503); }
}
export function createBrowserAuth() {
  const app = new Hono<AppEnv>();
  app.use("*", async(c,next)=>{ c.header("Cache-Control","no-store"); c.header("Referrer-Policy","no-referrer"); await next(); });
  const callback = async (c: Context<AppEnv>, next: Next) => {
    const provider = c.req.path.endsWith("/discord/callback") ? "discord" : c.req.param("provider")!;
    if (provider === "discord") {
      const state = new URL(c.req.url).searchParams.get("state");
      const browser = state && await c.env.DB.prepare("SELECT id FROM auth_challenge WHERE id=? AND browser_transport=1").bind(state).first();
      if (!browser) return next();
    }
    if (!c.env.PLAYER_TOKEN_SECRET || c.env.PLAYER_TOKEN_SECRET.length < 32) throw new AuthError("auth_not_configured",503);
    await rateLimit(c.env,`browser/${provider}/callback`,c.req.header("CF-Connecting-IP") || "local",30);
    const config = browserConfig(c.env, provider);
    if ((provider === "apple" && c.req.method !== "POST") || (provider !== "apple" && c.req.method !== "GET")) throw new AuthError("invalid_browser_callback",400);
    if (c.req.method === "POST" && !c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) throw new AuthError("invalid_browser_callback",400);
    const raw = c.req.method === "POST" ? await c.req.text() : new URL(c.req.url).search.slice(1);
    if (raw.length > 20000) throw new AuthError("invalid_browser_callback",400);
    const params = new URLSearchParams(raw), state = params.get("state");
    if (["state","code","error"].some(k=>params.getAll(k).length>1) || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AuthError("invalid_browser_callback",400);
    const row = await c.env.DB.prepare("SELECT * FROM auth_challenge WHERE id=? AND provider=? AND browser_transport=1 AND expires_at>? AND used_at IS NULL").bind(state,provider,now()).first<{nonce:string;browser_callback_claimed:number}>();
    if (!row || row.browser_callback_claimed) throw new AuthError("invalid_or_used_challenge",401);
    const claimed = await c.env.DB.prepare("UPDATE auth_challenge SET browser_callback_claimed=1 WHERE id=? AND browser_callback_claimed=0 AND used_at IS NULL AND expires_at>?").bind(state,now()).run();
    if (!claimed.meta.changes) throw new AuthError("invalid_or_used_challenge",401);
    const target = new URL(`gacogames-ec1-bridge://oauth/${provider}`); target.searchParams.set("state",state);
    if (params.has("error")) { await c.env.DB.prepare("UPDATE auth_challenge SET browser_error='access_denied' WHERE id=?").bind(state).run(); target.searchParams.set("error","access_denied"); return browserCompletionResponse(target.toString(),c.req.header("User-Agent")); }
    try {
    const code = params.get("code"); if (!code || code.length>4096) throw new AuthError("invalid_browser_callback",400);
    if (provider === "discord") {
      const subject = await providerProof(c.env,provider,{code,codeVerifier:await brokerVerifier(c.env,state),redirectUri:config.redirect},row.nonce);
      const ticket = await mac(c.env.PLAYER_TOKEN_SECRET,`ec1/browser-ticket/v1/${state}/${subject}`);
      await c.env.DB.prepare("UPDATE auth_challenge SET browser_subject=?,browser_ticket_hash=? WHERE id=? AND expires_at>? AND used_at IS NULL").bind(subject,await hash(ticket),state,now()).run();
      target.searchParams.set("ticket",ticket); return browserCompletionResponse(target.toString(),c.req.header("User-Agent"));
    }
    const form = new URLSearchParams({client_id:config.clientId,client_secret:provider === "google" ? c.env.GOOGLE_BROWSER_CLIENT_SECRET! : await appleSecret(c.env,config.clientId),grant_type:"authorization_code",code,redirect_uri:config.redirect});
    if (provider === "google") form.set("code_verifier",await brokerVerifier(c.env,state));
    let response: Response;
    try { response = await fetch(provider === "google" ? "https://oauth2.googleapis.com/token" : "https://appleid.apple.com/auth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(10000)}); } catch { throw new AuthError("provider_unavailable",503); }
    if (!response.ok) throw new AuthError(response.status>=500 || response.status===429 ? "provider_unavailable" : "invalid_provider_proof",response.status>=500 || response.status===429 ? 503 : 401);
    let token: {id_token?:string;access_token?:string}; try { token = await response.json(); } catch { throw new AuthError("provider_unavailable",503); }
    // Exact browser audience, independently of native app audience configuration.
    const subject = await providerProof({...c.env, GOOGLE_CLIENT_IDS:provider === "google" ? config.clientId : c.env.GOOGLE_CLIENT_IDS,APPLE_CLIENT_IDS:provider === "apple" ? config.clientId : c.env.APPLE_CLIENT_IDS},provider,{idToken:token.id_token},row.nonce);
    if (provider === "google" && c.env.LEGACY_MIGRATION_ENABLED === "true")
      await prepareBrowserClassicProof(c.env, state, subject, token.access_token);
    const ticket = await mac(c.env.PLAYER_TOKEN_SECRET,`ec1/browser-ticket/v1/${state}/${subject}`);
    await c.env.DB.prepare("UPDATE auth_challenge SET browser_subject=?,browser_ticket_hash=? WHERE id=? AND expires_at>? AND used_at IS NULL").bind(subject,await hash(ticket),state,now()).run();
    target.searchParams.set("ticket",ticket); return browserCompletionResponse(target.toString(),c.req.header("User-Agent"));
    } catch (error) {
      const reason = error instanceof AuthError ? error.code : "provider_unavailable";
      await c.env.DB.prepare("UPDATE auth_challenge SET browser_error=? WHERE id=? AND browser_subject IS NULL").bind(reason,state).run();
      target.searchParams.set("error",reason); return browserCompletionResponse(target.toString(),c.req.header("User-Agent"));
    }
  };
  app.on(["GET","POST"], "/browser/:provider/callback", callback);
  app.get("/discord/callback",callback);
  app.post("/browser/:provider/poll",async c=> {
    const provider = c.req.param("provider"); browserConfig(c.env,provider);
    if (!c.env.PLAYER_TOKEN_SECRET || c.env.PLAYER_TOKEN_SECRET.length < 32) throw new AuthError("auth_not_configured",503);
    await rateLimit(c.env,`browser/${provider}/poll`,c.req.header("CF-Connecting-IP") || "local",180);
    const b = await c.req.json<Record<string,unknown>>();
    if (typeof b.challengeId!=="string" || b.state!==b.challengeId || typeof b.codeVerifier!=="string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.codeVerifier)) throw new AuthError("invalid_state_or_pkce",401);
    const row = await c.env.DB.prepare("SELECT code_challenge,browser_subject,browser_error FROM auth_challenge WHERE id=? AND provider=? AND browser_transport=1 AND expires_at>? AND used_at IS NULL").bind(b.challengeId,provider,now()).first<{code_challenge:string;browser_subject:string|null;browser_error:string|null}>();
    if (!row || await hash(b.codeVerifier)!==row.code_challenge) throw new AuthError("invalid_state_or_pkce",401);
    if (row.browser_error) return c.json({state:b.challengeId,error:row.browser_error});
    return c.json(row.browser_subject ? {state:b.challengeId,ticket:await mac(c.env.PLAYER_TOKEN_SECRET,`ec1/browser-ticket/v1/${b.challengeId}/${row.browser_subject}`)} : {pending:true});
  });
  return app;
}
