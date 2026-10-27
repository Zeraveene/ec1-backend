export interface Env {
  STORY_TEST_ENABLED?: string;
  STORY_TEST_PLAYERS?: string;
  STORY_TEST_COUPON?: string;
  EC1_MANUAL_BACKUPS_ENABLED?: string;
  DB: D1Database;
  PLAYER_SAVES: R2Bucket;
  AUDIT_BLOBS: R2Bucket;
  LEGACY_ARCHIVE: R2Bucket;
  ASSETS?: Fetcher;
  EMAIL?: SendEmail;
  MAIL_FROM?: string;
  PASSWORD_RESET_ORIGIN?: string;
  RECOVERY_ENABLED?: string;
  IAP_PURCHASES_ENABLED?: string;
  IAP_GOOGLE_PUBLIC_KEY?: string;
  IAP_GOOGLE_SERVICE_ACCOUNT?: string;
  IAP_GOOGLE_PACKAGE_NAME?: string;
  IAP_APPLE_BUNDLE_ID?: string;
  IAP_APPLE_VERIFICATION_MODE?: string;
  IAP_ALLOW_TEST_PURCHASES?: string;
  IAP_EDITOR_TEST_ENABLED?: string;
  IAP_EDITOR_TEST_PLAYERS?: string;
  PLAYER_TOKEN_SECRET: string;
  ADMIN_SESSION_SECRET?: string;
  // Default entrypoint; introspects the existing central admin session only.
  EC2_ADMIN_SESSION?: Fetcher;
  CLASSIC_ADMIN_ORIGIN?: string;
  ADMIN_AUTHORITY?: {
    getRole?(discordId: string): Promise<"internal" | "manager" | "guest" | null>;
    isAllowed(discordId: string): Promise<boolean>;
    getConfiguration(): Promise<{ configured: boolean; clientId?: string }>;
    exchangeIdentity(
      code: string,
      redirectUri: string,
    ): Promise<
      | {
          id: string;
          username: string;
          global_name: string | null;
          error?: never;
        }
      | { error: string; id?: never; username?: never; global_name?: never }
    >;
  };
  DISCORD_ADMIN_REDIRECT_URI?: string;
  GOOGLE_CLIENT_IDS?: string;
  GOOGLE_EDITOR_CLIENT_ID?: string;
  GOOGLE_EDITOR_CLIENT_SECRET?: string;
  GOOGLE_EDITOR_REDIRECT_URIS?: string;
  APPLE_CLIENT_IDS?: string;
  GOOGLE_BROWSER_CLIENT_ID?: string;
  GOOGLE_BROWSER_CLIENT_SECRET?: string;
  GOOGLE_BROWSER_REDIRECT_URI?: string;
  APPLE_BROWSER_CLIENT_ID?: string;
  APPLE_BROWSER_TEAM_ID?: string;
  APPLE_BROWSER_KEY_ID?: string;
  APPLE_BROWSER_PRIVATE_KEY?: string;
  APPLE_BROWSER_REDIRECT_URI?: string;
  DISCORD_GAME_CLIENT_ID?: string;
  DISCORD_GAME_CLIENT_SECRET?: string;
  DISCORD_GAME_REDIRECT_URIS?: string;
  PLAYFAB_TITLE_ID?: string;
  PLAYFAB_SECRET_KEY?: string;
  LEGACY_MIGRATION_ENABLED?: string;
  ALLOW_NEW_ACCOUNTS?: string;
  ENVIRONMENT?: string;
}

export interface PlayerContext {
  playerId: string;
  sessionId: string;
  provider: string;
  deviceId: string | null;
  scope: "player" | "migration";
}

export type AppEnv = {
  Bindings: Env;
  Variables: { player: PlayerContext; admin: { id: string; name: string } };
};
