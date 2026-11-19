# Explicit GPGS legacy recovery

The optional account-open flow reuses these modules; see
[GPGS login and migration](gpgs-legacy-signin.md) for its separate public routes.

The signed-in player's Save Backup window may recover only while that player has
no canonical or historical cloud revision. This operation never loads a local
save, changes native identities, or writes PlayFab data. An empty legacy login
cutover is eligible even when `player.migrated_at` is set.

`POST /api/game/backups/legacy-recovery` accepts `{operationId, serverAuthCode,
playFabServerAuthCode}` with a normal player bearer session. The codes must be
fresh and distinct. The first is exchanged against the configured Google web
client and verified through the configured Play Games application. The second
uses **LoginWithGooglePlayGamesServices**, always `CreateAccount:false`. The
returned account's `GooglePlayGamesInfo.GooglePlayGamesPlayerId` must match the
verified application player. GoogleAccount is intentionally not used: Google
and GPGS can link to different legacy PlayFab accounts.

A valid source returns `{playerId,status:"recovered",revision:1,...backupMetadata}`.
A confirmed missing account or missing `CLOUD_ALL_DATA` key returns
`{playerId,status:"google_saved_games_required",recoveryToken}`. Network/provider
failures, malformed present core data, bans, pending legacy mail and unsupported
inventory are errors, never absence.

The client may read its historical Google Saved Games `savegame` slot and submit
`POST /api/game/backups/legacy-recovery/google` with `{operationId,recoveryToken,
rawSaveJson,legacyPlaytime?}` (playtime is numeric seconds). The token expires in
ten minutes and binds the destination, operation, verified GPGS identity and any
known PlayFab source. The server archives bytes before using the existing legacy
converter. This fallback authenticates ownership of the GPGS account; client
snapshot bytes are not server-attested Google storage bytes. There is no local
save import or upload endpoint in this flow.

Apply migration `037_legacy_recovery.sql` before activation. It creates atomic
source claims and replay receipts, backfills previously published PlayFab
migrations, and installs reciprocal guards on classic/admin/historical migration
publication. Both `gpgs:<id>` and any known `playfab:<id>` are claimed in the same
D1 batch as the first revision/head/ownership, only after immutable R2 staging
and readback. An existing backup or a competing upload wins without overwrite.
Archives and staged orphan objects are retained when publication fails.

Required configuration: `EC1_MANUAL_BACKUPS_ENABLED=true`,
`LEGACY_MIGRATION_ENABLED=true`, existing PlayFab EC1 credentials, and
`GPGS_RECOVERY_CLIENT_ID`, `GPGS_RECOVERY_CLIENT_SECRET`,
`GPGS_RECOVERY_APPLICATION_ID`. The Google web credential must agree with the
device configuration and PlayFab Google add-on. Never share EC2 credentials.

Configuration example (placeholders only; secrets belong in Worker secret
storage, not this file or `wrangler.toml`):

```text
GPGS_RECOVERY_APPLICATION_ID=<EC1 Play Games application ID>
GPGS_RECOVERY_CLIENT_ID=<EC1 web OAuth client ID>
GPGS_RECOVERY_CLIENT_SECRET=<Worker secret>
PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET=<optional maintained Worker secret>
PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID=<optional pre-existing lookup account secret>
```

**No-account fallback prerequisite:** configure either a pre-existing EC1 lookup
account's `PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID` or an existing authorized
`PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET`, stored as Worker secrets. The CustomID
option obtains a transient session with `LoginWithCustomID`, always
`CreateAccount:false`; no lookup account is created or linked. An invalid
CustomID fails closed. When
the second code yields `AccountNotFound`, the server independently resolves the
first verified GPGS identity with the read-only
`Client/GetPlayFabIDsFromGooglePlayGamesPlayerIDs` API. This prevents mixed codes
from bypassing a prior migration. If that lookup finds an account, its verified
source is read normally. Missing, expired, failed or malformed lookup responses
fail closed; they do not enable Saved Games fallback. This session expires and
requires operator renewal when only the ticket option is configured. Successful
GPGS login and verified empty-account
fallback do not depend on this extra session. Thus no-account fallback is not
operationally ready until the secret is configured and maintained.

Claims cover verified source identities at recovery time. External PlayFab link
changes after proof issuance cannot be transacted atomically with D1. In
particular, a genuinely absent PlayFab source later linked to the GPGS account
has no known PlayFab alias in the earlier Saved Games claim. Avoid changing
legacy provider links during recovery; account-link repair remains an explicit
operator task, not a feature of this endpoint.

Official references: [PlayFab GPGS login](https://learn.microsoft.com/en-us/rest/api/playfab/client/authentication/login-with-google-play-games-services?view=playfab-rest),
[PlayFab identity lookup](https://learn.microsoft.com/en-us/rest/api/playfab/client/account-management/get-playfab-ids-from-google-play-games-player-ids?view=playfab-rest),
[Google application verification](https://developer.android.com/games/services/web/api/rest/v1/applications/verify).
