import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf, db, bucket;
const hash = text => createHash('sha256').update(text).digest('hex');
const schema = JSON.parse(await readFile('src/game/canonical-schema.json', 'utf8'));
function defaults(type) {
  if (type === 'int' || type === 'float' || ['Rarity', 'EquipmentType', 'ItemType'].includes(type)) return 0;
  if (type === 'string') return '';
  if (type === 'bool') return false;
  if (type.startsWith('List<')) return [];
  if (type.startsWith('Dictionary<')) return {};
  if (type === 'FortressSaveRecord' || type === 'ItemRecord') return null;
  return Object.fromEntries(Object.entries(schema[type]).map(([key, value]) => [key, defaults(value)]));
}
function snapshot(gold, ruby, levels) {
  const data = defaults('GameSaveRecord');
  data.schemaVersion = 1;
  Object.assign(data.progress, { gold, ruby, timeCounter: gold });
  data.characters = levels.map((level, character) => ({ ...defaults('CharacterSaveRecord'), level, character }));
  data.daily.quests = Array.from({ length: 3 }, () => defaults('DailyQuestSaveRecord'));
  data.achievements = Array(27).fill(0);
  return JSON.stringify(data);
}
before(async () => {
  const built = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import {playerSaveView} from './src/admin/player-save-view';
    import {revisionList} from './src/admin/revisions';
    export default {async fetch(req,env){const b=await req.json();try{return Response.json(b.list?await revisionList(env,{id:'admin',name:'Tester',role:'guest'},b):await playerSaveView(env,b.id));}catch(e){return Response.json({error:e.code||'unavailable'},{status:e.status||503});}}};`
  }, bundle: true, format: 'esm', platform: 'browser', write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-06', d1Databases: { DB: 'viewer' }, r2Buckets: ['PLAYER_SAVES'], outboundService: () => { throw Error('No PlayFab or external network allowed'); } }));
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('PLAYER_SAVES');
  for (const file of ['001_auth.sql', '002_game.sql', '030_liveops_leaderboards.sql', '033_structured_fortress.sql', '003_admin.sql', '023_manual_backups.sql']) {
    for (const sql of (await readFile('migrations/' + file, 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const id of ['native', 'empty', 'legacy']) await db.prepare('INSERT INTO player(id,display_name,created_at,updated_at) VALUES(?,?,0,0)').bind(id, 'Synthetic ' + id).run();
  for (const [revision, gold, ruby, levels] of [[1, 100, 0, [1, 2, 3, 4]], [2, 200, 25, [10, 20, 30, 40]]]) {
    const text = snapshot(gold, ruby, levels), key = `native/${revision}`;
    await bucket.put(key, text);
    await db.prepare('INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,?,?,?,?,1,?,?,?,?)').bind('native', revision, key, hash(text), Buffer.byteLength(text), gold, revision, 'fixture_' + revision, 'fixture').run();
  }
  await db.prepare("INSERT INTO classic_backup_head VALUES('native',2)").run();
  const keys = JSON.parse(await readFile('src/admin/legacy-keys.json', 'utf8'));
  const prefs = Object.fromEntries(keys.map(key => [key, '0']));
  const alaster = JSON.parse(await readFile('tests/fixtures/alasterbase.json', 'utf8')); alaster.level = 8;
  Object.assign(prefs, { gamedata: JSON.stringify({ gold: 7, ruby: 0, stageProgress: 1, tutorialProgress: 1, timeCounter: 12, usedCoupons: [], stageInfo: [] }),
    alaster_attributes: JSON.stringify(alaster), edna_attributes: await readFile('tests/fixtures/ednabase.json', 'utf8'), louisa_attributes: '', soul_attributes: '', inventory: '^^', consumable: '', achievements_new: Array(27).fill('0').join('|') });
  const legacy = { game: 'ec1', schemaVersion: 1, expectedSaveVersion: 0, operationId: 'legacy-fixture', playtime: 12,
    data: { CLOUD_ALL_DATA: JSON.stringify(prefs), Playtime: '12' } };
  const content = JSON.stringify(legacy); await bucket.put('legacy/1', content);
  await db.prepare('INSERT INTO save_revision(player_id,version,r2_key,sha256,playtime,operation_id,payload_hash,created_at) VALUES(?,1,?,?,12,?,?,0)').bind('legacy', 'legacy/1', hash(content), 'legacy-fixture', 'fixture').run();
  await db.prepare("UPDATE player SET save_version=1,playtime=12 WHERE id='legacy'").run();
});
after(async () => mf?.dispose());
async function call(body) { const r = await mf.dispatchFetch('https://fixture', { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
test('native player view uses canonical head, shows four heroes and never contacts PlayFab', async () => {
  const r = await call({ id: 'native' }); assert.equal(r.status, 200);
  assert.equal(r.body.source, 'canonical_backup'); assert.equal(r.body.revision, 2);
  assert.equal(r.body.account.gold, 200); assert.equal(r.body.account.ruby, 25);
  assert.deepEqual(r.body.heroes.map(h => h.level), [10, 20, 30, 40]);
  assert.equal(r.body.inventory.state, 'available');
  assert.doesNotMatch(JSON.stringify(r.body), /r2_key|operationId|request_hash/);
  assert.equal((await call({ id: 'empty' })).body.state, 'missing');
  assert.equal((await call({ id: 'missing' })).status, 404);
});
test('revision comparisons use each snapshot, retain real zero, and do not export save contents', async () => {
  const r = await call({ id: 'native', list: true, format: 'canonical' }); assert.equal(r.status, 200);
  const [latest, first] = r.body.revisions;
  assert.equal(latest.summary.gold, 200); assert.equal(first.summary.gold, 100);
  assert.equal(first.summary.ruby, 0);
  assert.deepEqual(first.summary.heroLevels, { alaster: 1, edna: 2, louisa: 3, soul: 4 });
  assert.doesNotMatch(JSON.stringify(r.body), /snapshotJson|r2_key|progress|ownership/);
});
test('legacy backend view is separate, missing hero levels stay unknown', async () => {
  const r = await call({ id: 'legacy' }); assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.body.source, 'legacy_backend'); assert.equal(r.body.account.gold, 7);
  const list = await call({ id: 'legacy', list: true });
  assert.equal(list.body.revisions[0].summary.heroLevels.alaster, 8);
  assert.equal(list.body.revisions[0].summary.heroLevels.louisa, null);
});
test('corrupt head fails closed; damaged history stays visible with an unavailable summary', async () => {
  await bucket.put('native/2', snapshot(999, 999, [99, 99, 99, 99]));
  assert.deepEqual(await call({ id: 'native' }), { status: 503, body: { error: 'revision_integrity_unavailable' } });
  const r = await call({ id: 'native', list: true, format: 'canonical' });
  assert.equal(r.status, 200); assert.equal(r.body.revisions[0].version, 2);
  assert.equal(r.body.revisions[0].summary.state, 'unavailable');
  assert.equal(r.body.revisions[0].summary.gold, null);
  assert.equal(r.body.revisions[1].summary.gold, 100);
  assert.equal((await db.prepare("SELECT revision FROM classic_backup_head WHERE player_id='native'").first()).revision, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit').first()).n, 0);
});
