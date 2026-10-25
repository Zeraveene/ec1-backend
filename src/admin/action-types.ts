export type AdminRole = "internal" | "manager" | "guest";
export interface AdminActor { id: string; name: string; role: AdminRole }
export class AdminActionError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function requireWriter(actor: AdminActor): void {
  if (actor.role !== "internal") throw new AdminActionError("forbidden_role", 403);
}
