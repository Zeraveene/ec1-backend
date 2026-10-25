# Unified admin, first milestone

EC2 owns the dashboard session and calls EC1 through a private service binding targeting the named `AdminWorkspace` entrypoint. EC1 keeps its own D1 and R2 bindings; EC2 needs no EC1 database or bucket binding. Existing EC1 login and admin routes remain available.

Bind EC2's workspace service to EC1 with `entrypoint = "AdminWorkspace"`. EC1's existing `ADMIN_AUTHORITY` binding must target an authority exposing `getRole(discordId)`, returning `internal`, `manager`, `guest`, or `null`. Every read revalidates live membership. Missing methods, malformed roles and authority failures return 503; removed membership returns 403. All three current roles can read.

`read({id,name}, operation, args={})` returns `{status,body}`. Operations are `status`, `players` (`query`, `cursor`), `player` (`id`), and `audit` (`cursor`). Unknown fields and invalid arguments return 400; absent players return 404. Storage failures return 503 without internal diagnostics. No public HTTP endpoint forwards to this RPC.

Player lists use literal substring queries of at most 100 characters and pages of 100, ordered by `updated_at DESC,id DESC`. Cursors bind the operation/query and both ordering keys. Audit lists use `created_at DESC,id DESC`. Player detail returns at most 100 identities, recent revisions and mail metadata. Explicit column projections exclude device identifiers, credentials, tokens, save/archive object keys and raw content. Audit excludes arbitrary historic `detail_json`; its safe metadata includes ID, actor, action, player and timestamp.

This milestone adds read operations only. No game feature flag, migration, player session, purchase or save publication behavior changes. Local tests use synthetic D1 data and actual Miniflare service-binding RPC calls.
