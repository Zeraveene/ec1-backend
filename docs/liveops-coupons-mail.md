# Classic online coupons, personal mail and grants

## Developer story-test action — October 26, 2026

`STORY_TEST_COUPON` is a developer command handled before normal coupon lookup, gated by `STORY_TEST_ENABLED` and the authenticated account allowlist in `STORY_TEST_PLAYERS`. Check returns `diagnostic: full-story`; explicit `POST /api/liveops/coupons/story-test/start` returns a new run ID. It creates no reward grant and is never replayed by opening Coupons. The production client destructively resets only local gameplay through its normal import/reload transaction and retains authentication. Progress is not restored after the run. `POST /api/liveops/coupons/story-test/report` stores up to 256 KiB of diagnostic JSON in `AUDIT_BLOBS`, binding path/owner/run ID to the authenticated identity. Ordinary coupon body limits stay 4 KiB; the report envelope is bounded separately at 270 KiB. No gameplay save publication or PlayFab mutation occurs in these routes. Deploy backend and updated mobile player together; store review notes must disclose the developer diagnostic mode.

## Permanent unlock rewards — October 26, 2026

The existing reward array also accepts permanent ownership rewards with `amount: 1`: `louisaUnlock`, `soulUnlock`, `premium`, `more_exp` (EXP Boost), `double_loot` (Drop Boost), `booster_pack` (Dual Boost), and `costume_<alaster|edna|louisa|soul>_<1..8>`. Dual Boost sets `more_exp`, `double_loot`, and `dualTaken` together, matching the store product. These are permanent benefits, not timed ad boosts. Alaster and Edna are available by default and need no unlock reward. Store product aliases, arbitrary preference writes, and purchase/offer claim markers are not mail rewards.

For example, `mail.send` may include `rewards: [{id:"premium",amount:1},{id:"booster_pack",amount:1},{id:"costume_louisa_8",amount:1},{id:"ruby",amount:100}]`. The same reward definitions work in news and coupons. The private admin catalog and standalone dashboard list all six new choices with maximum quantity 1. No migration or save-schema change is required.

The backend validates and issues immutable receipts; Unity `LiveOpsRewardDelivery` applies ownership to canonical save flags in the existing atomic reward/receipt transaction. The application retains lifecycle and UI binding ownership. Unlocks never enter inventory, consume capacity, or create verified store purchase records. Already-owned unlocks are successful no-ops with no currency compensation; the receipt still commits so mixed currency/item rewards and retries remain safe. Currency and inventory portions retain their existing overflow/capacity checks and all-or-nothing delivery.

Ship the updated Unity client before sending these new reward IDs to players: older clients reject them and leave their receipts pending. This implementation is local preparation; it does not deploy either service or send production mail. Online grants still do not synchronize gameplay backups or make offline progress tamper-proof.

At the user's request for in-game sample mail, the reward update was deployed October 26, 2026 as Worker version `3719699f-a195-49fe-8800-8a5fbdabf524`. The isolated release uses the previously deployed clock-release snapshot plus only reward validation/catalog/dashboard changes; unrelated working-tree leaderboard changes are excluded. Typecheck, 25 focused tests and the dashboard build passed. Production variables were preserved with `--keep-vars`; no database migration was needed. Four sample mails were sent through the authenticated shared admin UI to the current user-authorized account, covering heroes, Premium, individual boosters, Dual Boost and four costumes. Unity receipt/list rendering was verified; all samples were left unclaimed for the user's manual claim test. The shared admin currently labels new non-inventory unlocks as Material because its presentation categories lack an unlock category; this does not change grant semantics.

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
