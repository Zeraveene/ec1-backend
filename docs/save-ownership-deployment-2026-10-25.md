# Save ownership deployment — 2026-10-25

With the user's authorization, applied `032_save_ownership.sql` to `epicon1-player-data` and deployed EC1 Worker version `70b7d588-5ca1-44d7-8023-760ef9112447`. The previous version was `a8ed17fe-4cf0-47df-80e7-c5ba79a1ff08`. D1 Time Travel bookmark and rollback metadata were recorded before migration in ignored `.wrangler/save-ownership-rollout/`.

The ownership claim and backup revision publish atomically. Existing unbound progress can be claimed once; conflicting authenticated accounts receive `account_mismatch`. Signed ownership cannot be reassigned by editing UID or stripping proof for an already registered lineage. Legacy read envelopes preserve immutable stored bytes. See `manual-backup-product-contract.md` for claim and compatibility limits.

TypeScript, all 163 isolated backend tests, and the production dashboard build passed. The schema generator check matched Unity (17 types, 171 fields), with optional root ownership validated separately. One earlier full run exposed an existing intermittent daily-reset race assertion; final verification passed without modifying that unrelated code.

Fourteen live checks passed: both EC1 health endpoints preserve their previous flags, public news/leaderboards work, Fortress submissions remain paused, private APIs and backup read/write reject unauthenticated requests, and shared admin origin/session gates and JSON404 behavior remain intact. Remote schema inspection confirmed `classic_save_owner` and `classic_backup_revision.save_id`; no migrations remain pending. No real player save was read, claimed, transferred, or uploaded for these checks; no EC2 Worker or store feature was deployed/activated.
