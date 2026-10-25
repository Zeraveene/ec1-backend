import { searchLegacy, viewLegacy } from './legacy-playfab';
import { GameError } from '../game/validation';
import type { Env } from "../env";

export type Operation = "status" | "players" | "player" | "audit" | "legacy-search" | "legacy-player";
export type Result = { status: number; body: unknown };
const fields = "id,display_name,save_version,playtime,save_state,created_at,updated_at,migrated_at";
const fail = (status: number, error: string): Result => ({ status, body: { error } });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function cursor(value: unknown, scope: string): { time: number; id: string } | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("args");
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
  if (!record(parsed) || parsed.scope !== scope || !Number.isSafeInteger(parsed.time) || (parsed.time as number) < 0 || !identifier(parsed.id)) throw new Error("args");
  return { time: parsed.time as number, id: parsed.id };
}
function encode(scope: string, time: unknown, id: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ scope, time, id })))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Internal projection layer. Callers must establish a current trusted admin first. */
export async function readWorkspace(env: Env, operation: Operation, args: Record<string, unknown> = {}): Promise<Result> {
    if (!record(args) || !["status", "players", "player", "audit", "legacy-search", "legacy-player"].includes(operation)) return fail(400, "invalid_arguments");
    const allowed = operation === "legacy-search" ? ["query"] : operation === "legacy-player" ? ["id"] : operation === "players" ? ["query", "cursor"] : operation === "player" ? ["id"] : operation === "audit" ? ["cursor"] : [];
    if (Object.keys(args).some(key => !allowed.includes(key))) return fail(400, "invalid_arguments");
    let query = "", after: ReturnType<typeof cursor> = null;
    try {
      if (operation === "player" && !identifier(args.id)) throw new Error("args");
      if (operation === "players") {
        if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 100 || /[\u0000-\u001f\u007f]/.test(args.query))) throw new Error("args");
        query = (args.query as string | undefined)?.trim() ?? "";
      }
      if (operation === "players" || operation === "audit") after = cursor(args.cursor, operation + ":" + query);
    } catch { return fail(400, "invalid_arguments"); }
    if (operation === 'legacy-search' || operation === 'legacy-player') {
      if (operation === 'legacy-search' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 100 || /[\u0000-\u001f\u007f]/.test(args.query)) || operation === 'legacy-player' && (typeof args.id !== 'string' || !/^[A-Fa-f0-9]{8,64}$/.test(args.id))) return fail(400, 'invalid_arguments');
      try { return { status: 200, body: operation === 'legacy-search' ? await searchLegacy(env, (args.query as string).trim()) : await viewLegacy(env, args.id as string) }; }
      catch (error) { return fail(error instanceof GameError ? error.status : 503, error instanceof GameError ? error.code : 'legacy_source_unavailable'); }
    }
    try {
      const db = env.DB;
      if (operation === "status") {
        const count = await db.prepare("SELECT count(*) AS total FROM player").first<{ total: number }>();
        if (!count) throw new Error("storage");
        return { status: 200, body: { game: "ec1", environment: env.ENVIRONMENT ?? "local", players: count.total, migrationEnabled: env.LEGACY_MIGRATION_ENABLED === "true", newAccountsEnabled: env.ALLOW_NEW_ACCOUNTS === "true", purchasesEnabled: env.IAP_PURCHASES_ENABLED === "true", manualBackupsEnabled: env.EC1_MANUAL_BACKUPS_ENABLED === "true", recoveryEnabled: env.RECOVERY_ENABLED === "true" } };
      }
      if (operation === "player") {
        const player = await db.prepare(`SELECT ${fields} FROM player WHERE id=?`).bind(args.id).first();
        if (!player) return fail(404, "player_not_found");
        const [identities, revisions, mail] = await Promise.all([
          db.prepare("SELECT provider,subject,created_at FROM auth_identity WHERE player_id=? ORDER BY provider LIMIT 100").bind(args.id).all(),
          db.prepare("SELECT version,playtime,sha256,created_at FROM save_revision WHERE player_id=? ORDER BY version DESC LIMIT 100").bind(args.id).all(),
          db.prepare("SELECT id,title,created_at,read_at,claimed_at FROM mail WHERE player_id=? ORDER BY created_at DESC,id DESC LIMIT 100").bind(args.id).all(),
        ]);
        const canonicalAvailable = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classic_backup_revision'").first();
        const canonicalRevisions = canonicalAvailable ? (await db.prepare("SELECT revision,playtime,sha256,bytes,schema_version,created_at,source,restored_from FROM classic_backup_revision WHERE player_id=? ORDER BY revision DESC LIMIT 100").bind(args.id).all()).results : [];
        const canonicalHead = canonicalAvailable ? await db.prepare("SELECT revision FROM classic_backup_head WHERE player_id=?").bind(args.id).first() : null;
        return { status: 200, body: { player, canonicalBackups: {format:"canonical",headRevision:canonicalHead?.revision ?? 0,revisions:canonicalRevisions}, identities: identities.results, revisions: revisions.results, mail: mail.results } };
      }
      const isPlayers = operation === "players", time = isPlayers ? "updated_at" : "created_at";
      const conditions: string[] = [], bindings: (string | number)[] = [];
      if (isPlayers && query) { conditions.push("(instr(id,?)>0 OR instr(COALESCE(display_name,''),?)>0)"); bindings.push(query, query); }
      if (after) { conditions.push(`(${time}<? OR (${time}=? AND id<?))`); bindings.push(after.time, after.time, after.id); }
      const result = await db.prepare(`SELECT ${isPlayers ? fields : "id,actor_id,actor_name,action,player_id,created_at"} FROM ${isPlayers ? "player" : "admin_audit"}${conditions.length ? " WHERE " + conditions.join(" AND ") : ""} ORDER BY ${time} DESC,id DESC LIMIT 101`).bind(...bindings).all();
      const rows = result.results.slice(0, 100), last = rows.at(-1);
      return { status: 200, body: { [isPlayers ? "players" : "events"]: rows, nextCursor: result.results.length > 100 && last ? encode(operation + ":" + query, last[time], last.id) : null } };
    } catch { return fail(503, "storage_unavailable"); }
}
