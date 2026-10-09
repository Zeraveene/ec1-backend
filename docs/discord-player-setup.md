# EC1 Discord player authentication

EC1 uses player application `1557970385440481310` (Epic Conquest 1), independent of EC2's player app and the shared moderation app. On 2026-10-09 the Discord portal saved the description `Link your account to Discord.`, Terms of Service `https://legal.gacogames.com/terms`, and Privacy Policy `https://legal.gacogames.com/privacy`, copied from EC2's player application.

Registered player redirects:

- Editor: `http://127.0.0.1:18082/oauth/discord/callback`
- Android/iOS: `discord-1557970385440481310:/authorize/callback`
- Browser, production: `https://ec1mod.codezrv.com/api/auth/discord/callback`
- Browser, staging: `https://epicon1-backend-staging.johanesnindyo.workers.dev/api/auth/discord/callback`

The Worker exchanges authorization codes with the EC1 client secret and PKCE verifier. Keep Public Client disabled. The browser requests only `identify`; bot installation, email, guild, voice and presence permissions are unnecessary. Production permits its browser and mobile redirects; staging permits its own browser, Editor and mobile redirects. Set `DISCORD_GAME_CLIENT_SECRET` through Wrangler secrets, never through public variables or Unity assets.

`src/auth/discord-bridge.ts` owns the HTTPS bridge. It verifies a live, unused Discord challenge issued for the exact callback, rejects malformed/duplicate parameters, sets no-store/no-referrer headers and forwards only code/state or cancellation to `gacogames-ec1-bridge://oauth/discord`. It does not exchange codes or mint sessions. The game retains the verifier and exchanges the proof through `/api/auth/provider/discord`; that route owns one-use state, PKCE, sign-in/create/link intent and account publication. The client uses the SDK when `EC1_DISCORD_SOCIAL_SDK` is enabled, and the browser bridge otherwise. Android/iOS build processors register the EC1 browser scheme only for backend-gated builds. Editor keeps its loopback flow.

The shared moderation application `1499961450536636617` already includes `https://ec1mod.codezrv.com/auth/discord/callback`; this was verified in the portal on 2026-10-09. Its credentials stay in EC2.

Bridge deployed to staging (`90ca9656-19cb-4241-bd48-cbd841aec951`) and production (`a3bb681a-b848-4692-adb5-69c238a0bbae`) on 2026-10-09. TypeScript, all 57 synthetic integration tests and dashboard build passed. Unity recompiled without errors and the synthetic harness passed 152 assertions plus its separate purchase checks. Both live bridge endpoints reject unknown state with 401 and no-store. Production creation and migration remain disabled.

The user provisioned the production client secret on 2026-10-09. Live production challenge issuance now returns 200 with the EC1 app ID, exact production callback, identify scope, S256 PKCE and bound state. A cancellation callback returns 302 to the fixed EC1 deep link. These checks do not validate the secret through Discord token exchange. Staging still returns 503 provider_not_configured; provision the same EC1 app secret there with `npx wrangler secret put DISCORD_GAME_CLIENT_SECRET --env staging`.

The user subsequently requested removal of the staging Worker. `epicon1-backend-staging` was deleted on 2026-10-09; do not provision its secret or redeploy it. Historical staging references above describe the earlier setup. Use production for further Discord configuration. Staging storage resources were not part of the Worker deletion request.

Pending: real login and signed builds. Unity Social SDK 1.10.19337 is installed and its adapter API and Windows native PKCE were checked. Mobile SDK activation still requires application ID configuration, mobile callback build setup and signed-device tests; browser fallback does not require that package.

Social SDK access: EC1 belongs to the Gaco Games developer team. Enrollment was completed by the user; the Downloads page was verified on 2026-10-09 and the downloaded UnityPlugin 1.10.19337 archive was installed. Keep client secrets on the backend even when using the SDK.

Official callback format: https://docs.discord.com/developers/discord-social-sdk/development-guides/account-linking-on-mobile
