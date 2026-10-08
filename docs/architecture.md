# EC1 implementation contract

The user delegated implementation decisions and authorized Sol 6.1 subagents at medium effort on 2026-10-09. The EC1 plan was committed first as `ffde4e36` in the Unity project. This repository is an independent Worker plus admin dashboard, using the EC2 TypeScript/Hono/D1/R2/React baseline. Defaults are accepted under that delegation: separate repository, legacy IDs retained for migrated players, new IDs prefixed EC1X, healthy effective-playtime selection with cloud winning ties, and native Apple on iOS initially.

Read `E:/Epic Conquest/Epic Conquest 1/Epic_Conquest/docs/ec1-backend-migration-plan.md` for requirements. PlayFab is an immutable migration source: no data, mail, marker, identity, account, inventory, statistic or credential mutations. New players make ZERO PlayFab requests. Migration remains disabled by default until ownership/device tests pass. Never deploy a Unity/store release or migrate real players during initial autonomous setup.

## Shared contracts

- `src/env.ts` owns Worker bindings and request context. Auth sets `c.get('player')` to PlayerContext, and exports `requirePlayer` middleware.
- `src/auth/index.ts` exports `createAuthApp()` mounted at `/api/auth`. Owns authentication/session/provider/linking routes and `migrations/001_auth.sql`.
- `src/game/index.ts` exports `createGameApp()` mounted at `/api/game`. Owns whole saves, safe grants, daily/coupons/mail, read-only migration and `migrations/002_game.sql`. Auth middleware applies on the game subapp; migration scopes only reach migration/readiness operations.
- Common player table is `player`: `id TEXT PRIMARY KEY`, `display_name TEXT`, `save_version INTEGER DEFAULT 0`, `playtime REAL DEFAULT 0`, `save_state TEXT DEFAULT 'native_uninitialized'`, `device_id TEXT`, `created_at INTEGER`, `updated_at INTEGER`, `migrated_at INTEGER`. Auth creates it; all save writers conditional on `save_version`.
- Snapshot envelope: `{game:'ec1',schemaVersion:1,playtime:number,data:Record<string,string>,expectedSaveVersion:number,operationId:string,deviceId?:string}`. `data.CLOUD_ALL_DATA` is the full EC1 SaveData.ToJson preference dictionary JSON; `data.Playtime` is legacy captured time. Preserve valid unknown data. Backend session determines player identity.
- Save result: `{playerId,saveVersion,playtime,data,saveState,operationId}` as applicable. Auth result: `{playerId,accessToken,refreshToken,expiresIn,saveState,saveVersion}`. Error: `{error:string,reason?:string,retryAfterSeconds?:number}`.
- Save publication stages R2 immutable bytes/readback and conditionally publishes D1 rows. No claim completes until its save/grant publication succeeds. Operation IDs alone are not authentication.
- `src/admin` and `web` are owned by the coordinating agent. Dashboard has independent admin auth and never receives player/provider secrets. No public setup/admin master key flow.
- Tests use isolated Miniflare D1/R2, synthetic profiles and intercepted outbound calls. Fail tests on any PlayFab mutation or any new-user PlayFab request.
- Root coordinates shared configuration, deployment, integration, and commits. Agents edit only their owned paths and do not commit shared work without coordination.

## Platform and release state

Keep actual Unity/cloud rollout separate from local compilation. Feature activation in the Unity client is gated until server/client integration checks pass; migrations need controlled legacy account/device checks. Provider credentials may be absent; unconfigured methods return actionable typed errors, never a PlayFab fallback. No user passwords/tokens/keys belong in commits or diagnostics.

Versions are pinned to inspected EC2 baseline rather than claimed newest. Official runtime guidance checked 2026-10-09: https://hono.dev/docs/getting-started/cloudflare-workers, https://developers.cloudflare.com/d1/worker-api/d1-database/, https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.
