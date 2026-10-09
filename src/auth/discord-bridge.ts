import { Hono } from "hono";
import type { AppEnv } from "../env";
import { now } from "./crypto";

// Browser authorization returns here; the game retains the PKCE verifier and
// submits the proof through the existing provider route. No session is minted here.
export function createDiscordBridge() {
  const app = new Hono<AppEnv>();
  app.get("/discord/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const url = new URL(c.req.url);
    const query = url.searchParams;
    const state = query.get("state");
    const code = query.get("code");
    const error = query.get("error");
    if (
      ["state", "code", "error"].some((key) => query.getAll(key).length > 1) ||
      !state || !/^[A-Za-z0-9_-]{20,128}$/.test(state) ||
      (!code && !error) || (code !== null && error !== null) ||
      (code !== null && (code.length > 2048 || /[\x00-\x1f\x7f]/.test(code))) ||
      (error !== null && !/^[A-Za-z0-9_]{1,100}$/.test(error))
    ) return c.json({ error: "invalid_discord_callback" }, 400);

    const callback = `${url.origin}/api/auth/discord/callback`;
    if (!c.env.DISCORD_GAME_REDIRECT_URIS?.split(",").map((s) => s.trim()).includes(callback))
      return c.json({ error: "invalid_discord_callback" }, 400);
    const pending = await c.env.DB.prepare(
      "SELECT provider,redirect_uri,expires_at,used_at FROM auth_challenge WHERE id=?",
    ).bind(state).first<{ provider: string; redirect_uri: string | null; expires_at: number; used_at: number | null }>();
    if (!pending || pending.provider !== "discord" || pending.redirect_uri !== callback ||
        pending.expires_at <= now() || pending.used_at !== null)
      return c.json({ error: "invalid_or_used_challenge" }, 401);

    const target = new URL("gacogames-ec1-bridge://oauth/discord");
    target.searchParams.set("state", state);
    if (code) target.searchParams.set("code", code);
    if (error) target.searchParams.set("error", error);
    return c.redirect(target.toString(), 302);
  });
  return app;
}
