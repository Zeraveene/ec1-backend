# Shared EC1 and EC2 admin identity

EC2 owns the authoritative union of `ADMIN_DISCORD_IDS` bootstrap admins and its live D1 `admin_whitelist`, managed in EC2's Admins screen. EC1 has no independent whitelist or fallback. Every authenticated EC1 admin request checks the private EC2 membership authority; removing a database member takes effect on their next EC1 request. Bootstrap admins remain allowed under EC2's existing policy. An unavailable authority returns 503 and performs no admin action.

EC2 exports the named `AdminAuthority` Worker entrypoint. The EC1 production service binding targets that entrypoint on `epicon2-moderation-tool`, exposing only membership checks, public Discord app configuration readiness and OAuth identity exchange. No public HTTP endpoint, EC2 storage binding, whitelist writer or session signer is shared. The Discord exchange uses EC2's current admin app ID and secret, returns only the identified admin profile, and accepts exactly `https://ec1mod.codezrv.com/auth/discord/callback`. Discord token and identity requests each have a ten-second timeout. Provider or authority failures fail closed.

EC1 retains its HMAC signing secret, `ec1_admin` cookie, `ec1/admin` purpose, `ec1-admin` issuer, exact origin audience, one-use OAuth state, revocable D1 sessions, exact-Origin write protection and transactional consequential-write audits. EC2 session cookies cannot authenticate EC1. The shared authority never signs an EC1 session. The EC1 player Discord app remains independently configured.

## Deployment and Discord registration

1. Review and deploy the scoped EC2 authority export, preserving existing Worker variables/secrets and feature gates.
2. In the existing Discord **admin** application used by EC2 (`DISCORD_CLIENT_ID`), open **OAuth2 → Redirects**, add `https://ec1mod.codezrv.com/auth/discord/callback`, and save changes. Preserve existing redirects and the existing client secret; no secret reset or new application is needed.
3. Deploy EC1 with its production `ADMIN_AUTHORITY` binding and `DISCORD_ADMIN_REDIRECT_URI`. No Discord app secret or admin ID list needs to be provisioned in EC1; preserve its existing independent signing secrets.
4. Verify EC1 admin sign-in and a read-only dashboard request with an authorized account, then verify EC2's whitelist change is reflected by EC1. Local automated tests use synthetic providers and isolated D1 and never change real players.

Staging deliberately has no admin authority binding or callback configuration. It fails closed until separately authorized and supported by an explicitly allowed registered callback. A local EC1 Worker can connect to a running EC2 Worker for service-binding development, but the real shared exchange rejects local callbacks; use synthetic tests for local OAuth flows.

The production moderation login lives at `ec1mod.codezrv.com`; `ec1.gacogames.com` remains a separate request origin and cannot initiate that origin-bound admin login.

Cloudflare's [named RPC entrypoint documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) describes this private Worker-to-Worker boundary.
