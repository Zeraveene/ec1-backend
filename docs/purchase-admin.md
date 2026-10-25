# Classic purchase administration

`src/purchases/admin.ts` exports the read-only `dispatchPurchaseAdmin(env, actor, role, operation, args)` projection for the authenticated Classic admin workspace. The EC1-owned `/api/classic-admin` HTTP middleware authenticates the shared Discord session and obtains the current central role on every request. The dispatcher additionally requires the exact `internal` role; managers, guests and unknown roles receive 403 before any database access. It never contacts stores, PlayFab, reporting services or player endpoints, and performs no writes.

## Dashboard and routes

The shared dashboard exposes `/games/ec1/purchases` for internal admins. It adapts EC2's Purchases layout with Classic catalog definitions/icons and dedicated EC1 requests:

- `GET /api/classic-admin/purchases` maps query parameters to `purchases.analytics`.
- `GET /api/classic-admin/purchases/:id` maps to `purchases.detail`.
- `GET /api/classic-admin/purchases/catalog` returns Classic product names, icons, reward definitions and entitlement keys. This describes the current catalog, not the immutable reward contents of a historical sale.

The page includes production counts, WIB activity charts, top products/buyers, filtered recent records, details and the product catalog. Monetary/refund controls remain unavailable until authoritative financial data exists. The current catalog contains store-specific aliases and never uses EC2 product data. No send-sample, refund, entitlement-mutation or purchase-activation endpoint is added.

For a synthetic local preview, run `node scripts/preview-classic-liveops.mjs` from the sibling moderation-tool repo and open `http://127.0.0.1:5196/games/ec1/purchases`. All preview data is disposable; the worker rejects outbound network requests.

## Operations

- `purchases.analytics`: `days` is 1 (default), 7, 30 or 90; `limit` is an integer 1–100 (default 50). Optional `platform` is `google` or `apple`; `status` is `verified_pending`, `granted`, `revoked` or `test`; `q` is at most 80 characters. Empty filters are accepted. `cursor` is the previous response's `nextCursor`.
- `purchases.detail`: `{id}` uses an ID returned in `recent`. Returns `{purchase, readiness}` or 404.

Unknown arguments, malformed IDs/cursors and unsupported operations fail with 400. Storage failures return a fixed `purchase_storage_unavailable` error with status 503; database/provider diagnostics never cross the boundary.

## Analytics scope

The period starts at Jakarta midnight on the first selected calendar day and ends at the initial request's server time, inclusive. `purchasedAt` uses the ledger's server-verified `StoreFacts.purchaseTime` when it is a nonnegative finite integer/number no later than verification plus one minute, and otherwise falls back to ledger `created_at`. Timestamp fields are milliseconds. Historical receipt-only and arbitrary client price data are never treated as verified financial facts.

Totals, products, buyers, daily counts, hourly counts and the previous-period count cover only rows explicitly marked `production`. Revoked and pending-delivery rows remain counted and are separately counted in `totals`; counts do not imply successful delivery or net sales. The previous comparison covers the immediately preceding equal number of calendar days. `environments` counts every environment for the selected period, separately. Test and sandbox rows appear in `recent`, never production summaries.

The platform/status/search filters apply only to `recent`, matching the shared purchasing dashboard's existing filter behavior. The `test` convenience status selects `test` and `sandbox` environments. Search covers player IDs, display names, product IDs, Apple transaction IDs and recognized Google GPA order IDs; `%`, `_` and backslash are literal characters. Products return at most 100 grouped rows, buyers 10, daily at most 90 and hourly at most 24. Recent rows return at most `limit` plus one internal look-ahead row. Group ties are deterministic. Pagination uses purchase time plus ledger row ID and preserves the initial period end, with cursors bound to days/platform/status/search. Changing those filters requires clearing the cursor. Summary values are recalculated from current ledger state; cursors do not promise a database snapshot across requests.

IDs `p_<base36 rowid>` and cursor row IDs are database-local admin lookup references. They contain no purchase proof or ledger hash. Do not persist them as external business transaction identifiers: SQLite maintenance that rebuilds a table or changes implicit row IDs can invalidate them. The API never returns `purchase_key`, receipt hashes, Google token hashes, proofs, account bindings, raw `facts_json`, credential configuration or operation IDs. Google `transaction_id` stores a token hash and is never displayed or searched. Only a verified `google_api` facts `orderId` matching the one-time-purchase `GPA.1234-5678-9012-34567` format is displayed/searched instead; synthetic fallback keys and unsupported order formats remain null. Apple signed transaction IDs are displayed. Details include safe immutable ledger metadata and grant `saveVersion`/`grantedAt` fields.

## Response and unavailable capabilities

Analytics returns `{since, until, timeZone, totals, products, daily, hourly, buyers, environments, recent, previous, nextCursor, limit, readiness}` plus shared-dashboard financial placeholders. `totals` includes production `purchases`, distinct `buyers`, `units`, `verifiedPending`, `granted`, `revoked`, `unknownAmounts`, and `refundedPurchases: null`.

The current Classic verifier persists environment, quantity, verification source, purchase time, order ID and private account binding. It does **not** persist authoritative amount/currency, USD conversions, refund state, refund amounts or country. Extra JSON keys resembling price, currency or refunds are ignored. Therefore:

- Every purchase's `amountMicros`, `currency`, `amountSource`, `usdMicros`, `refundedMicros` and `country` is null; `refundStatus` is `unknown`.
- `unknownAmounts` equals the production purchase count. `refundedPurchases`, `todayUsd` and `periodUsd` are null, including an empty ledger.
- `revenue` and `countries` are empty arrays. Product/buyer/day/hour/previous monetary values and day/hour refund counts are null.
- `readiness.purchasesEnabled` reflects the existing legacy claim gate: exactly `IAP_PURCHASES_ENABLED=true` and manual-backup mode disabled. It does not imply the new independent delivery protocol is ready. `readiness.ledger` is true; `financialAmounts`, `usdNormalization`, `refundReconciliation`, `country`, `reports`, `deliveryProtocolReady`, `refundChecksReady`, `reportsEnabled` and `reportingConfigured` are false. The last four are also provided as top-level flags where applicable.

`revoked` is the ledger delivery/entitlement state, not proof of a financial refund. Catalog prices, client receipt metadata and absence of a revocation are not evidence of an amount or a no-refund state. Reporting and store reconciliation controls must remain unavailable until the corresponding server capability and authoritative data exist. No migration is needed for this read projection.

## Validation

`node --test tests/purchase-admin.test.mjs` bundles the real dispatcher and executes it in Miniflare against isolated D1 with every local migration and synthetic ledger/player data. Tests cover role fail-closure, day windows, production/test/sandbox separation, equal-time keyset pages, Unicode and literal wildcard search, safe Google order search, malformed/extra arguments, safe details, missing finance, malformed facts and redacted database outages. Outbound requests are forbidden. `npm run typecheck` validates the integrated TypeScript contract.
