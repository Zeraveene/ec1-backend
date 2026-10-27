# Editor purchase testing

Unity Editor purchases use `POST /api/purchases/editor-test` with the current authenticated player session, `test:true`, and an operation ID journaled before the request. They do not send store receipts or a gameplay snapshot. Production store validation is unchanged.

`IAP_EDITOR_TEST_ENABLED=true` and an exact comma-separated `IAP_EDITOR_TEST_PLAYERS` allowlist are both required. The current production configuration permits only `26B502B30D4FE386`. Staging remains disabled unless separately configured. This switch is independent of real store purchasing and manual backup settings.

Migration `034_editor_purchase_grants.sql` adds immutable-by-contract grant payload storage and per-operation replay identity. A grant and a `purchase_ledger` entry publish in one D1 batch with `environment=test`, `verification_source=unity_editor`, and no financial amounts. The catalog supplies all rewards. Client reward fields, arbitrary environments, retired products, unlisted players and migration-scoped sessions are rejected.

The client durably applies the response once, then calls `POST /api/purchases/editor-test/:grantId/ack`. Acknowledgement is bound to the authenticated player and original operation. It is repeatable and never republishes a cloud save. Device builds do not process Editor test requests from a copied local purchase journal.

The request has no confirmation popup; explicit sign-in may still use the shared Accounts screen if the player has no session. Network failures retain the same operation and grant for retry. No local simulated-grant fallback remains.
