# Classic online news

`createNewsApp()` mounts at `/api/liveops/news`. Classic D1 owns all news, player read state and grant receipts; no EC2 player storage, PlayFab calls, R2 save writes or backup publication occurs. Public news needs connectivity. This implementation does not activate or deploy a Unity feature.

## Player API

- `GET /`: `{game:'ec1',news:[],nextCursor}`. Optional `limit` 1–100 (default 50), bounded decimal `cursor` (offset). Ordered pinned first, ascending order, then ID. Bodies are omitted.
- `GET /:id`: `{game:'ec1',news:post}` with body. Both public endpoints exclude drafts, archived posts, future publication and expired posts. Start is inclusive, expiry exclusive; null means unbounded. Server time controls visibility.
- `POST /:id/read`: real player session required; idempotent first-read timestamp. Hidden posts return 404.
- `POST /:id/claim`: real player session and `{operationId}` required. Returns `{game:'ec1',receipt}`. `operationId` is validated; durable reward uniqueness is `(playerId,'news',newsId)` across all operation IDs. The atomic insert selects the live post's server-defined rewards. Announcement-only or hidden posts cannot issue new rewards. Concurrent requests return the same receipt.

Issued receipts are immutable and owner-scoped. Claim recovery checks existing receipts **before** publication/expiry eligibility, so archiving, unpublishing, expiry or reward edits never prevent recovery or reissue rewards. Another player cannot use an owner's receipt. The client must retain locally applied receipt IDs to avoid applying a recovered reward twice. Receipts do not silently publish or edit gameplay saves; restoring older backups retains the product contract's replay limitation.

The wire post is `{id,titles,bodies,publishAt,expireAt,pinned,draft,archived,order,rewards,revision}`; list omits `bodies`. Titles and bodies accept English (`en`, required) and Indonesian (`id`, optional with client English fallback). Title maximum is 200 characters per language; body maximum 20,000. Copy is plain text; angle brackets/NUL are rejected. No HTML or executable content is rendered. Rewards use Classic's shared bounded, allowlisted `{id,amount,...}` schema rather than EC2's numeric reward enum. Dates are UTC ISO strings or null. IDs match `[a-z0-9-]{1,80}` and remain permanent.

Offset pagination is bounded to 1,000,000. Changing publication/order while paging may move posts between pages; this is an online feed, not a historical snapshot.

## Private administration

`dispatchNewsAdmin(env, actor, role, operation, args)` receives a trusted centrally authenticated actor and current role from the private workspace boundary. All roles can list/detail; only manager/internal roles mutate. The dispatcher never accepts an identity from public headers.

| Operation | Arguments |
| --- | --- |
| `news.list` | optional `limit`, `cursor` |
| `news.detail` | `id` |
| `news.create` | `operationId`, `post` |
| `news.update` | `id`, `expectedRevision`, `operationId`, full `post` |
| `news.publish` | `id`, `expectedRevision`, `operationId`, `published:boolean` |
| `news.archive` | `id`, `expectedRevision`, `operationId` |
| `news.reorder` | `operationId`, `items:[{id,expectedRevision,order}]` (1–100 unique IDs) |

Create/update post input contains `id,titles,bodies,publishAt,expireAt,pinned,draft,order,rewards`; archived and revision are server-owned. Create returns status 201; other successful operations return 200. Detail and single mutations use `{game:'ec1',news:post}`; list/reorder use an array under `news`. Archive permanently hides the post and preserves receipt identity; no delete/reuse-ID operation exists. Publishing an archived post returns 409.

Mutations batch a conditional operation record, content changes, and audit entry in one D1 transaction. All requested revisions must match before the operation can be accepted; reorder succeeds for every row or none. A per-attempt nonce ensures only the request that inserts the operation can mutate/audit. Exact retries return the stored response; changed arguments under the same actor/operation ID return 409. Operation IDs are scoped by authenticated admin actor, and never authorize an action. A database or audit failure returns a sanitized 503 and rolls back all writes.

`migrations/029_liveops_news.sql` follows shared immutable grants migration 028. Isolated tests load every migration in filename order and check visibility, pagination, roles, validation, optimistic races, durable idempotency, transactional audit failure, player isolation, concurrent claims, archive recovery and no backup revisions. Run `node --test tests/liveops-news.test.mjs`.
