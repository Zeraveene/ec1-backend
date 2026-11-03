import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, db, sourceVersion = 0, outboundCalls = 0;
const origin = 'https://admin.test';
const baseCharacter = JSON.parse(await readFile('tests/fixtures/alasterbase.json', 'utf8'));
const keys = JSON.parse(await readFile('src/admin/legacy-keys.json', 'utf8'));
function legacy(id, extra = {}) {
  const data = { gamedata: JSON.stringify({ gold: 123 + sourceVersion, ruby: 7, stageProgress: 25, timeCounter: 1234, usedCoupons: ['quoted$^|'], stageInfo: [{ introSeen: true }] }),
    alaster_attributes: JSON.stringify({ ...baseCharacter, level: 23 }), inventory: '^^', selected: 'soul', premium: '1', costume_soul_8: '1', achievements_new: Array(27).fill('1').join('|'), ...extra };
  return { CLOUD_ALL_DATA: JSON.stringify(data), Playtime: '99999' };
}
before(async () => {
  const b = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import migrationEntry from './src/admin/migration-entry';
    import {convertLegacyCloud} from './src/migration/legacy-conversion';
    import {verifyClassicMigrationImported} from './src/migration/classic';
    import {Hono} from 'hono';
    const app=new Hono();app.post('/convert',async c=>{try{const b=await c.req.json();return c.json(convertLegacyCloud(b.raw,b.companion));}catch(e){return c.json({error:e.code},e.status||503)}});
    app.post('/verify/:id',async c=>c.json(await verifyClassicMigrationImported(c.env,c.req.param('id'))));
    app.route('/',migrationEntry);
    export default {fetch(req,env,ctx){env={...env,EMAIL:{send:async message=>{const control=await env.DB.prepare('SELECT fail FROM fixture_mail_control').first();if(control.fail)throw Error('synthetic mail failure');await env.DB.prepare('INSERT INTO fixture_mail(body) VALUES(?)').bind(message.text).run();}}};const fault=req.headers.get('X-Fault');if(fault){const bucket=env.PLAYER_SAVES;env={...env,PLAYER_SAVES:{put:fault==='put'?async()=>{throw Error('synthetic')}:bucket.put.bind(bucket),get:fault==='readback'?async()=>null:bucket.get.bind(bucket)}};}return app.fetch(req,env,ctx)}};`
  }, bundle: true, format: 'esm', platform: 'browser', write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'classic', modules: true, script: b.outputFiles[0].text, compatibilityDate: '2026-10-06', d1Databases: { DB: 'migration-classic' }, r2Buckets: ['PLAYER_SAVES', 'LEGACY_ARCHIVE'],
      bindings: { CLASSIC_ADMIN_ORIGIN: origin, PLAYER_TOKEN_SECRET: 'synthetic-classic-migration-secret-32chars', LEGACY_MIGRATION_ENABLED: 'true', PLAYFAB_TITLE_ID: 'SYNTHETIC', PLAYFAB_SECRET_KEY: 'synthetic-secret', MAIL_FROM: 'noreply@fixture.invalid', PASSWORD_RESET_ORIGIN: 'https://fixture.invalid' },
      serviceBindings: { EC2_ADMIN_SESSION: 'central' },
      outboundService: async request => {
        outboundCalls++; const method = new URL(request.url).pathname; const { PlayFabId: id } = await request.json();
        assert.equal(new URL(request.url).hostname, 'synthetic.playfabapi.com');
        if (id === 'AAAABBBB0009') return new Response('unavailable', { status: 503 });
        if (method === '/Admin/GetUserAccountInfo') return Response.json({ data: { UserInfo: { PlayFabId: id, TitleInfo: { DisplayName: 'Fixture player' }, PrivateInfo: { Email: id.toLowerCase() + '@fixture.invalid' }, ...(id.endsWith('0002') ? { GoogleInfo: { GoogleId: 'google-' + id, GoogleEmail: 'google@fixture.invalid' } } : {}) } } });
        if (method === '/Admin/GetUserData') return Response.json({ data: { Data: Object.fromEntries(Object.entries(legacy(id, id.endsWith('0008') ? { gamedata: '{"gold":-1,"ruby":0}' } : {})).map(([k, Value]) => [k, { Value }])) } });
        if (method === '/Admin/GetUserInventory') return Response.json({ data: { Inventory: id.endsWith('0007') ? [{ ItemId: 'unknown' }] : [], VirtualCurrency: {}, RechargeTimes: { random: Math.random() } } });
        if (method === '/Admin/GetUserBans') return Response.json({ data: { BanData: id.endsWith('0002') ? [{ BanId: 'ban-1', Active: true, PlayFabId: id }] : [] } });
        throw Error('PlayFab writes and unapproved network are forbidden: ' + method);
      } },
    { name: 'central', modules: true, script: `export default {fetch(req){return Response.json({discordId:'111111111111111111',username:'fixture',role:req.headers.get('Cookie').includes('guest')?'guest':'internal'})}};` },
  ] }));
  db = await mf.getD1Database('DB', 'classic');
  await db.exec('CREATE TABLE fixture_mail_control(fail INTEGER); INSERT INTO fixture_mail_control VALUES(0); CREATE TABLE fixture_mail(body TEXT)');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile('migrations/' + file, 'utf8')).replace(/--[^\n]*/g, '').replace(/\n/g, ' '); await db.exec(sql);
  }
});
after(async () => mf?.dispose());
async function req(path, body = {}, options = {}) {
  const response = await mf.dispatchFetch(origin + '/api/classic-admin' + path, { method: 'POST', headers: { Cookie: 'ec2mod_session=' + (options.guest ? 'guest' : 'fixture'), Origin: options.origin ?? origin, 'Content-Type': 'application/json', ...(options.fault ? { 'X-Fault': options.fault } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function preview(id) { const r = await req(`/legacy/${id}/migrate/preview`); assert.equal(r.status, 200, JSON.stringify(r)); return r.body; }
async function apply(id, p, op = 'fixture-' + id, extra = {}) { return req(`/legacy/${id}/migrate`, { reviewSha256: p.reviewSha256, operationId: op, ...extra }); }
async function convert(raw, companion) { const r = await mf.dispatchFetch(origin + '/convert', { method: 'POST', body: JSON.stringify({ raw, companion }) }); return { status: r.status, body: await r.json() }; }

test('legacy conversion preserves progression, equipment, flags, quoted delimiters, positional format and playtime rules', async () => {
  const input = legacy('fixture'); const converted = await convert(input.CLOUD_ALL_DATA, input.Playtime); assert.equal(converted.status, 200, JSON.stringify(converted));
  const s = JSON.parse(converted.body.json); assert.equal(s.progress.gold, 123); assert.equal(s.progress.timeCounter, 1234); assert.equal(s.profile.playtime, 99999); assert.equal(s.characters[0].level, 23); assert.equal(s.characters[0].top.id, 'aarmor'); assert.equal(s.characters[3].weapon.id, 'aweapon'); assert.equal(s.purchases.premium, 1); assert.equal(s.unlocks.costumes.costume_soul_8, 1); assert.equal(s.unlocks.selectedCharacter, 'soul'); assert.deepEqual(s.progress.usedCoupons, ['quoted$^|']); assert.deepEqual(s.achievements, Array(27).fill(1));
  const values = JSON.parse(input.CLOUD_ALL_DATA); const positional = keys.map(k => values[k] ?? '').join('$'); const historical = await convert(positional); assert.equal(historical.status, 200); assert.equal(JSON.parse(historical.body.json).characters[0].level, 23);
  values.gamedata = JSON.stringify({ gold: 0, ruby: 0, timeCounter: 0 }); values.playtime = '0'; const zero = await convert(JSON.stringify(values), '500'); assert.equal(JSON.parse(zero.body.json).progress.timeCounter, 0); assert.equal(JSON.parse(zero.body.json).profile.playtime, 0);
  const fallback = await convert(JSON.stringify({ gamedata: '{"gold":1,"ruby":0}' }), '500'); assert.equal(JSON.parse(fallback.body.json).progress.timeCounter, 500);
  const slots = await convert(JSON.stringify({ ...values, consumable: JSON.stringify({ stringA: '{"id":"potion","amount":2}', stringB: '', amountA: 2, amountB: 20, slotA: 456 }) })); assert.equal(slots.status, 200); assert.equal(JSON.parse(slots.body.json).consumableSlots.amountB, 0);
  assert.equal((await convert(converted.body.json)).status, 200);
  for (const raw of ['{}', '{"gamedata":"{\\"gold\\":-1,\\"ruby\\":0}"}', JSON.stringify({ ...values, premium: '2' }), JSON.stringify({ ...values, alaster_attributes: '{"level":"23","exp":0}' })]) assert.equal((await convert(raw)).status, 409);
});
test('preview requires internal central session and origin; no target player or credentials are created', async () => {
  const id = 'AAAABBBB0001'; const before = outboundCalls;
  assert.equal((await req(`/legacy/${id}/migrate/preview`, {}, { guest: true })).status, 403);
  assert.equal((await req(`/legacy/${id}/migrate/preview`, {}, { origin: 'https://evil.invalid' })).status, 403); assert.equal(outboundCalls, before);
  const p = await preview(id); assert.equal(p.passwordEmail, true); assert.equal(p.email, id.toLowerCase() + '@fixture.invalid');
  assert.equal(await db.prepare('SELECT 1 FROM player WHERE id=?').bind(id).first(), null); assert.equal(await db.prepare('SELECT 1 FROM auth_identity WHERE player_id=?').bind(id).first(), null);
  assert.ok(!JSON.stringify(p).includes('password_hash')); assert.equal((await db.prepare('SELECT count(*) n FROM fixture_mail').first()).n, 0);
});
test('migration atomically publishes first canonical revision, identities, provenance, bans, audit and retry receipt', async () => {
  const id = 'AAAABBBB0002', p = await preview(id); assert.equal(p.googleLinked, true); assert.equal(p.activeBanCount, 1);
  const [a, b] = await Promise.all([apply(id, p), apply(id, p)]); assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200, JSON.stringify(b)); assert.deepEqual(a.body, b.body);
  const state = await db.prepare('SELECT * FROM player WHERE id=?').bind(id).first(); assert.equal(state.save_state, 'migrated'); assert.equal(state.playtime, 1234);
  const native = (await db.prepare('SELECT provider,password_hash FROM auth_identity WHERE player_id=?').bind(id).all()).results; assert.equal(native.length, 2); assert.ok(native.find(i => i.provider === 'email').password_hash); assert.equal(a.body.loginStatus, 'google_ready');
  assert.equal((await db.prepare('SELECT count(*) n FROM classic_backup_revision WHERE player_id=?').bind(id).first()).n, 1); assert.equal((await db.prepare('SELECT count(*) n FROM admin_audit WHERE player_id=? AND action=?').bind(id, 'legacy.migrate').first()).n, 1);
  assert.equal((await db.prepare('SELECT revoked_at FROM player_ban WHERE player_id=?').bind(id).first()).revoked_at, null);
  const verified = await mf.dispatchFetch(origin + '/verify/' + id, { method: 'POST' }); assert.equal(verified.status, 200, await verified.clone().text());
  assert.equal((await req(`/legacy/${id}/migrate/preview`)).body.error, 'backend_save_already_exists');
  assert.equal((await apply(id, p, 'different-operation')).status, 409); assert.equal((await apply('AAAABBBB9999', p, 'fixture-' + id)).body.error, 'operation_id_reused');
});
test('stale source, storage failure, identity conflicts and unsupported evidence do not publish a backup', async () => {
  const id = 'AAAABBBB0003', p = await preview(id); sourceVersion++; assert.equal((await apply(id, p)).body.error, 'legacy_changed_refresh_preview'); sourceVersion--;
  for (const fault of ['put', 'readback']) { const r = await req(`/legacy/${id}/migrate`, { reviewSha256: p.reviewSha256, operationId: 'fault-test-' + fault }, { fault }); assert.equal(r.status, 503); assert.equal(await db.prepare('SELECT 1 FROM player WHERE id=?').bind(id).first(), null); }
  await db.prepare("INSERT INTO player(id,created_at,updated_at) VALUES('fixture-owner',0,0)").run(); await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('email',?,'fixture-owner',0)").bind(id.toLowerCase() + '@fixture.invalid').run();
  const conflict = await preview(id); assert.equal(conflict.conflicts[0].playerId, 'fixture-owner'); assert.equal((await apply(id, conflict)).body.error, 'migration_identity_conflict');
  assert.equal((await req('/legacy/AAAABBBB0007/migrate/preview')).body.error, 'migration_entitlement_review_required'); assert.equal((await req('/legacy/AAAABBBB0008/migrate/preview')).body.error, 'legacy_save_invalid'); assert.equal((await req('/legacy/AAAABBBB0009/migrate/preview')).body.error, 'legacy_source_unavailable');
});
test('email password stays encrypted and delivery retry is independent of migration; reset supersedes old password', async () => {
  // Inject the mail object inside the Worker because send_email is not fetch/RPC.
  const id = 'AAAABBBB0004', p = await preview(id); const result = await apply(id, p); assert.equal(result.status, 200);
  const row = await db.prepare('SELECT * FROM classic_migration_email WHERE player_id=?').bind(id).first(); assert.equal(row.status, 'pending'); assert.ok(row.encrypted_password); assert.ok(!row.encrypted_password.includes('New password'));
  await db.prepare("UPDATE auth_identity SET password_hash='changed-by-password-reset' WHERE player_id=? AND provider='email'").bind(id).run();
  const sent = await req(`/legacy/${id}/migration-email`); assert.equal(sent.status, 200, JSON.stringify(sent)); assert.equal(sent.body.status, 'superseded'); assert.equal((await db.prepare('SELECT count(*) n FROM fixture_mail').first()).n, 0); assert.equal((await db.prepare('SELECT encrypted_password FROM classic_migration_email WHERE player_id=?').bind(id).first()).encrypted_password, null);
  assert.equal((await apply(id, p)).body.emailStatus, 'superseded');
});
test('delivery failures leave a usable committed login; retry sends once and never repeats migration', async () => {
  const id = 'AAAABBBB0005', p = await preview(id);
  await db.exec('UPDATE fixture_mail_control SET fail=1');
  const migrated = await apply(id, p, 'email-failure-operation', { sendEmail: true }); assert.equal(migrated.status, 200); assert.equal(migrated.body.emailStatus, 'failed');
  assert.equal((await db.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first()).revision, 1);
  await db.exec('UPDATE fixture_mail_control SET fail=0');
  const delivery = await req(`/legacy/${id}/migration-email`); assert.equal(delivery.body.status, 'sent');
  assert.equal((await req(`/legacy/${id}/migration-email`)).body.status, 'sent');
  assert.equal((await db.prepare('SELECT count(*) n FROM fixture_mail').first()).n, 1);
  const sent = (await db.prepare('SELECT body FROM fixture_mail').first()).body;
  assert.match(sent, /New password: [A-Za-z0-9_-]+/); assert.match(sent, /Account UID: AAAABBBB0005/);
  assert.equal((await db.prepare('SELECT encrypted_password FROM classic_migration_email WHERE player_id=?').bind(id).first()).encrypted_password, null);
  const replay = await apply(id, p, 'email-failure-operation', { sendEmail: true }); assert.equal(replay.body.emailStatus, 'sent');
  assert.equal((await db.prepare('SELECT count(*) n FROM fixture_mail').first()).n, 1);
});
test('audit failure rolls back player, credentials and revision; concurrent distinct operations publish one migration', async () => {
  const id = 'AAAABBBB0006', p = await preview(id);
  await db.exec("CREATE TRIGGER fail_migration_audit BEFORE INSERT ON admin_audit WHEN NEW.action='legacy.migrate' BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END");
  assert.equal((await apply(id, p)).status, 503);
  for (const table of ['player', 'auth_identity', 'classic_backup_revision', 'classic_migration_email']) assert.equal(await db.prepare(`SELECT 1 FROM ${table} WHERE ${table === 'player' ? 'id' : 'player_id'}=?`).bind(id).first(), null);
  await db.exec('DROP TRIGGER fail_migration_audit');
  const pair = await Promise.all([apply(id, p, 'race-operation-one'), apply(id, p, 'race-operation-two')]);
  assert.deepEqual(pair.map(r => r.status).sort(), [200, 409]);
  assert.equal((await db.prepare('SELECT count(*) n FROM classic_backup_revision WHERE player_id=?').bind(id).first()).n, 1);
});
test('latest backend legacy edit is migrated; untouched PlayFab bytes and edit provenance remain archived', async () => {
  const id = 'AAAABBBB0010', edited = legacy(id, { gamedata: '{"gold":777,"ruby":5,"timeCounter":200}' });
  const saved = JSON.stringify({ profile: { id, displayName: 'Edited fixture' }, savedAt: null, data: edited });
  const hash = (await import('node:crypto')).createHash('sha256').update(saved).digest('hex');
  await (await mf.getR2Bucket('PLAYER_SAVES', 'classic')).put('fixture-legacy-edit', saved);
  await db.prepare("INSERT INTO legacy_admin_revision VALUES(?,1,'fixture-legacy-edit',?,'fixture-original',200,'fixture','fixture-edit','fixture-hash',0)").bind(id, hash).run();
  await db.prepare('INSERT INTO legacy_admin_head VALUES(?,1)').bind(id).run();
  const p = await preview(id); assert.equal(p.sourceRevision, 1); assert.equal(p.playtime, 200);
  const applied = await apply(id, p); assert.equal(applied.status, 200, JSON.stringify(applied));
  const row = await db.prepare('SELECT * FROM classic_migration WHERE player_id=?').bind(id).first();
  const archive = JSON.parse(await (await (await mf.getR2Bucket('LEGACY_ARCHIVE', 'classic')).get(row.archive_key)).text());
  assert.equal(JSON.parse(JSON.parse(archive.originalUserData.Data.CLOUD_ALL_DATA.Value).gamedata).gold, 123);
  assert.equal(JSON.parse(JSON.parse(archive.userData.Data.CLOUD_ALL_DATA.Value).gamedata).gold, 777);
  assert.equal(archive.backendRevision.revision, 1);
  assert.equal((await mf.dispatchFetch(origin + '/verify/' + id, { method: 'POST' })).status, 200);
});
