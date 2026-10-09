# EC1 backend implementation handoff

Follow-up at 09:21 Jakarta: EC1 admin authentication now uses EC2's live whitelist and existing Discord app through a private authority. Both deployments and reciprocal dashboard links are updated. The original overnight snapshot below remains historical; see `docs/shared-admin-auth.md` for the current admin setup, deployment versions and callback registration step.

EC1 now has an independent backend repository at `E:/Epic Conquest/ec1-backend`, staging resources and a production preparation deployment under the existing Cloudflare account. The Unity client has an opt-in backend path. Returning players have not been migrated, and the shipping game's default backend flag remains off.

The original EC1 plan was committed as `ffde4e36` before implementation. EC2 backend `6611622` and Unity `b457e3e2` were clean reference baselines. Backend scaffold `4304136` and foundation `4e0a86c` preserve the initial implementation checkpoints; the complete backend implementation is `c577ae2`, followed by creation-proof expiry/recovery hardening in `4ffff18`. EC1 client implementation is committed as `59645e09` on `codex/ec1-backend-migration`; the reciprocal EC2 dashboard link is committed as `fc036ef` on `codex/ec1-moderation-link`.

## Provisioned resources

| Purpose | Production preparation | Staging |
| --- | --- | --- |
| Worker | `epicon1-backend` | `epicon1-backend-staging` |
| D1 | `epicon1-player-data` | `epicon1-player-data-staging` |
| Save history R2 | `epicon1-player-saves` | `epicon1-player-saves-staging` |
| Audit R2 | `epicon1-audit-blobs` | `epicon1-audit-blobs-staging` |
| Original source R2 | `epicon1-legacy-archive` | `epicon1-legacy-archive-staging` |
| Moderation/API | [EC1 moderation](https://ec1mod.codezrv.com), [EC1 API](https://ec1.gacogames.com) | [EC1 staging](https://epicon1-backend-staging.johanesnindyo.workers.dev) |

D1 resource IDs and bucket bindings are in `wrangler.toml`. Signing secrets are distinct for EC1, environments and player/admin purposes. Private local secret files and synthetic smoke credentials are ignored by Git. There are no EC2 player/database/bucket bindings in this deployment.

Final deployment versions: staging `9a3b58b7-7375-4cba-880d-4d03268b7e7e`; production `9f71fc99-235a-4673-9a77-4d6b8e57a83a`. Both include the final creation-proof hardening. The staging smoke passed at `2026-10-08T20:20:34Z` and production preflight at `2026-10-08T20:20:37Z` (2026-10-09 03:20 Jakarta).

Production creation, legacy migration, purchases and recovery email are paused. Staging permits synthetic account creation but keeps legacy migration, purchases and email paused. Administrator login fails closed until an EC1 Discord configuration and allowlist are supplied. The EC1 dashboard links to EC2; the reciprocal EC2 link is a source change awaiting its separate deployment.

The existing EC1 title `3BFE7` server key was read through the Editor, transferred only into the ignored production secret file and uploaded to the EC1 production Worker secret store. It was never printed, committed or copied into staging. No live PlayFab account was accessed, and migration remains paused.

## Implemented behavior

- Explicit backend creation, sign-in and linking; valid new account version zero, full first save and same-profile restart. Email/password, Google/Apple token verification and Discord PKCE/state flows have separate intent handling. Provider cancellation, unavailable configuration and account-not-found never start PlayFab creation. The backend build define enforces this boundary even before manager initialization or when scene configuration is missing.
- Native device credentials bind during explicit guest creation or a verified CustomID migration. Device sign-in never creates an account and survives refresh-token expiry. Legacy device IDs are ownership hints, separate from randomly generated installation secrets. Password reset revokes both sessions and device credentials.
- Windows DPAPI, Android Keystore and iOS Keychain session storage; durable account-scoped save journals, original backups, uncertain-operation replay and serialized save/grant publication.
- A complete 99-field native EC1 snapshot, compatible with the historical 60-field PlayFab payload, plus harmless unknown fields. The synthetic fresh-save fixture and 41-item catalogue were exported through Unity Editor APIs from static game resources.
- Immutable R2 bytes with SHA-256 readback before conditional D1 publication. Save revisions, grants, mail claims, purchases and restoration audits use the same publication protocol.
- Read-only ownership proof and PlayFab source access. Both cloud/device originals are archived before ranking. Actual healthy progression wins over reset/paid-flag-only data; validated effective playtime ranks healthy candidates, and PlayFab wins ties. Verified entitlements are preserved independently. Unknown inventory or mail formats enter recovery review rather than an empty import.
- Account-specific inbox, daily rewards, coupons, Fortress leaderboard and display names. Attendance keeps its rolling 24-hour cooldown; quest, booster, hunger and challenge allowances reset once per UTC day using a persisted server receipt. The client grant handler is connected; a full player-facing inbox title/body reader is still a UI task.
- Server purchase provenance/account binding, pending ledger, one-time entitlements and atomic full-save delivery. Store confirmation requires a committed and imported matching profile. Old unbound purchases remain a support case.
- Moderation search/detail, linked identities, save history and audited restore, restrictions, in-game mail, daily schedule, coupons and audit history. Mail/restore request identities survive a lost response during an in-page retry.
- Native email password reset with generic request acceptance, hashed single-use tokens, expiry/rate limits and atomic credential/session/device/bootstrap revocation. Creation retry proofs expire after 120 seconds; expired-session cleanup cannot turn them into sign-in credentials. Delivery remains disabled until verified.
- Backend builds suppress GPGS authentication/cloud saves/achievement UI and remove its native dependency/module/automatic initializer from the generated Android build. Packaged manifest and DEX inspection confirmed the exclusion; no migration bridge is required for the old GPGS cohort. Existing legacy code/assets remain available to builds without the backend define until shipping cleanup.

## Setup needed before a player release

| Gate | Concrete requirement |
| --- | --- |
| Google | EC1 OAuth audiences/web client ID, Android package `com.gacogames.epiccon` and actual signing fingerprints, iOS public IDs/URL scheme; signed-device nonce and callback tests |
| Discord player login | EC1 application/client settings and redirect registration, [official Social SDK download through the developer portal](https://github.com/discord/social-sdk-unity-sample#setup-instructions), conditional native adapter compilation and signed-device tests. The available browser session is signed out of the portal |
| Apple | EC1 audience and iOS entitlement/provisioning, native callback and Keychain tests on a Mac/iPhone; Android Apple login is deferred |
| Moderation access | EC1 Discord admin app/client secret, registered callback at `https://ec1mod.codezrv.com/auth/discord/callback`, explicit administrator IDs |
| Legacy source | EC1 title `3BFE7` secret is provisioned; controlled owned account/device tests remain. Returning Google proof needs a genuine legacy server authorization code; Android authorization-code acquisition remains pending |
| Store verification | EC1 Google licensing public key and scoped Android Publisher service account; Google/Apple sandbox purchase, redelivery, restore and interrupted-confirm tests |
| Email accounts/recovery | Registration email verification remains a release task. Verify Cloudflare Email Sending domain and actual recipient delivery, reset, expiry and session/device/bootstrap revocation before enabling recovery |
| Client UI | Editor bindings and visual validation for new provider, migration and recovery actions; full inbox reader. No scenes/prefabs were rewritten by hand |
| Offline play | Cold-start restoration needs its own validation; current durable checkpoints alone do not certify offline startup |
| Release | Validate signed Android ARM64/IL2CPP and iOS builds/devices, configure the title manager for the intended backend origin and enable features gradually. The development APK already excludes GPGS native code; remove obsolete source/scene references when retiring the legacy build. No store upload has been performed |

Configure secrets through Wrangler/Cloudflare's secret store, never through committed `.env` files or Unity gameplay preferences. `.env.example`, `docs/auth.md`, `docs/purchases.md`, `docs/save-contract.md` and the Unity project's `docs/ec1-backend-client.md` provide the exact contracts and public build configuration names.

The original EC1 Google implementation uses `LoginWithGoogleAccount` for sign-in but `LinkGooglePlayGamesServicesAccount` for linking. PlayFab's `GoogleInfo.GoogleId` and `GooglePlayGamesInfo.GooglePlayGamesPlayerId` are distinct identifiers; migration never treats them as interchangeable. Android CredentialManager returns a modern ID token, not the authorization code accepted by legacy PlayFab login. A supported legacy Google proof must use the existing PlayFab-configured web client, a genuine server authorization code, and explicit `CreateAccount:false`; its verified Google account must then match the native Google subject. Games-only legacy profiles need email/device ownership proof or support before adding modern Google. References: [PlayFab account schema](https://learn.microsoft.com/en-us/rest/api/playfab/client/account-management/get-account-info?view=playfab-rest), [Android authorization](https://developer.android.com/identity/authorization), [iOS offline access](https://developers.google.com/identity/sign-in/ios/offline-access), [PlayFab Google login](https://learn.microsoft.com/en-us/rest/api/playfab/client/authentication/login-with-google-account?view=playfab-rest).

## Validation and continuation

The backend integration suite intercepts external services and uses isolated synthetic D1/R2/player data. `npm run check` covers strict TypeScript, those tests and the dashboard build; `npm audit` checks runtime and development dependencies. `scripts/staging-smoke.mjs` exercises a real staging guest/email create-save-restart sequence using the actual Unity fixture. `scripts/deployment-preflight.mjs` checks paused production features, dashboard assets/security headers and rejection of staging tokens on every production host.

Completed backend validation: strict TypeScript, **53 integration tests**, the dashboard production build and **zero known dependency vulnerabilities**. The live staging smoke used the actual 99-field Unity fixture and passed guest creation, exact creation retry, valid version-zero readiness, first save/retry, durable device sign-in, email linking, logout/restart/sign-in, refresh replay and daily-reset/replay with progress and entitlements preserved. The final synthetic profile was `EC1XLDOD3NU5ZECGAX1RGAQXZMHN`, at save version 2; fixture SHA-256 was `bbc6156b90b82543c902b89efa9b184d143921561800136da0f184490b327495`. No player data was used. The production preflight passed on all three production origins and rejected a staging token on each. Machine-readable evidence is in ignored `output/staging-smoke-latest.json` and `output/deployment-preflight-latest.json`; their separate credentials file must remain private.

Unity's `EC1BackendEditorChecks.Run` passed **101 assertions**, plus **14 purchase helper checks**. It covers synthetic account/save/migration/provider/purchase/journal behavior and an actual gated manager with a PlayFab SDK outbound counter. It is distinct from provider, Java/Objective-C compilation, signed-device and store certification. Android build evidence is recorded with the client handoff.

The backend-gated Android development APK compiled successfully with native JNI Java and Gradle. It is a Mono ARMv7/debug artifact at `E:/Epic Conquest/Epic Conquest 1/Epic_Conquest/Builds/Android/ec1-backend-development-validation.apk` (226,899,768 bytes). Manifest/DEX inspection found no Play Games initializer, SDK or bridge markers. An exact production EC1 server-key scan over all decompressed entries in UTF-8/UTF-16 found no key bytes. Generated lighting/reflection/addressables output and temporary build settings were restored; no release-signing or store upload occurred. Logs are ignored under the Unity project's `Logs/ec1-backend-checks-final.log` and `Logs/ec1-backend-android-final.log`.

Next session should start with the provider/admin configuration and signed-device gates above, then controlled returning-account migration tests. Keep PlayFab immutable throughout. A native account with no initial cloud save is not a migration failure and must never cause a PlayFab fallback.
