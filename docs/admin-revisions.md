# Classic revision recovery

These functions serve the authenticated Classic admin bridge. Metadata lists are visible to all centrally authorized roles. Raw snapshot downloads, previews and restores require the internal role. No player feature flags or external services are enabled.

`revisionList({id,cursor?})` returns `{playerId,revisions,nextCursor}`. Each revision contains `version`, `sha256`, `playtime`, `operationId`, and `createdAt`. Pages contain at most 100 revisions in descending version order. Cursors are scoped to the player and reject invalid versions.

`revisionGet({id,version})` returns `{playerId,revision,snapshot,download}`. Download contains `filename`, `contentType`, and the exact immutable `content` string. Hash, schema and envelope metadata are verified before exposing a snapshot.

`revisionPreviewRestore({id,version})` returns `playerId`, `currentVersion`, `sourceVersion`, `reviewSha256`, `current` and `source` summaries (`version`, `playtime`, `sha256`), and `warning` for lower source playtime. The review binds the player, both versions and both immutable hashes.

`revisionRestore({id,version,expectedSaveVersion,reviewSha256,operationId})` requires the reviewed current head. It returns `{playerId,saveVersion,playtime,operationId,sourceVersion,expectedSaveVersion,reviewSha256}`. Restore stages and verifies an exact copy of sourced gameplay data, updates only publication envelope fields, then conditionally appends a new version with an audit receipt. Historical revisions and entitlement ledgers remain unchanged. Lower playtime is allowed after review; no automatic source ranking or conflict rebasing occurs.

A committed operation receipt is checked before the current preview, so retries return the original result after a newer head or a lost response. Reusing an operation with different review inputs returns 409. Source corruption, missing R2 objects, unsupported schemas or inconsistent metadata fail closed with 503. Audit contains actor, target, source and expected versions, review hash and operation ID; it never contains gameplay payloads.

The historical preference envelope is validated as implemented today. This module does not migrate or reinterpret the Unity save schema. Tests use isolated local Miniflare D1/R2 and synthetic fixtures; no production or PlayFab access is needed.
