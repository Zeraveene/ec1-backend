# Epic Conquest 1 backend

Independent EC1 Cloudflare Worker, D1 player database, immutable R2 save history, legacy source archives and moderation dashboard. EC2 contributes patterns, not bindings, player rows, signing secrets or store/provider configuration.

## Working locally

Use Node 24. `npm ci`, copy `.env.example` to the ignored `.dev.vars`, and generate two separate random signing secrets. `npm run check` runs strict TypeScript, intercepted/synthetic API integration tests and the dashboard production build. `npm audit` currently reports zero known vulnerabilities across runtime and development dependencies.

Run `npx wrangler d1 migrations apply epicon1-player-data-staging --env staging --local`, then `npx wrangler dev --env staging --local --ip 127.0.0.1 --port 8791`. Local email sending and legacy migration stay disabled. Never enable remote email bindings for synthetic tests.

## Deployment separation

| Resource | Production preparation | Staging |
| --- | --- | --- |
| Worker | `epicon1-backend` | `epicon1-backend-staging` |
| D1 | `epicon1-player-data` | `epicon1-player-data-staging` |
| Save bucket | `epicon1-player-saves` | `epicon1-player-saves-staging` |
| Audit bucket | `epicon1-audit-blobs` | `epicon1-audit-blobs-staging` |
| Source archive bucket | `epicon1-legacy-archive` | `epicon1-legacy-archive-staging` |
| Live domains | `ec1mod.codezrv.com`, `ec1.gacogames.com` | `epicon1-backend-staging.johanesnindyo.workers.dev`; no inherited custom domains |

All resources belong to the existing Cloudflare account. Signing secrets differ by environment and purpose. `secrets/` and `.dev.vars*` are ignored; they must never enter Git, dashboard assets or Unity player builds.

`wrangler.toml` contains explicit resource IDs. Apply migrations to the matching database before deployment. `npm run deploy:staging` runs checks and deploys staging. `npm run deploy` checks and deploys production preparation, where new accounts and migration are disabled by default. Staging allows synthetic new accounts. Neither deployment enables PlayFab migration, purchases or recovery email by itself.

## Account and save guarantees

- New Game and all native account creation are backend-only. Sign-in never creates an account or falls through to PlayFab.
- `native_uninitialized` with version zero is a valid newly created profile. Explicit first New Game save makes it `native_ready`.
- Operation IDs and bootstrap secrets survive retries. Refresh rotation tolerates a lost response with the same operation ID; a changed/reused request cannot claim the successful response.
- Full EC1 snapshots preserve all 99 audited preferences, zero values and unknown harmless fields. Credentials are excluded. The Editor-exported synthetic fixture verifies the C# serialization against the Worker.
- R2 objects are immutable and read back with SHA-256 before a conditional D1 publication. Save, grant receipt, claimed mail and related audit publish in one transaction.
- Migration permits only an explicit legacy read allowlist and noncreating legacy ownership login. No PlayFab saves, mail, statistics, links, passwords, markers or inventory are changed.
- Both source candidates are archived before ranking. Healthy matching-owner gameplay outranks reset/damaged data; greater validated effective playtime wins, PlayFab wins ties. Unproven ownership or entitlements stay in a recoverable hold.
- Migration is incomplete until a source-matching durable native identity can sign in and the verified snapshot is readable. Temporary migration tokens cannot enter normal gameplay routes.

## Administration

Dashboard uses its own Discord OAuth app configuration, EC1 allowlist and secret. Sessions and one-use states are stored in D1; logout revokes the session. Writes require exact Origin, and every consequential admin write has a transactional audit. Missing configuration fails closed.

Player search/detail, save revisions/restore, in-game mail, restrictions, daily rewards, coupons and audit history are implemented. EC1 links to EC2. A reciprocal source change is prepared in the EC2 dashboard; its production deployment remains separate.

## Remaining release gates

The implementation and synthetic tests do not establish signed-device or store readiness. The EC1 PlayFab server secret is provisioned only in production; migration stays paused. Complete the provider registrations/redirects, store verification credentials and signed Android/iOS tests before enabling those features. Verify transactional email delivery before `RECOVERY_ENABLED=true`; tests never send real emails. Prove native creation → first save → app restart → same-profile sign-in on devices before enabling migration for returning players.

See the [implementation results and remaining gates](docs/overnight-results-2026-10-09.md), [auth protocol](docs/auth.md), [save and migration contract](docs/save-contract.md), and the Unity project's `docs/ec1-backend-migration-plan.md` and client handoff for detailed decisions and outstanding work.

## Dependency note

Cloudflare's published Wrangler `4.149.0` depends on Miniflare `5.20261006.1-alpha`; the exact matching runtime is pinned. Tests use its documented `convertV4MiniflareOptions` helper. Vite 7 and Hono 4 use patched versions. This repository does not change EC2's dependency set.
