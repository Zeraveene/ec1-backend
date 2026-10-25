# Classic online coupons, personal mail and grants

These modules only use EC1 D1. They never read/write gameplay backups, R2, PlayFab, EC2 player storage or store transactions. They are server preparation; this change does not activate or implement a Unity client.

## Immutable delivery receipts

`src/liveops/grants.ts` exports `validateGrantRewards(value, allowEmpty=false)`, `grantInsertFromSelect(env,{playerId,sourceType,sourceId,selectSql,bindings?})`, and `getGrant(env,playerId,sourceType,sourceId)`. Trusted `selectSql` yields `rewards_json` and `created_at`. Feature owners batch this insert with their guarded eligibility/claim state update. The unique owner/source tuple yields the same receipt on every retry; database triggers reject receipt updates/deletes. Source identifiers must remain stable. Receipt shape is `{id,playerId,sourceType,sourceId,rewards,createdAt}`. Timestamps use Unix milliseconds.

Grants use the bounded Classic `src/game/rewards.ts` allowlist/catalog: `{id,amount,name?,itemCategory?}`. EC2 numeric rewardType, hero IDs and IAP aliases are deliberately not accepted as Classic rewards. Mail permits `[]`; coupons require 1–100 validated entries. Receipt issuance is independent of local application. Acknowledgement records delivery confirmation only; it does not validate offline spending or prevent a player from restoring an older local backup. Future Unity delivery must persist receipt application locally before acknowledging and handle that explicit replay limitation.

`createGrantsApp()` mounts at `/api/liveops/grants`, requires a native player session and exports:

- `GET /?limit=30&before=<cursor>` → `{grants:[receipt + acknowledgedAt],nextBefore}`.
- `GET /:id` → `{grant,acknowledgedAt}` or owner-scoped 404.
- `POST /:id/ack` → `{grantId,acknowledgedAt}`. Concurrent retries retain the original timestamp in a separate acknowledgement table.

## Player coupon routes

`createCouponApp()` mounts at `/api/liveops/coupons` with `requirePlayer`. Migration-scoped sessions cannot reach it. Both routes take `{code}`; whitespace is trimmed and codes are uppercase ASCII `[A-Z0-9_-]`, length 3–64.

- `POST /check` → `{eligible:true,claimed:false,coupon:{id,title,rewards,expiresAt}}`, or `{eligible:false,claimed:true,grant}` for the current owner's prior claim. No claim is created by preview. Missing/ineligible coupons return `coupon_unavailable` (404/409).
- `POST /claim` → `{grant,replayed?:true}`. A D1 transaction conditionally consumes account eligibility under enabled/start/expiry/global-cap/target-allowlist rules and issues the immutable receipt. Concurrent accounts cannot exceed the cap. A prior owner receipt is returned even after expiry, disabling, target changes or reward edits.

There is no public coupon list and responses never reveal target accounts. Check and claim share a durable 30-request/minute/account limiter with 429 `retryAfterSeconds` and `Retry-After`. Requests have a 4096-byte body limit. Code correctness and eligibility are always checked on the server. A preview may become unavailable before claim; only claim is authoritative.

## Player mail routes

`createMailApp()` mounts at `/api/liveops/mail`, requires a native player session and uses its owner identity for every operation:

- `GET /?limit=30&before=<cursor>` → `{mail:[...],nextBefore}`. Shows enabled, unexpired messages and enabled claimed messages after expiry.
- `GET /:id` → `{mail}`. Claimed messages remain recoverable after expiry/disabling.
- `POST /:id/read` → `{read:true}`; preserves the first read timestamp.
- `POST /:id/claim` → `{grant,replayed?:true}`. Marks read/claimed and inserts the receipt in one transaction. Rewardless messages produce an empty immutable receipt. Prior claims replay after expiry or disabling.

Mail fields: `{id,revision,playerId,title,subject,body,rewards,enabled,expiresAt,readAt,claimedAt,createdAt}`. `subject` aliases `title` for the EC2 administration pattern. Other-owner IDs return 404. Player body fields never choose ownership or rewards. Source uniqueness makes player claim and acknowledgement retries idempotent without relying on caller operation IDs.

## Private admin dispatch

`dispatchCouponAdmin` / `dispatchMailAdmin` take `(env,actor:{id,name},role:'internal'|'manager'|'guest',operation,args)` and return `{status,body}`. The root private `AdminWorkspace` and HTTP session/Origin boundary establish actor and current central role. Guests can read; internal/manager may write. Do not expose dispatch functions directly without that boundary.

All writes require `operationId` (8–128 ASCII letters/digits/underscore/hyphen). A durable actor/operation/request receipt, resource mutation and audit entry commit atomically. Retrying the same request returns its original result; reusing its ID with different arguments gives 409 `operation_conflict`. Edits/disables also require `expectedRevision` and atomically reject stale revisions with 409. Disable preserves existing delivery receipts. No delete operation is exposed.

Coupon operations:

- `coupons.list {limit?,before?}` → `{coupons,nextBefore}` including `claimCount`.
- `coupons.detail {id}` → `{coupon}`.
- `coupons.create {operationId,code,title,rewards,enabled?,startsAt?,expiresAt?,maxClaims?,playerIds?}` → 201 `{coupon}`. Defaults enabled; nullable dates/cap/targets mean unrestricted. A non-null target list must contain 1–1000 player IDs. Titles max 200 characters.
- `coupons.update {operationId,id,expectedRevision,...partial fields}` → `{coupon}` with incremented revision. Code identity is immutable so original-code receipt recovery remains possible. Reward edits affect only future receipts.
- `coupons.disable {operationId,id,expectedRevision}` → `{id,disabled:true,revision}`.

Mail operations:

- `mail.send {operationId,playerId,title|subject,body?,rewards?,expiresAt?}` → 201 `{mail}`. Target player must exist; title max 200 and body max 10,000 characters. Omitted rewards mean `[]`. Expiry must be future if supplied. Each send is immutable; send a replacement message rather than editing sent rewards/text.
- `mail.history {playerId,limit?,before?}` → `{mail,nextBefore}` including expired/disabled messages.
- `mail.detail {id}` → `{mail}`.
- `mail.disable {operationId,id,expectedRevision}` → `{id,disabled:true,revision}`.

All list endpoints default to 30 records, bound limit to 1–100, order by created time and ID descending, and return opaque `nextBefore` strings. Pass that string unchanged as the next `before`; the tie-aware cursor prevents skipping records with equal timestamps. A numeric millisecond `before` remains accepted for older callers. Dates in admin payloads are Unix milliseconds or null, not localized date strings.

## Verification

`node --test tests/liveops-coupons-mail.test.mjs` bundles production apps into isolated Miniflare, applies every sorted local migration, creates synthetic sessions and players, and forbids outbound network. Coverage includes real player middleware, migration-scope rejection, code/target privacy, concurrent cap/claim retries, invalid rewards and schedule gating, immutable receipts, stale revisions, idempotent admin writes, atomic rollback on audit failure, owner-scoped rewardless mail/read/replay, timestamp-tie pagination, grant recovery/ack, request size and coupon throttling. Player backup versions remain unchanged.
