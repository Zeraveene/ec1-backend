# Classic product contract — 2026-10-22

## Legacy cutover clarification — 2026-10-23

Existing-player sign-in follows EC2's one-time migration lifecycle. Try the native backend first; only a confirmed missing native identity enters verified PlayFab login (`CreateAccount=false`). Preserve the original legacy cloud save, convert it without consulting or replacing current local progress, publish canonical revision 1 idempotently, and establish the durable native identity and completed migration together. Later sign-ins use native authentication with no PlayFab login. A network, provider or database failure is never evidence of a missing account. This initial import of the existing legacy cloud record is the exception to the sign-in-only publication rule below; it never uploads current local progress or restores cloud progress locally. Explicit new-account creation never queries PlayFab.

The user's current decisions supersede the October 9 migration-ranking and always-connected assumptions in the older architecture and implementation documents. This is the target contract; current player code has not yet been adapted or activated.

- Local progress is the active offline game. Launch, Continue and battles need no account, cloud lookup or connectivity. Preserve old data before offline local-format conversion, and never replace failed conversion with a fresh profile silently.
- One optional **Save Backup** window serves title and lobby. It displays **Login to save/load backup data**, can be skipped, and uses small internal loading with responsive Close and unrelated input.
- Opening the backup window may authenticate/refresh and retrieve the latest backup record. It shows Local and Cloud summaries. Signing in alone never uploads or restores progress.
- **Save current progress to cloud** uploads a freshly captured complete local snapshot after the player's choice. **Load cloud data** explicitly restores the selected backup after preserving current local state.
- Warn when uploading a local snapshot with less playtime than Cloud, or restoring a Cloud snapshot with less playtime than Local. Both actions remain available after confirmation. Playtime is advisory, not a rejection rule; no automatic source selection or cloud-wins tie rule.
- Retain immutable backend revisions for developer recovery. Conditional revision checks and idempotency prevent accidental overwrites and duplicate operations; they do not choose progress for the player.
- No automatic gameplay backup upload/download, background sync, cheat detection, duplicate-device enforcement or device-mismatch restrictions. Separate legitimate account-proof validation from device ownership rules.
- Signing out retains local progress. Game-account auth is initiated in the backup menu or through the shared auth window for an explicit purchase; canceling authentication cancels checkout. Personal mail requires login. The October 27 purchase update below supersedes the purchase-login requirement. New purchases do not implicitly create a gameplay backup.
- News and coupons are online-only. Existing owned content remains available offline. Preserve legacy entitlements during migration without claiming they are newly verified store transactions.
- If connectivity is lost during a purchase, retain verification/delivery durably as pending. Online purchase recovery checks may run only in the lobby menu scene, with bounded single-flight retries and no checks in title/bootstrap/battle. Late store callbacks are recorded locally and processed online after returning to lobby. If interactive sign-in is required, keep pending and use the shared auth UI.
- Server-verified purchase facts, reward definitions and durable grant receipts are desired. Offline consumable spending remains local; arbitrary older-backup restores have explicit replay/recovery limits. Grants must not publish a full gameplay backup automatically.
- Keep EC1/EC2 player storage, credentials and title scopes separate. Shared admin identity is a different concern from whether players share accounts.

## Unified administration, initial milestone

The existing EC2 Worker hosts the shared admin application and Discord session. A top-left game selector switches EC2/Classic workspaces without another login. EC1 retains its own Worker and storage, accessed through a narrow private `AdminWorkspace` RPC and current-role lookup through EC2 `AdminAuthority`.

The first local milestone exposes read-only Classic status, players, player details/revisions/mail history and audit. It does not enable paused player features, migrate production accounts, deploy changes or replace the old dashboard yet. Every admin read rechecks central roles; no public caller-provided identity bypass is introduced.

The current Unity-side planning documents live in the sibling `Epic_Conquest/docs/backup-migration/` directory. Reconcile this backend's historical preference dictionary contract with the current canonical Unity save schema before implementing the player-backup phase. Historical Windows paths in older docs are archival references.

## Save lineage ownership — October 25, 2026

Apply migration `032_save_ownership.sql` before enabling the updated manual backup API. Canonical root `ownership` is optional for old clients and immutable legacy records. Modern local saves send `{saveId,playerId,displayName,proof}` with a stable random URL-safe saveId (16–128 characters), initially empty playerId and proof. Authentication alone never claims a local save.

The first successful explicit upload claims its saveId to the authenticated player. The staged, verified R2 snapshot contains backend-stamped ownership; the revision and lineage claim publish in the same D1 batch. A stale revision, failed staging or losing concurrent claim publishes no ownership. Later uploads require matching player identity and a server HMAC proof when playerId is supplied. Omitting playerId/proof cannot reclaim a registered saveId. The legacy_ namespace is reserved to its deterministic account lineage, so stripping proof from a legacy download envelope cannot transfer it before registration. Foreign ownership returns `account_mismatch` (409); invalid proof returns `invalid_ownership_proof` (400). Error `owner` display metadata is provided when the request carries valid signed foreign ownership or the registry recognizes the supplied high-entropy saveId. This lets an unbound client identify the owner after a committed upload whose response was lost. The authenticated upload request and saveId act as a lookup capability; no public owner lookup endpoint exists. The reserved legacy namespace returns a generic mismatch when the owner is unknown. Only saveId, playerId and displayName are returned; no proof or email is returned on mismatch.

All successful upload/latest/download metadata includes signed `ownership`. Download integrity hashes and bytes describe the actual immutable stored payload. Legacy immutable payloads remain unchanged; their response envelope uses a deterministic per-account legacy saveId and the client stamps that envelope only after validating downloaded bytes. Admin exact restore copies its source save_id and original bytes. Signing uses the existing PLAYER_TOKEN_SECRET with an EC1 ownership-specific domain and binds saveId plus playerId; displayName is authoritative player display data and does not authorize anything.

Ownership-less old-client uploads derive a global `unbound_` SHA-256 lineage from stable canonical serialization of the submitted snapshot without ownership. Exact identical legacy saves therefore cannot be claimed by two accounts. Updated clients always preserve their random lineage across progress changes. Request idempotency hashes retain the original submitted snapshot bytes, so server stamping does not break a lost-response retry.

This prevents ordinary cross-account uploads and removing only signed owner fields from known lineage. It does not make offline files tamper-proof: replacing the entire lineage, changing old-client payloads, or copying an unclaimed save before first publication cannot be distinguished reliably from independent offline progress. Local offline play remains available. Preserve existing immutable revisions and migration source archives; do not rewrite them to add ownership.


## Purchase login clarification — October 27, 2026

The user explicitly authorized IAP purchases without signing in. Use a silent purchase-only guest capability when no compatible game account is signed in. Preserve the guest purchase identity through later account sign-in so pending paid operations do not transfer owners. Purchases never create, load, or upload gameplay backups. Guest capability secrets remain outside PlayerPrefs and exported saves. Existing guest identities can recover while new checkout is paused. See the purchase-grant architecture contract for scope and reinstall limitations.
