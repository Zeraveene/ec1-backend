# Public EC1 clock

`GET /api/public/time` returns HTTP 200:

```json
{"serverTime":"2026-10-25T00:00:00.000Z","unixTimeMs":1792886400000}
```

Both fields describe the same instant from EC1's Worker clock. `serverTime` is an ISO 8601 UTC string, compatible with the EC2 clock response shape; `unixTimeMs` is Unix epoch milliseconds. Responses use `Cache-Control: no-store` to avoid stale countdown baselines.

No player session, PlayFab request, EC2 service, database or save is needed. This endpoint supplies time only; it does not grant rewards, reset entries, upload backups or decide offline reward behavior. The older authenticated `/api/game/time` remains unchanged.

Unity integration uses the application-owned `Ec1ServerClock`: shared reward timers advance using elapsed time and resynchronize on lobby entry/resume. Existing attendance and timed-reward cooldown rules are preserved. Network and parsing failures disable clock-dependent availability until a retry succeeds.

Deployed October 25, 2026, Worker version `4433e191-07c9-49a2-8822-89e301864bd1`; public URL `https://ec1mod.codezrv.com/api/public/time` returned HTTP 200 with `Cache-Control: no-store` and matching timestamps. Deployment used an isolated copy of commit `c684ee1` plus only the public clock route/module, preserving production variables with `--keep-vars`. Unrelated working-tree leaderboard changes were excluded; no database migration was needed. Typecheck, the four worker tests, dashboard build and Wrangler dry run passed. The full backend suite passed 163/164 tests; the historical UTC daily-reset test also failed when repeated with the unchanged committed entry point.
