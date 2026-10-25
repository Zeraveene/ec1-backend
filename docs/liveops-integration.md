# Classic online features

Classic reuses EC2's administration patterns and Discord admin session while keeping all player data, rewards and persistence in the EC1 Worker/database. The Unity client is intentionally untouched by this backend/admin implementation.

## Implemented surfaces

| Feature | Player API prefix | Shared admin page |
| --- | --- | --- |
| Coupon eligibility and redemption | `/api/liveops/coupons` | `/games/ec1/coupons` |
| Private player inbox and claims | `/api/liveops/mail` | `/games/ec1/mail?playerId=...` |
| Published localized announcements | `/api/liveops/news` | `/games/ec1/news` |
| Infinity Fortress rankings | `/api/liveops/leaderboards` | `/games/ec1/leaderboards` |
| Durable reward recovery/acknowledgement | `/api/liveops/grants` | Shared reward picker is used by mail, coupons and news |

Detailed contracts: [coupons/mail/grants](liveops-coupons-mail.md), [news](liveops-news.md), [leaderboards](liveops-leaderboards.md).

Admin operations use EC1-owned `/api/classic-admin/liveops/:feature/:action`. GET accepts JSON `args` as a URL parameter and only allowlisted reads. POST accepts JSON arguments and only allowlisted mutations. Every request checks the current central Discord session; mutations require the configured exact Origin and JSON content type. Managers and internal admins manage online content; guests inspect it. Identity changes and backup restores retain their existing internal-only permissions. `/liveops/catalog` exposes Classic's validated reward catalog, not EC2's inventory.

Every write carries an operation ID for exact retry and is audited atomically. Editors retain failed operations for explicit retry. Revisions/configuration versions prevent overwriting another admin's newer changes. Reward receipts are immutable per account/source; repeated claims recover the original receipt after expiration, disabling or content edits. Acknowledgements are separate records. These APIs never publish gameplay backups, call PlayFab or change purchase settings.

## Client integration requirements

Use explicit online actions and the existing player bearer session. News list/detail and ranking reads are public; coupon checks, inbox, claims and submissions require the player scope. Never enumerate all coupon codes. Use the returned opaque pagination cursor without modifying it.

For any reward source, journal and atomically apply a receipt locally once, then acknowledge it. Recover pending receipts after interrupted delivery. An acknowledgement alone must not grant anything. Integrate the local delivery path before exposing claim buttons; the APIs do not mutate the optional cloud backup on the player's behalf. The current purchase-specific `ec1-grants-v1` capability remains a separate contract and is not advertised by this implementation.

Score submissions explicitly identify season and configuration version and contain a structured Fortress record. They do not depend on manual backup uploads. The initial board is paused; starting a new season also pauses submissions until a manager explicitly resumes them. No EC2 device restrictions or automatic anti-cheat bans were imported.

## Rollout

1. Apply migrations `028_liveops_grants_coupons_mail.sql`, `029_liveops_news.sql`, `030_liveops_leaderboards.sql` to the intended EC1 environment before deploying its updated Worker. Snapshot/back up the environment through the normal release procedure first.
2. Build and deploy EC1 and the updated `ec2-moderation-tool` dashboard together. The existing EC1-owned shared-dashboard route and `EC2_ADMIN_SESSION` service binding are required; no new secret is needed.
3. Check unauthenticated rejection, manager writes, guest read-only access, coupon cap/expiry, private inbox ownership, scheduled news, and score season transitions with synthetic accounts in staging.
4. Integrate and test the Unity client receipt journal/recovery and explicit score submission before activating the board or publishing real campaigns.

This change has been verified locally only. No remote migration, deployment, real mail, production campaign, score activation or live-store change is performed by the implementation work.

## Local verification

EC1: `npm run check` includes the isolated suites and the mounted HTTP integration suite. They exercise synthetic D1/session data, reject outbound network, and verify no gameplay revision publication.

Shared admin: `npm run build`, `npm run test:unified-admin`, and `npm run test:equipment-display`. `node scripts/preview-classic-liveops.mjs` in the sibling moderation-tool repo runs the real EC1 Worker against disposable synthetic D1 with a local preview admin. It has no access to production credentials or outbound services. Open `http://127.0.0.1:5196/games/ec1/coupons`; synthetic recipient ID is `EC1X_PREVIEW`.

## Production deployment — 2026-10-25

At the user's request, EC1 Worker version `8ec88449-d9db-4750-9f10-9298d6df3809` was deployed after migrations 028–030 were applied to `epicon1-player-data`. The 156-test backend check/build passed before deployment; 16 live read/auth smoke checks passed afterward. Public news and leaderboard queries work, private inbox/grants and shared admin routes reject unauthenticated requests, and the Fortress board remains paused. Existing purchase, account-creation, recovery, migration and manual-backup settings were preserved. No store activation, real mail, campaign creation, score submission or client release was performed. The user's EC2-hosted dashboard was deployed separately.

The prior Worker version and D1 Time Travel bookmark are recorded outside Git in the protected local deployment metadata directory.
