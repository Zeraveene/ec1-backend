import { WorkerEntrypoint } from "cloudflare:workers";
import { auditLegacyRead } from './legacy-playfab';
import type { Env } from "../env";

import { readWorkspace, type Operation, type Result } from "./workspace-read";
const fail = (status: number, error: string): Result => ({ status, body: { error } });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Private RPC entrypoint; its getRole authorization remains independent of HTTP session introspection. */
export class AdminWorkspace extends WorkerEntrypoint<Env> {
  async read(actor: { id: string; name: string }, operation: Operation, args: Record<string, unknown> = {}): Promise<Result> {
    if (!record(actor) || typeof actor.id !== "string" || !/^\d{17,20}$/.test(actor.id) || typeof actor.name !== "string" || actor.name.length < 1 || actor.name.length > 100 || /[\u0000-\u001f\u007f]/.test(actor.name)) return fail(400, "invalid_actor");
    try {
      if (typeof this.env.ADMIN_AUTHORITY?.getRole !== "function") return fail(503, "admin_authority_unavailable");
      const role = await this.env.ADMIN_AUTHORITY.getRole(actor.id);
      if (role === null) return fail(403, "admin_not_allowed");
      if (role !== "internal" && role !== "manager" && role !== "guest") return fail(503, "admin_authority_unavailable");
    } catch { return fail(503, "admin_authority_unavailable"); }
    if (!record(args)) return fail(400, 'invalid_arguments');
    if (operation === 'legacy-search' || operation === 'legacy-player') {
      try { await auditLegacyRead(this.env, actor, operation, args); }
      catch { return fail(503, 'audit_unavailable'); }
    }
    return readWorkspace(this.env, operation, args);
  }
}
