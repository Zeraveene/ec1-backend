import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./env";
import { createAuthApp, cleanupAuthState } from "./auth";
import { createGameApp } from "./game";
import { createAdminApp, createAdminAuthApp, cleanupAdminState } from "./admin";
import { createRecoveryApp } from "./recovery";
import { createPurchasesApp } from "./purchases";

const app = new Hono<AppEnv>();
app.use("*", secureHeaders());
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: "request_too_large" }, 413),
  }),
);
app.get("/api/health", (c) =>
  c.json({
    game: "ec1",
    status: "ok",
    environment: c.env.ENVIRONMENT ?? "local",
    migrationEnabled: c.env.LEGACY_MIGRATION_ENABLED === "true",
    newAccountsEnabled: c.env.ALLOW_NEW_ACCOUNTS === "true",
    purchasesEnabled: c.env.IAP_PURCHASES_ENABLED === "true",
    recoveryEnabled: c.env.RECOVERY_ENABLED === "true",
  }),
);
app.route("/api/auth", createAuthApp());
app.route("/api/recovery", createRecoveryApp());
app.route("/api/purchases", createPurchasesApp());
app.route("/api/game", createGameApp());
app.route("/auth", createAdminAuthApp());
app.route("/api/admin", createAdminApp());
app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/"))
    return c.json({ error: "not_found" }, 404);
  if (c.env.ASSETS) {
    // Bound asset responses have immutable headers; middleware needs a mutable response.
    const assets = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(assets.body, {
      status: assets.status,
      statusText: assets.statusText,
      headers: new Headers(assets.headers),
    });
  }
  return c.text("EC1 backend. Dashboard assets have not been built.", 200);
});
app.onError((error, c) => {
  const requestId = crypto.randomUUID();
  console.error(
    JSON.stringify({
      event: "request_failed",
      requestId,
      name: error.name,
      path: c.req.path,
    }),
  );
  return c.json({ error: "internal_error", requestId }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    await cleanupAuthState(env);
    await cleanupAdminState(env);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM recovery_rate WHERE bucket IN (SELECT bucket FROM recovery_rate WHERE expires_at<? LIMIT 100)",
      ).bind(Math.floor(Date.now() / 1000)),
      env.DB.prepare(
        "DELETE FROM password_recovery WHERE token_hash IN (SELECT token_hash FROM password_recovery WHERE expires_at<? LIMIT 100)",
      ).bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  },
};
