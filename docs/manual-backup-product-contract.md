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
- Signing out retains local progress. Game-account auth is initiated in the backup menu or through the shared auth window for an explicit purchase; canceling authentication cancels checkout. Personal mail and purchases require login. New purchases do not implicitly create a gameplay backup.
- News and coupons are online-only. Existing owned content remains available offline. Preserve legacy entitlements during migration without claiming they are newly verified store transactions.
- If connectivity is lost during a purchase, retain verification/delivery durably as pending. Online purchase recovery checks may run only in the lobby menu scene, with bounded single-flight retries and no checks in title/bootstrap/battle. Late store callbacks are recorded locally and processed online after returning to lobby. If interactive sign-in is required, keep pending and use the shared auth UI.
- Server-verified purchase facts, reward definitions and durable grant receipts are desired. Offline consumable spending remains local; arbitrary older-backup restores have explicit replay/recovery limits. Grants must not publish a full gameplay backup automatically.
- Keep EC1/EC2 player storage, credentials and title scopes separate. Shared admin identity is a different concern from whether players share accounts.

## Unified administration, initial milestone

The existing EC2 Worker hosts the shared admin application and Discord session. A top-left game selector switches EC2/Classic workspaces without another login. EC1 retains its own Worker and storage, accessed through a narrow private `AdminWorkspace` RPC and current-role lookup through EC2 `AdminAuthority`.

The first local milestone exposes read-only Classic status, players, player details/revisions/mail history and audit. It does not enable paused player features, migrate production accounts, deploy changes or replace the old dashboard yet. Every admin read rechecks central roles; no public caller-provided identity bypass is introduced.

The current Unity-side planning documents live in the sibling `Epic_Conquest/docs/backup-migration/` directory. Reconcile this backend's historical preference dictionary contract with the current canonical Unity save schema before implementing the player-backup phase. Historical Windows paths in older docs are archival references.
