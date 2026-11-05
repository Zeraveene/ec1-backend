import type { Env } from '../env';
import { AdminActionError } from './action-types';
import { inspectLegacySave } from './legacy-save';
import { verifiedCanonicalRevision, type Row as CanonicalRow } from './canonical-revisions';
import { verifiedLegacyRevision, type Row as LegacyRow } from './revisions';

/** Inspect the current stored backend backup, without PlayFab reads or save writes. */
export async function playerSaveView(env: Env, id: string) {
  const player = await env.DB.prepare('SELECT id,display_name,save_version,created_at FROM player WHERE id=? AND save_state!="deleted"')
    .bind(id).first<{ id: string; display_name: string | null; save_version: number; created_at: number }>();
  if (!player) throw new AdminActionError('player_not_found', 404);
  let payload: unknown, playtime: number | undefined, savedAt: number | undefined, revision = 0, source = 'none';
  const canonicalAvailable = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classic_backup_head'").first();
  const head = canonicalAvailable ? await env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first<{ revision: number }>() : null;
  if (head) {
    const row = await env.DB.prepare('SELECT * FROM classic_backup_revision WHERE player_id=? AND revision=?').bind(id, head.revision).first<CanonicalRow>();
    if (!row) throw new AdminActionError('revision_integrity_unavailable', 503);
    payload = await verifiedCanonicalRevision(env, row);
    playtime = row.playtime; savedAt = row.created_at; revision = row.revision; source = 'canonical_backup';
  } else if (player.save_version > 0) {
    const row = await env.DB.prepare('SELECT * FROM save_revision WHERE player_id=? AND version=?').bind(id, player.save_version).first<LegacyRow>();
    if (!row) throw new AdminActionError('revision_integrity_unavailable', 503);
    payload = (await verifiedLegacyRevision(env, row)).snapshot.data.CLOUD_ALL_DATA;
    playtime = row.playtime; savedAt = row.created_at; revision = row.version; source = 'legacy_backend';
  }
  return {
    profile: { id, displayName: player.display_name, username: null, email: null, createdAt: new Date(player.created_at).toISOString(), lastLogin: null },
    revision, source, savedAt: savedAt === undefined ? null : new Date(savedAt).toISOString(),
    ...inspectLegacySave(payload, playtime),
  };
}
