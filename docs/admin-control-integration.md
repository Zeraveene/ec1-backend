# Classic identity and revision controls

Implemented locally on 2026-10-22; the compatible EC1 backend was deployed on 2026-10-23 as version `990a5532-047e-478d-aaa4-f78c82cef9e7`. The implementation pass changed no production resources. The later authorized deployment retained paused player feature gates and did not change EC2 backend/configuration.

## Same dashboard session without EC2 backend changes

The existing EC2 gateway remains read-only. New Classic identity/revision requests use the same-origin `/api/classic-admin/*` path. EC1's Wrangler configuration owns a narrow route for `ec2mod.codezrv.com/api/classic-admin/*`, which Cloudflare can route ahead of the hostname's Custom Domain Worker. See [Cloudflare route precedence](https://developers.cloudflare.com/workers/configuration/routing/routes/).

The EC1 Worker receives the browser's existing host-scoped admin cookie and sends only `ec2mod_session` to the existing EC2 `/api/me` through its private default-entrypoint `EC2_ADMIN_SESSION` binding. It does not copy signing secrets, read EC2 databases, change EC2 endpoints, accept caller-supplied actors, or initiate a second login. The role returned by the central endpoint is validated on every request. Missing binding/configuration, malformed identity, authority failures and redirects fail closed. No public network fallback exists.

`CLASSIC_ADMIN_ORIGIN` must match the dashboard origin exactly. Other incoming origins are rejected. POST requires that exact `Origin` and JSON content type, with a 32 KiB request limit. Private reads disable caching. Manager/guest roles can read identity/revision metadata; action previews, raw snapshot downloads and mutations require internal access. These stricter HTTP preview permissions are intentional even though the standalone identity preview function can safely compute a read-only summary for other trusted callers.

## Controls delivered

- Email/password, Google, Discord and Apple identity cards use the existing EC2 frontend icons, styles and native confirmation dialog. Unlinked providers remain visible.
- Move an existing login from another Classic account using a reviewed source/destination fingerprint. Both saves, purchases and unrelated logins stay in place; active access for affected accounts is revoked. The source losing its last durable login is explicitly warned.
- Change/link email and reset its password using an explicitly supplied new password of 10–256 characters. No predictable shared reset password, recovery email or plaintext password is stored in receipts/audits.
- Unlink a provider only when another durable sign-in method remains. Expected subject and conditional state checks prevent acting on a replaced identity.
- Paged revision metadata, explicit verified snapshot preview and exact-content JSON download.
- Reviewed historical restore publishes a new revision, preserving all historical objects and the exact sourced gameplay data. A lower-playtime source warns but remains selectable. It does not push restored progress onto a running client.
- Immutable operation IDs support exact retries after lost responses. Changed reviews, actors, source versions or payloads conflict. A restore receipt remains replayable after later backup publication without creating another revision.

Raw forensic restoration uses a narrowly guarded `preserveSourceData` publication option: only audited admin restoration with playtime decrease enabled may bypass rewriting snapshot fields from the paid-entitlement ledger. The verified purchase ledger itself is never modified. Ordinary client saves and grants retain their existing behavior.

## Revocation race protection

Admin credential changes must also reject authentication already in flight. EC1 now conditionally publishes sessions against the same identity subject, owner, hash/salt and creation record verified earlier. Provider/email linking also rechecks the live initiating session and consumed challenge where applicable. Consequently a password check or provider callback begun before reset/unlink/move cannot regain access afterward. Guest/bootstrap/device paths retain their existing proofs and tests.

## Verification

- EC1 `npm run check` using Node 24.22.1: TypeScript, **81/81 tests**, and production build passed.
- New tests exercise actual Worker service binding to a synthetic central session endpoint; origin/JSON/size/role rejection; forged actor headers; identity controls; revision restore; exact retries; guarded DB races; paid-field fidelity; corrupted/missing snapshot objects; and seven deterministic in-flight authentication races.
- Dashboard action transport tests and production build passed. Browser QA used synthetic data only and verified the EC2 identity layout, source/destination move review, native dialog behavior and older-revision warning.
- All **114 EC2 backend/config files** match the hashes recorded at the start of this request. Frontend changes live in the isolated `ec2-unified-admin` worktree; the original EC2 checkout remains untouched.

## Release order and remaining boundaries

EC1 migration `022_admin_identity.sql` and migrations 023/024 were applied to production on 2026-10-23; the follow-up listing reported no pending migrations. EC1 Worker `990a5532-047e-478d-aaa4-f78c82cef9e7` deployed the compatible backend, private session binding and narrowly scoped route. Unauthenticated Classic admin requests returned the expected 401/403. This does not establish real-admin dashboard/session/action readiness or claim shared dashboard frontend publication. Verify those separately before production account actions. The local full check passed 94/94 tests, TypeScript and build; no real player/account/session/save operations were performed. All 114 EC2 backend/config baseline hashes remained unchanged.

Keep EC1 player creation, migration, purchases and recovery paused. Native provider registration and signed-device authentication are separate release checks; these admin controls do not claim those client integrations have been certified. This pass does not migrate gameplay save formats or change the agreed optional/manual backup principle.

## Shared-session read adapter (prepared after the initial deployment)

The EC1-owned `/api/classic-admin/status`, `/players`, `/players/:id` and `/audit` GET routes use the same existing EC2 `/api/me` session introspection as identity/revision controls. They do not depend on a newly deployed EC2 `getRole` RPC. Every request validates the current central response and role; removed membership, malformed authority responses and outages fail closed. Caller-supplied actor headers never authorize access.

`src/admin/workspace-read.ts` shares only argument validation, scoped keyset cursors, redacted projections and EC1 storage reads. Its callers establish authorization first. The existing private `AdminWorkspace.read` RPC retains its independent current-role `ADMIN_AUTHORITY.getRole` guard. Read responses omit device credentials, password hashes/salts, R2 keys, raw save payloads and audit detail JSON. Player-detail identity subjects remain visible to authorized administrators, consistent with the previous private workspace contract. No EC2 backend change is required by this adapter. Deployment of this follow-up is coordinated separately from the initial version recorded above.

## Tabbed backend player viewer and revision comparisons

The shared EC1 Players viewer uses `GET /api/classic-admin/players/:id/save-view` for a read-only projection of its stored backend backup. It prefers the explicit canonical backup head; only accounts without one use their existing legacy backend save head. It never queries PlayFab, imports data, publishes a revision or downloads progress into the game. Missing saves return an empty view; missing/corrupt head bytes return an integrity error rather than silently selecting older data. Existing central-session and current-role checks protect the endpoint, including read-only admins.

Revision lists for both formats include `summary` with Ruby, Gold and levels keyed by `alaster`, `edna`, `louisa`, `soul` (displayed as Zerav). Summaries are projected from each checksum-verified snapshot with at most four concurrent R2 reads; absent fields stay null, real zeros stay zero, and unreadable revisions remain listed with an unavailable summary. Restore reviews also include the source/current summaries. No database migration is needed. Existing append-only restore, reviewed-state hashes, idempotency, role checks and explicit game-download semantics are retained.

## Player purchase foldout and native account deletion

`GET /api/classic-admin/players/:id/purchases` returns the exact player's all-time ledger count and paginated safe purchase rows (50 per page). It requires current internal access. Its keyset cursor is bound to the player ID; a substring search or 90-day analytics window is not used. The shared Account tab displays the count on a collapsed foldout, including explicit loading/error states.

Migration `037_admin_account_deletion.sql` is required before account deletion is advertised by capabilities. Internal admins use `GET /players/:id/deletion` and `POST /players/:id/delete` on the same Classic control path. The POST requires the exact player ID, a reason, acknowledgement and stable operation ID. A durable receipt, write guards, permanent native-ID ban, credential removal and session revocation commit together. A manifest preserves the committed R2 snapshot keys until deletion succeeds; storage failure leaves access blocked and cleanup retryable, including after a browser reload. Cleanup removes backup metadata/blobs, mail, current rankings, device credentials and sessions. Replays converge without duplicate audit entries. Deleted players are hidden from the active Players workspace.

This is native EC1 account deletion. The minimal blocked player/tombstone, purchase ledger and immutable grant facts, deletion/audit receipts and immutable source archives are retained. No PlayFab mutations, EC2 operations, store actions or device-save changes occur. Triggers block late save publication, identity reassignment, session creation, player replacement and unbanning for deleted native IDs. This migration does not perform deletion itself. Local tests use synthetic players only; no production account was deleted during implementation.

### Production release — 2026-11-05

Migration 037 was applied to `epicon1-player-data`; the subsequent listing showed no pending migrations. EC1 version `e221c2af-ce9d-4d98-82a8-e513b726af23` replaces the isolated Classic admin module and routes the Classic control prefix through it, including the current private `AdminWorkspace` projection. The original gameplay module remains byte-for-byte unchanged (SHA-256 `e20c0d57ab8b42ad303119a2cc6bf5a5e5dcce17fb9b5f5661d08b65e803d60c`). Upload inherited all live bindings and retained the existing static assets and hourly cron. Exact module/binding readback, both EC1 health endpoints, static assets and unsigned-route rejection passed. No player deletion, save restoration or migration was invoked. Private deployment originals and receipts are under ignored `.wrangler/player-viewer-release/`.
