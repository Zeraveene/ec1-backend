import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let mf;
before(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import worker from './src/index';export default{fetch(request,env,ctx){return worker.fetch(request,{...env,ASSETS:{fetch:async()=>Response.redirect('https://ec1.fixture.invalid/index.html',302)}},ctx)}};`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      d1Databases: { DB: "worker" },
      r2Buckets: ["PLAYER_SAVES", "AUDIT_BLOBS", "LEGACY_ARCHIVE"],
      bindings: {
        PLAYER_TOKEN_SECRET: "synthetic-worker-only-secret-32characters",
        ALLOW_NEW_ACCOUNTS: "false",
        LEGACY_MIGRATION_ENABLED: "false",
      },
      outboundService: () => {
        throw new Error("No external service permitted");
      },
    }),
  );
});
after(async () => await mf?.dispose());
test("immutable bound asset headers can receive security middleware without a dashboard500", async () => {
  const response = await mf.dispatchFetch("https://ec1.fixture.invalid/", {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://ec1.fixture.invalid/index.html",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
test("unknown API routes remain JSON404 and disabled creation/migration do not fall into assets", async () => {
  for (const path of ["/api/missing", "/auth/missing"]) {
    const res = await mf.dispatchFetch(`https://ec1.fixture.invalid${path}`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  }
  const health = await mf.dispatchFetch(
    "https://ec1.fixture.invalid/api/health",
  );
  assert.equal((await health.json()).migrationEnabled, false);
});
