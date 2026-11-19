# Account-open GPGS login and migration

`src/auth/gpgs-legacy.ts` owns the optional Android account-open attempt after
normal native session refresh and only when GPGS is already authenticated. The
client does not show a GPGS account chooser. It calls unauthenticated
`POST /api/auth/gpgs/legacy` with `{operationId,serverAuthCode,
playFabServerAuthCode}` (two distinct fresh codes). After Google application
verification, an existing `gpgs` identity or `gpgs:<id>` source claim signs into
its native owner without any PlayFab call. This includes sources previously
recovered manually to a different native account.

Otherwise the server verifies the linked PlayFab source using the shared
[recovery proof and source workflow](legacy-recovery.md). A published PlayFab
claim signs into its existing destination. A verified original PlayFab ID that
already owns a cloud backup is also used without changing that backup. A usable
unclaimed legacy save is archived, converted and published with its native
player, `gpgs` identity, ownership and all source claims in one atomic transaction.
This is verified migration and does not depend on `ALLOW_NEW_ACCOUNTS`. PlayFab
IDs are retained; Saved Games-only migrations use an EC1G-prefixed deterministic
ID. Migration 037 is required; no additional schema migration is needed.

Success returns `{status:"authenticated",playerId,accessToken,refreshToken,
expiresIn,saveState,saveVersion}` using the normal native session implementation.
If no PlayFab source save exists, the response is
`{status:"google_saved_games_required",recoveryToken}`. **No native player or
identity is created in this case.** If the historical `savegame` slot is also
absent, the client simply shows normal login/create options. Positive Saved
Games bytes may be sent to `POST /api/auth/gpgs/legacy/google` with
`{operationId,recoveryToken,rawSaveJson,legacyPlaytime?}` to publish migration and
obtain the same authenticated response. This ten-minute capability has its own
signing domain and cannot be used with signed-in manual recovery endpoints.
Identical fallback retries return the same native session; later sign-ins use
fresh provider proof. Tokens, OAuth codes and lookup credentials are not archived.

Source conflicts, malformed data, provider/storage failures and bans never mean
"no account." Concurrent migration/upload attempts cannot replace an existing
cloud snapshot. Existing identity/claim owners are rechecked at identity/session
publication, and native bans block login. The public routes inherit auth IP
rate limiting before provider calls and additionally limit verified subjects.
No route restores or uploads the device's active local progress.

Configuration is shared with manual recovery. Known GPGS/native owners need only
working Google proof verification; new migration also needs the enabled legacy
and manual-backup flags and EC1 PlayFab configuration. The Google web OAuth
client/secret and application ID must match Android and the PlayFab Google add-on.

For genuinely absent PlayFab accounts, independent lookup of the verified GPGS
ID is mandatory to prevent mixing two people's OAuth codes. The official
[PlayFab Server API specification](https://github.com/PlayFab/API_Specs/blob/master/Swagger/PlayFab/Server.swagger.json)
contains no Google/PlayGames mapping endpoint; the read-only mapping is exposed
through the Client API and requires a client session. To avoid an expiring
operator-supplied session, configure `PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID` as a
Worker secret for an explicitly selected, **pre-existing** EC1 lookup account.
The backend uses `Client/LoginWithCustomID` with `CreateAccount:false`, rejects
newly-created responses, and keeps its returned session only in memory for the
mapping request. It never creates/links lookup accounts or changes their data.
An invalid CustomID fails closed. If this secret is absent, the previously
supported `PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET` is used and still requires
operator renewal when expired. No-account Saved Games migration is unavailable
until one of these safe lookup credentials is configured.

Provider-link changes outside this system cannot be transacted with D1; the
source-identity limitations documented in manual recovery still apply.
