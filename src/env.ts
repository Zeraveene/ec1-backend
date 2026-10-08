export interface Env {
  DB: D1Database;
  PLAYER_SAVES: R2Bucket;
  AUDIT_BLOBS: R2Bucket;
  LEGACY_ARCHIVE: R2Bucket;
  ASSETS?: Fetcher;
  PLAYER_TOKEN_SECRET: string;
  ADMIN_SESSION_SECRET?: string;
  ADMIN_DISCORD_IDS?: string;
  DISCORD_ADMIN_CLIENT_ID?: string;
  DISCORD_ADMIN_CLIENT_SECRET?: string;
  DISCORD_ADMIN_REDIRECT_URI?: string;
  GOOGLE_CLIENT_IDS?: string;
  APPLE_CLIENT_IDS?: string;
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
