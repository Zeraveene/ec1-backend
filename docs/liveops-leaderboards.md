# Classic online fortress leaderboard

`createLeaderboardsApp()` mounts at `/api/liveops/leaderboards`. Migration 030 creates independent leaderboard state, receipts and lifecycle history; migration 033 replaces packed scores with structured records. The only board is `infinity_fortress`. Unity's `FortressRecord` owns local record comparison; `FortressLeaderboardManager` owns online requests and `MenuFortres` renders results. EC2's Chamber of Trial board, device restrictions and anti-cheat workflows do not apply.

Initial configuration is season 1, version 1, submissions paused. Applying migrations does not activate submissions. No production deployment is included. Root routes and central-role RPC provide administration; this module never accepts public admin identity or exposes an admin HTTP endpoint.

## Player API

- `GET /boards` returns `{boards:[metadata]}`.
- `GET /infinity_fortress/top?season=1&offset=0&limit=100` returns metadata, selected season, `entries`, and `nextOffset` (`null` after a short page; an exactly full final page requires one empty follow-up). Limit 1–100, offset 0–1,000,000.
- `GET /infinity_fortress/players/:playerId?season=1` returns metadata, selected season and `entry` or `null`.
- `GET /infinity_fortress/around-me?season=1&radius=5` requires a player session and returns metadata, selected season, one-based `rank` or `null`, and `entries`. Radius 0–25. An unranked player returns no entries.
- `POST /infinity_fortress/submit` requires an owner player session and JSON `{season,version,operationId,record:{character,floor,cleartime}}`. Returns `{board,season,operationId,acceptedRecord:{character,floor,cleartime},entryRank}`.

Metadata is `{board,season,version,submissionPaused,updatedAt}`; times are Unix seconds. Entries contain only `{playerId,playerName,record:{character,floor,cleartime},rank}`. Display names are projected from current player rows, stripped of control characters/angle brackets and truncated to 48 characters. Consumers must render text safely. No email, identity, device, save, or auth fields are exposed. Public top/detail reads are deliberate; around-me and submissions use the existing session/scope/ban middleware. Active bans also hide entries from every public rank projection. No bans or flags are created.

Structured record bounds are integer character 0–3 (Alaster, Edna, Louisa, Soul), floor 1–2,147,483,647 and cleartime 0–2,147,483,647 seconds, matching Unity's independent signed integer fields. Ranking is **floor descending, cleartime ascending, character descending, player ID ascending**. Character order retains the previous tie preference; player IDs provide stable contiguous one-based positions. No packed numeric score is calculated, stored or returned. Floors above 2,147 and times above 99,999 work normally; higher floors always outrank lower floors regardless of elapsed time. Only improvements replace the player's current best for that season. A single best record is sufficient because Classic selects its best structured record across saved characters and the current result. No per-character or EC2 Chamber boards are invented.

Previously accepted receipt replays bypass submission throttling. New submissions use a fixed account bucket allowing 30 attempts per minute; excess requests return 429 with `Retry-After` and `retryAfterSeconds`. Bucket keys contain only the authenticated account ID and a fixed feature prefix, so arbitrary operation IDs do not grow rate state. Shared bounded maintenance may delete expired buckets.

The body is streamed with a 4096-byte cap; numeric scores and unknown fields are rejected. Operation IDs contain 1–96 ASCII letters, digits, underscores or hyphens. Session identity is the only owner selector. Receipts bind owner, board, season, operation ID and canonical record/version hash. Identical retries return the original accepted record (rank is current); conflicting reuse returns 409. Config/version checks, ban checks, receipt creation and conditional best-score publication run in one D1 batch. Simultaneous improvements cannot replace a better record with a worse one. Previously accepted receipts remain retryable after pause/season change. Stale new submissions return 409. Storage/service failures return 503 rather than fabricated empty success.

## Admin dispatcher

`dispatchLeaderboardAdmin(env, actor, role, operation, args)` returns `{status,body}`. All three allowed central roles can read; only manager/internal can mutate. Root must supply a freshly checked role and authenticated actor.

- `leaderboards.status`, optional `{board}`: metadata plus `entryCount` (stored entries including currently hidden banned players).
- `leaderboards.top`, optional `{board,season,offset,limit}`: the same safe projection and pagination as public top, with default limit 50.
- `leaderboards.history`, optional `{board,offset,limit}`: `{history:[{id,board_id,operation,season,version,paused,actor_id,actor_name,created_at}]}`. Default limit 50, maximum 100. Internal payload hashes are omitted.
- `leaderboards.pause`: `{board?,expectedVersion,operationId,paused:boolean}` increments configuration version while retaining season and entries.
- `leaderboards.reset` and `leaderboards.season`: `{board?,expectedVersion,operationId,season?}` advance exactly one season, increment version and pause submissions. If supplied, season must equal the next season. Old scores remain available through historical season reads; reset never deletes history.

Mutations return resulting metadata. Every mutation requires an operation ID and expected version. Matching retries return the original metadata; reusing an ID for another actor or request conflicts. CAS races allow one change per expected version. Lifecycle history and `admin_audit` are recorded atomically with the state change. Leaderboard history uses Unix seconds; common `admin_audit` uses Unix milliseconds. History uses IDs prefixed by board; admin audit action names use `leaderboards.*`. Resume means `leaderboards.pause` with `paused:false` and the current version. No scheduled reset or automatic activation exists.

## Offline/manual backup boundary and limitations

Submission is an explicit online feature with its own structured record. It never reads, writes or publishes gameplay saves, manual backup heads, entitlements or PlayFab statistics. Local battles and progress remain offline. Client integration must request submission explicitly and must not add automatic gameplay backup uploads. An authenticated, bounded record is still a player's claim about offline progress: these checks are validation and concurrency protection, not server-authoritative gameplay verification or cheat detection. Existing save-linked `player_leaderboard` is legacy state and is not used by this API.

Historical rows/receipts intentionally remain for recovery and replay handling. Rank/entry reads use separate statements and can shift under concurrent live submissions; pagination is a live ordered view rather than a snapshot cursor. No production calls, imports or feature enablement are required for local tests.

Validation: `node --test tests/liveops-leaderboards.test.mjs` uses isolated Miniflare, all migrations sorted by filename, synthetic sessions/players, and a forbidden outbound handler. It covers initial pause, authentication, bounded structured input, privacy projection, tie order, pagination, around-me, monotonic best score races, conflicting/replayed operations, bans, reset history, admin role/CAS races, audit counts, zero save publication and zero network requests.

## Structured ranking rollout — October 25, 2026

Apply `033_structured_fortress.sql` before deploying this Worker and ship the matching Unity client. The API removes entry `score` and replaces submission `acceptedScore` with `acceptedRecord`. Earlier packed-score clients are not compatible with the new response contract. Board seasons, versions, pause state and lifecycle audit history are unchanged.

The migration copies existing structured entry fields, reconstructs each old receipt's original accepted record using exact integer arithmetic, and preserves operation IDs, payload hashes and timestamps. Old receipts were constrained to unambiguous bounded records, including zero-second runs; retries still resolve after migration even while submissions are paused. The old save-linked `player_leaderboard` also moves to structured fields so its deprecated API and snapshot validation cannot reintroduce the floor cap. It remains independent from the current online board. No immutable gameplay revisions or PlayFab sources are rewritten.

`tests/structured-fortress.test.mjs` seeds historical rows before migration 033, verifies preservation and accepted-receipt replay, and forbids outbound traffic. Extended leaderboard tests cover floors above 2,147, long runs, maximum field values, all tie breaks and concurrent improvements. Existing standings lost by old overflow or overwritten personal records cannot be reconstructed from the packed number alone; no guessed repairs are applied.
