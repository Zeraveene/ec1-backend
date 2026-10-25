# Classic admin identities

`src/admin/identities.ts` implements Classic-only identity actions. It uses the Classic D1 binding and existing PBKDF2 password format. There are no provider, PlayFab, EC2 storage or external network calls. Apply migration 022 after existing migrations, including recovery 010 and device credentials 021.

The private admin bridge must provide a freshly authorized `AdminActor`. Standalone reads and move-preview computation accept internal, manager and guest roles. The shared dashboard HTTP bridge intentionally restricts POST action previews to internal admins as well as mutations. Every mutation independently requires the internal role. Never expose these module functions directly to unauthenticated HTTP callers.

Functions take `(env, actor, args)` and return an object; typed `AdminActionError` carries safe `code` and HTTP `status`. Storage errors are 503, missing accounts 404, changed review/identity and reused operation IDs 409.

- `identityRead({id})` returns `{id, saveVersion, playtime, identities}`. Each identity has `{provider,subject,created_at}`. Stored `email` becomes public `password` with an additional `email` field. Device identities remain visibly distinct.
- `identityPreviewMove({id,sourceId,provider})` returns `{source,destination,provider,reviewSha256,warnings}`. Account projections match the read result. Providers are password, google, discord and apple.
- `identityMove({id,sourceId,provider,reviewSha256,operationId})` moves exactly that provider identity to the destination. Existing destination providers reject. Preview fingerprints bind the actor including role, both save heads/playtimes and all identity rows including credential material. The reviewed source may lose its final durable sign-in method; previews explicitly warn. Progress and purchases stay with their original accounts.
- `identityUnlink({id,provider,expectedSubject,operationId})` removes the expected identity only. At least one durable email/google/discord/apple method must remain; device/guest identities do not count.
- `identityResetPassword({id,password,expectedSubject,operationId})` replaces the existing email credential password.
- `identitySetEmail({id,email,password,expectedSubject,operationId})` changes an existing email or creates one when `expectedSubject` is explicitly null. Another owner's address rejects. Addresses normalize to lowercase. Password length is 10–256 characters.

Successful writes return `{ok:true,operationId,id,action}`. Retain the exact operation ID and request for retry after a lost acknowledgement. Request replay hashes use an HMAC with the Classic player secret, avoiding persisted plaintext passwords or an unkeyed password verifier. Changing actor, role, action or arguments with an existing operation ID rejects. Receipts and audits contain no passwords, credential hashes or provider tokens.

D1 batches use CHECK-constrained guard rows to compare complete current account state against the state read for validation. A failed comparison throws and rolls back the entire batch, preventing a zero-row identity mutation from revoking sessions, creating an audit or recording a receipt. Concurrent exact retries resolve to the original receipt. Successful transactions revoke all affected sessions and refresh eligibility, device credentials, bootstrap proofs, player-bound outstanding challenges and pending password recoveries. Both move accounts are affected.

Synthetic verification: `node --test tests/admin-identities.test.mjs`. The tests bundle only this module into isolated Miniflare D1 and make no outbound requests.
