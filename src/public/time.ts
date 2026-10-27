import { Hono } from "hono";
import type { AppEnv } from "../env";

/** Account-independent UTC clock for local daily rewards and countdowns. */
export function createTimeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/time", (c) => {
    const now = Date.now();
    return c.json(
      { serverTime: new Date(now).toISOString(), unixTimeMs: now },
      200,
      { "Cache-Control": "no-store" },
    );
  });
  return app;
}
