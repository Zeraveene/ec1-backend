import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from '../env';
import { requirePlayer } from '../auth';
import { AuthError } from '../auth/providers';
import { GameError } from '../game/validation';
import { getGrant, grantInsertFromSelect, validateGrantRewards } from './grants';
type Actor = {
    id: string;
    name: string;
};
type Reply = {
    status: number;
    body: Record<string, unknown>;
};
type Row = {
    id: string;
    titles_json: string;
    bodies_json: string;
    publish_at: number | null;
    expire_at: number | null;
    pinned: number;
    draft: number;
    archived: number;
    sort_order: number;
    rewards_json: string;
    revision: number;
    created_at: number;
    updated_at: number;
};
class NewsError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
function fail(message: string, status = 400): never { throw new NewsError(message, status); }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail('invalid_arguments');
const identifier = (v: unknown): string => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v) ? v : fail('invalid_news_id');
const opId = (v: unknown): string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : fail('invalid_operation_id');
const integer = (v: unknown, min = 0, max = 2147483647): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('invalid_integer');
function localized(v: unknown, max: number) { const x = object(v); if (Object.keys(x).some(k => k !== 'en' && k !== 'id'))
    fail('unsupported_language'); const out: Record<string, string> = {}; for (const [k, s] of Object.entries(x)) {
    if (typeof s !== 'string' || !s.trim() || s.length > max || /[<>\u0000]/.test(s))
        fail('invalid_plain_text');
    out[k] = s;
} if (!out.en)
    fail('english_required'); return out; }
function date(v: unknown): number | null { if (v === null)
    return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)))
    fail('invalid_utc_date'); return Date.parse(v as string); }
function rewards(value: unknown) { try {
    return validateGrantRewards(value, true);
}
catch {
    fail('invalid_rewards');
} }
function post(value: unknown, id?: string) { const p = object(value); if (JSON.stringify(p).length > 100000)
    fail('post_too_large'); if (Object.keys(p).some(k => !['id', 'titles', 'bodies', 'publishAt', 'expireAt', 'pinned', 'draft', 'order', 'rewards'].includes(k)))
    fail('unknown_post_field'); const key = identifier(p.id); if (id && key !== id)
    fail('immutable_news_id'); if (typeof p.pinned !== 'boolean' || typeof p.draft !== 'boolean')
    fail('invalid_boolean'); const start = date(p.publishAt), end = date(p.expireAt); if (start !== null && end !== null && end <= start)
    fail('invalid_window'); return { id: key, titles: localized(p.titles, 200), bodies: localized(p.bodies, 20000), publishAt: start, expireAt: end, pinned: p.pinned, draft: p.draft, order: integer(p.order, -1000000, 1000000), rewards: rewards(p.rewards ?? []) }; }
function wire(r: Row, detail = true) { return { id: r.id, titles: JSON.parse(r.titles_json), ...(detail ? { bodies: JSON.parse(r.bodies_json) } : {}), publishAt: r.publish_at === null ? null : new Date(r.publish_at).toISOString(), expireAt: r.expire_at === null ? null : new Date(r.expire_at).toISOString(), pinned: !!r.pinned, draft: !!r.draft, archived: !!r.archived, order: r.sort_order, rewards: JSON.parse(r.rewards_json), revision: r.revision }; }
const live = 'archived=0 AND draft=0 AND (publish_at IS NULL OR publish_at<=?) AND (expire_at IS NULL OR expire_at>?)';
function page(args: Record<string, unknown>) { const limit = args.limit === undefined ? 50 : integer(args.limit, 1, 100); const raw = args.cursor ?? '0'; if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw))
    fail('invalid_cursor'); return { limit, offset: integer(Number(raw), 0, 1000000) }; }
async function list(env: Env, args: Record<string, unknown>, publicOnly: boolean): Promise<Reply> { const { limit, offset } = page(args), now = Date.now(); const rows = await env.DB.prepare(`SELECT * FROM liveops_news ${publicOnly ? 'WHERE ' + live : ''} ORDER BY pinned DESC,sort_order ASC,id ASC LIMIT ? OFFSET ?`).bind(...(publicOnly ? [now, now] : []), limit + 1, offset).all<Row>(); return { status: 200, body: { game: 'ec1', news: rows.results.slice(0, limit).map(r => wire(r, false)), nextCursor: rows.results.length > limit ? String(offset + limit) : null } }; }
async function digest(value: unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function readOperation(env: Env, actor: Actor, id: string, fingerprint: string): Promise<Reply | null> { const row = await env.DB.prepare('SELECT fingerprint,response_json FROM liveops_news_operation WHERE actor_id=? AND operation_id=?').bind(actor.id, id).first<{
    fingerprint: string;
    response_json: string;
}>(); if (!row)
    return null; if (row.fingerprint !== fingerprint)
    fail('operation_conflict', 409); return JSON.parse(row.response_json); }
export async function dispatchNewsAdmin(env: Env, actor: Actor, role: 'internal' | 'manager' | 'guest', operation: string, args: Record<string, unknown>): Promise<Reply> {
    try {
        if (role !== 'internal' && role !== 'manager' && role !== 'guest')
            fail('forbidden', 403);
        object(args);
        const fields: Record<string, string[]> = { 'news.list': ['limit', 'cursor'], 'news.detail': ['id'], 'news.create': ['operationId', 'post'], 'news.update': ['id', 'operationId', 'expectedRevision', 'post'], 'news.publish': ['id', 'operationId', 'expectedRevision', 'published'], 'news.archive': ['id', 'operationId', 'expectedRevision'], 'news.reorder': ['operationId', 'items'] };
        if (!fields[operation] || Object.keys(args).some(k => !fields[operation].includes(k)))
            fail('invalid_arguments');
        if (operation === 'news.list')
            return await list(env, args, false);
        if (operation === 'news.detail') {
            const row = await env.DB.prepare('SELECT * FROM liveops_news WHERE id=?').bind(identifier(args.id)).first<Row>();
            return row ? { status: 200, body: { game: 'ec1', news: wire(row) } } : { status: 404, body: { error: 'not_found' } };
        }
        if (!['news.create', 'news.update', 'news.publish', 'news.archive', 'news.reorder'].includes(operation))
            fail('invalid_operation');
        if (role !== 'manager' && role !== 'internal')
            fail('forbidden', 403);
        const operationId = opId(args.operationId), fingerprint = await digest({ operation, args });
        const previous = await readOperation(env, actor, operationId, fingerprint);
        if (previous)
            return previous;
        const now = Date.now(), nonce = crypto.randomUUID();
        const changes: {
            id: string;
            expected: number | null;
            next: Row;
        }[] = [];
        if (operation === 'news.create') {
            const p = post(args.post);
            changes.push({ id: p.id, expected: null, next: { id: p.id, titles_json: JSON.stringify(p.titles), bodies_json: JSON.stringify(p.bodies), publish_at: p.publishAt, expire_at: p.expireAt, pinned: +p.pinned, draft: +p.draft, archived: 0, sort_order: p.order, rewards_json: JSON.stringify(p.rewards), revision: 1, created_at: now, updated_at: now } });
        }
        else {
            const items = operation === 'news.reorder' ? args.items : [args];
            if (!Array.isArray(items) || items.length < 1 || items.length > 100)
                fail('invalid_reorder');
            const seen = new Set<string>();
            for (const value of items) {
                const item = object(value), id = identifier(item.id), expected = integer(item.expectedRevision, 1);
                if (seen.has(id))
                    fail('duplicate_news_id');
                seen.add(id);
                const old = await env.DB.prepare('SELECT * FROM liveops_news WHERE id=?').bind(id).first<Row>();
                if (!old)
                    fail('not_found', 404);
                if (old.revision !== expected)
                    fail('revision_conflict', 409);
                const next = { ...old, revision: old.revision + 1, updated_at: now };
                if (operation === 'news.update') {
                    const p = post(args.post, id);
                    Object.assign(next, { titles_json: JSON.stringify(p.titles), bodies_json: JSON.stringify(p.bodies), publish_at: p.publishAt, expire_at: p.expireAt, pinned: +p.pinned, draft: +p.draft, sort_order: p.order, rewards_json: JSON.stringify(p.rewards) });
                }
                if (operation === 'news.publish') {
                    if (typeof args.published !== 'boolean')
                        fail('invalid_boolean');
                    if (old.archived)
                        fail('news_archived', 409);
                    next.draft = args.published ? 0 : 1;
                }
                if (operation === 'news.archive') {
                    next.archived = 1;
                    next.draft = 1;
                }
                if (operation === 'news.reorder')
                    next.sort_order = integer(item.order, -1000000, 1000000);
                changes.push({ id, expected, next });
            }
        }
        const response: Reply = { status: operation === 'news.create' ? 201 : 200, body: { game: 'ec1', ...(operation === 'news.reorder' ? { news: changes.map(x => wire(x.next)) } : { news: wire(changes[0].next) }) } };
        // JSON carries the bounded revision set in one parameter, below D1's bind limit.
        const guards = JSON.stringify(changes.map(x => ({ id: x.id, expected: x.expected })));
        const eligible = `NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE
          CASE WHEN json_extract(requested.value,'$.expected') IS NULL
          THEN EXISTS(SELECT 1 FROM liveops_news n WHERE n.id=json_extract(requested.value,'$.id'))
          ELSE NOT EXISTS(SELECT 1 FROM liveops_news n WHERE n.id=json_extract(requested.value,'$.id') AND n.revision=json_extract(requested.value,'$.expected')) END)`;
        const stmts = [env.DB.prepare(`INSERT OR IGNORE INTO liveops_news_operation(actor_id,operation_id,fingerprint,nonce,response_json,created_at) SELECT ?,?,?,?,?,? WHERE ${eligible}`).bind(actor.id, operationId, fingerprint, nonce, JSON.stringify(response), now, guards)];
        const gate = 'EXISTS(SELECT 1 FROM liveops_news_operation WHERE actor_id=? AND operation_id=? AND nonce=?)', gateArgs = [actor.id, operationId, nonce];
        for (const { expected, next: r } of changes) {
            const values = [r.titles_json, r.bodies_json, r.publish_at, r.expire_at, r.pinned, r.draft, r.archived, r.sort_order, r.rewards_json, r.revision, r.created_at, r.updated_at];
            stmts.push(expected === null ? env.DB.prepare(`INSERT INTO liveops_news(id,titles_json,bodies_json,publish_at,expire_at,pinned,draft,archived,sort_order,rewards_json,revision,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${gate}`).bind(r.id, ...values, ...gateArgs) : env.DB.prepare(`UPDATE liveops_news SET titles_json=?,bodies_json=?,publish_at=?,expire_at=?,pinned=?,draft=?,archived=?,sort_order=?,rewards_json=?,revision=?,created_at=?,updated_at=? WHERE id=? AND ${gate}`).bind(...values, r.id, ...gateArgs));
        }
        stmts.push(env.DB.prepare(`INSERT INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) SELECT ?,?,?,?,NULL,?,? WHERE ${gate}`).bind(crypto.randomUUID(), actor.id, actor.name, operation, JSON.stringify({ game: 'ec1', operationId, ids: changes.map(x => x.id), revisions: changes.map(x => x.next.revision) }), now, ...gateArgs));
        await env.DB.batch(stmts);
        return await readOperation(env, actor, operationId, fingerprint) ?? { status: 409, body: { error: 'revision_conflict' } };
    }
    catch (error) {
        return { status: error instanceof NewsError ? error.status : 503, body: { error: error instanceof NewsError ? error.message : 'storage_unavailable' } };
    }
}
export function createNewsApp() {
    const app = new Hono<AppEnv>();
    app.onError(error => {
        const typed = error instanceof AuthError || error instanceof GameError;
        return new Response(JSON.stringify({ error: typed ? error.code : 'storage_unavailable' }), { status: typed ? error.status : 503, headers: { 'Content-Type': 'application/json' } });
    });
    const playerBodyLimit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'request_too_large' }, 413) });
    app.use('/:id/read', playerBodyLimit);
    app.use('/:id/claim', playerBodyLimit);
    app.get('/', async (c) => { try {
        const q = c.req.query();
        const result = await list(c.env, { limit: q.limit === undefined ? undefined : Number(q.limit), cursor: q.cursor }, true);
        return c.json(result.body, 200);
    }
    catch (e) {
        return c.json({ error: e instanceof NewsError ? e.message : 'storage_unavailable' }, e instanceof NewsError ? 400 : 503);
    } });
    app.get('/:id', async (c) => { const now = Date.now(); const row = await c.env.DB.prepare(`SELECT * FROM liveops_news WHERE id=? AND ${live}`).bind(c.req.param('id'), now, now).first<Row>(); return row ? c.json({ game: 'ec1', news: wire(row) }) : c.json({ error: 'not_found' }, 404); });
    app.post('/:id/read', requirePlayer, async (c) => { const now = Date.now(), id = c.req.param('id'), player = c.get('player').playerId; const row = await c.env.DB.prepare(`SELECT id FROM liveops_news WHERE id=? AND ${live}`).bind(id, now, now).first(); if (!row)
        return c.json({ error: 'not_found' }, 404); await c.env.DB.prepare('INSERT OR IGNORE INTO liveops_news_read(player_id,news_id,read_at) VALUES (?,?,?)').bind(player, id, now).run(); return c.json({ game: 'ec1', id, read: true }); });
    app.post('/:id/claim', requirePlayer, async (c) => { let body: Record<string, unknown>; try {
        body = object(await c.req.json());
        opId(body.operationId);
    }
    catch {
        return c.json({ error: 'invalid_operation_id' }, 400);
    } const id = c.req.param('id'), playerId = c.get('player').playerId; const prior = await getGrant(c.env, playerId, 'news', id); if (prior)
        return c.json({ game: 'ec1', receipt: prior }); const now = Date.now(); await grantInsertFromSelect(c.env, { playerId, sourceType: 'news', sourceId: id, selectSql: `SELECT rewards_json,? AS created_at FROM liveops_news WHERE id=? AND ${live} AND rewards_json!='[]'`, bindings: [now, id, now, now] }).run(); const receipt = await getGrant(c.env, playerId, 'news', id); return receipt ? c.json({ game: 'ec1', receipt }) : c.json({ error: 'news_not_claimable' }, 404); });
    return app;
}
