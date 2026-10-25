import { canonicalRevisionList,canonicalRevisionGet,canonicalRevisionPreview,canonicalRevisionRestore } from './canonical-revisions';
import type { Env } from '../env';
import { AdminActionError, requireWriter, type AdminActor } from './action-types';
import { publishSnapshot } from '../game/storage';
import { sha256, stableJson, validateSnapshot, type Snapshot } from '../game/validation';
interface Row {
    version: number;
    sha256: string;
    playtime: number;
    operation_id: string;
    created_at: number;
    r2_key: string;
}
function id(args: Record<string, unknown>): string { if (typeof args.id !== 'string' || !args.id.length || args.id.length > 256)
    throw new AdminActionError('invalid_player_id'); return args.id; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new AdminActionError('invalid_version'); return Number(value); }
function metadata(row: Row) { return { version: row.version, sha256: row.sha256, playtime: row.playtime, operationId: row.operation_id, createdAt: row.created_at }; }
async function player(env: Env, playerId: string) { const p = await env.DB.prepare('SELECT save_version,playtime FROM player WHERE id=?').bind(playerId).first<{
    save_version: number;
    playtime: number;
}>(); if (!p)
    throw new AdminActionError('player_not_found', 404); return p; }
async function revision(env: Env, playerId: string, version: number) { const r = await env.DB.prepare('SELECT * FROM save_revision WHERE player_id=? AND version=?').bind(playerId, version).first<Row>(); if (!r)
    throw new AdminActionError('revision_not_found', 404); return r; }
async function verified(env: Env, row: Row): Promise<{
    snapshot: Snapshot;
    content: string;
}> {
    try {
        const object = await env.PLAYER_SAVES.get(row.r2_key);
        if (!object)
            throw new Error();
        const content = await object.text();
        if (await sha256(content) !== row.sha256)
            throw new Error();
        const value = JSON.parse(content);
        const { snapshot } = validateSnapshot(value, true);
        if (snapshot.playtime !== row.playtime || snapshot.operationId !== row.operation_id || snapshot.expectedSaveVersion !== row.version - 1)
            throw new Error();
        return { snapshot, content };
    }
    catch {
        throw new AdminActionError('revision_integrity_unavailable', 503);
    }
}
export async function revisionList(env: Env, _actor: AdminActor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if(args.format === 'canonical') return canonicalRevisionList(env, _actor, args);
    if(args.format !== undefined && args.format !== 'legacy') throw new AdminActionError('invalid_revision_format');
    const playerId = id(args);
    await player(env, playerId);
    let before = Number.MAX_SAFE_INTEGER;
    if (args.cursor !== undefined) {
        try {
            if (typeof args.cursor !== 'string')
                throw new Error();
            const c = JSON.parse(decodeURIComponent(atob(args.cursor)));
            if (c.id !== playerId)
                throw new Error();
            before = integer(c.before);
        }
        catch {
            throw new AdminActionError('invalid_revision_cursor');
        }
    }
    const rows = await env.DB.prepare('SELECT * FROM save_revision WHERE player_id=? AND version<? ORDER BY version DESC LIMIT 101').bind(playerId, before).all<Row>();
    const shown = rows.results.slice(0, 100);
    return { playerId, revisions: shown.map(metadata), nextCursor: rows.results.length > 100 ? btoa(encodeURIComponent(JSON.stringify({ id: playerId, before: shown.at(-1)!.version }))) : null };
}
export async function revisionGet(env: Env, actor: AdminActor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if(args.format === 'canonical') return canonicalRevisionGet(env, actor, args);
    if(args.format !== undefined && args.format !== 'legacy') throw new AdminActionError('invalid_revision_format');
    requireWriter(actor);
    const playerId = id(args);
    await player(env, playerId);
    const row = await revision(env, playerId, integer(args.version));
    const { snapshot, content } = await verified(env, row);
    return { playerId, revision: metadata(row), snapshot, download: { filename: `classic-revision-${row.version}.json`, contentType: 'application/json', content } };
}
export async function revisionPreviewRestore(env: Env, actor: AdminActor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if(args.format === 'canonical') return canonicalRevisionPreview(env, actor, args);
    if(args.format !== undefined && args.format !== 'legacy') throw new AdminActionError('invalid_revision_format');
    requireWriter(actor);
    const playerId = id(args), sourceVersion = integer(args.version), p = await player(env, playerId);
    const source = await revision(env, playerId, sourceVersion);
    await verified(env, source);
    let currentHash: string | null = null;
    if (p.save_version) {
        const current = await revision(env, playerId, p.save_version).catch(() => { throw new AdminActionError('revision_integrity_unavailable', 503); });
        await verified(env, current);
        if (current.playtime !== p.playtime)
            throw new AdminActionError('revision_integrity_unavailable', 503);
        currentHash = current.sha256;
    }
    else if (p.playtime !== 0)
        throw new AdminActionError('revision_integrity_unavailable', 503);
    const reviewSha256 = await sha256(stableJson({ actorId: actor.id, playerId, currentVersion: p.save_version, currentSha256: currentHash, sourceVersion, sourceSha256: source.sha256 }));
    return { playerId, currentVersion: p.save_version, sourceVersion, reviewSha256, current: { version: p.save_version, playtime: p.playtime, sha256: currentHash }, source: { version: sourceVersion, playtime: source.playtime, sha256: source.sha256 }, warning: source.playtime < p.playtime };
}
export async function revisionRestore(env: Env, actor: AdminActor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if(args.format === 'canonical') return canonicalRevisionRestore(env, actor, args);
    if(args.format !== undefined && args.format !== 'legacy') throw new AdminActionError('invalid_revision_format');
    requireWriter(actor);
    const playerId = id(args), sourceVersion = integer(args.version), expectedSaveVersion = args.expectedSaveVersion;
    if (!Number.isSafeInteger(expectedSaveVersion) || Number(expectedSaveVersion) < 0 || typeof args.reviewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.reviewSha256) || typeof args.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(args.operationId))
        throw new AdminActionError('invalid_restore_request');
    const detail = { sourceVersion, expectedSaveVersion, reviewSha256: args.reviewSha256, operationId: args.operationId };
    const auditId = `classic-restore:${playerId}:${args.operationId}`;
    const receipt = await env.DB.prepare('SELECT a.actor_id,a.detail_json,r.version,r.playtime,r.operation_id FROM save_operation o JOIN save_revision r ON r.player_id=o.player_id AND r.version=o.version LEFT JOIN admin_audit a ON a.id=? AND a.player_id=o.player_id WHERE o.player_id=? AND o.operation_id=?').bind(auditId, playerId, args.operationId).first<{
        actor_id: string | null;
        detail_json: string | null;
        version: number;
        playtime: number;
        operation_id: string;
    }>();
    const result = (version: number, playtime: number) => ({ playerId, saveVersion: version, playtime, ...detail });
    if (receipt) {
        if (receipt.actor_id !== actor.id || receipt.detail_json !== stableJson(detail))
            throw new AdminActionError('operation_id_reused', 409);
        return result(receipt.version, receipt.playtime);
    }
    const preview = await revisionPreviewRestore(env, actor, args);
    if (preview.currentVersion !== expectedSaveVersion || preview.reviewSha256 !== args.reviewSha256)
        throw new AdminActionError('save_conflict', 409);
    const { snapshot } = await verified(env, await revision(env, playerId, sourceVersion));
    const saved = await publishSnapshot(env, playerId, { ...snapshot, expectedSaveVersion, operationId: args.operationId }, { legacy: true, allowPlaytimeDecrease: true, preserveSourceData: true, adminAudit: { id: auditId, actorId: actor.id, actorName: actor.name, action: 'save.restore', detail } });
    return result(saved.saveVersion, saved.playtime);
}
