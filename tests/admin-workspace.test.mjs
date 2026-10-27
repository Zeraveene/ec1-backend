import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
let mf, db, rpc;
const actor = { id: '111111111111111111', name: 'Synthetic Admin' };
before(async () => {
  const bundle = await build({ stdin: { contents: `export {AdminWorkspace,default} from './src/index';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'workspace', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-06', d1Databases: { DB: 'workspace-test' }, serviceBindings: { ADMIN_AUTHORITY: { name: 'authority', entrypoint: 'Authority' } } },
    { name: 'authority', modules: true, compatibilityDate: '2026-10-06', d1Databases: { DB: 'workspace-test' }, script: `import {WorkerEntrypoint} from 'cloudflare:workers'; export class Authority extends WorkerEntrypoint {async getRole(id){const row=await this.env.DB.prepare('SELECT role FROM authority WHERE id=?').bind(id).first(); if(row?.role==='outage')throw new Error('secret-provider-failure'); return row?.role??null;}} export default {fetch(){return new Response('no')}};` },
    { name: 'missing', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-06' },
    { name: 'caller', modules: true, compatibilityDate: '2026-10-06', serviceBindings: { WORKSPACE: { name: 'workspace', entrypoint: 'AdminWorkspace' }, MISSING: { name: 'missing', entrypoint: 'AdminWorkspace' } }, script: `export default {async fetch(request,env){const b=await request.json(); return Response.json(await (b.missing?env.MISSING:env.WORKSPACE).read(b.actor,b.operation,b.args));}};` },
  ] }));
  db = await mf.getD1Database('DB', 'workspace');
  for (const file of ['001_auth.sql','002_game.sql','030_liveops_leaderboards.sql','033_structured_fortress.sql','003_admin.sql']) for (const sql of (await readFile(`migrations/${file}`, 'utf8')).split(';').map(x=>x.trim()).filter(Boolean)) await db.prepare(sql).run();
  await db.prepare('CREATE TABLE authority (id TEXT PRIMARY KEY,role TEXT)').run();
  await db.prepare('INSERT INTO authority VALUES (?,?)').bind(actor.id,'internal').run();
  for(let i=0;i<103;i++) await db.prepare('INSERT INTO player(id,display_name,created_at,updated_at,device_id) VALUES (?,?,10,20,?)').bind(`fixture${String(i).padStart(3,'0')}`,'勇者 Fixture','secret-device').run();
  await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at) VALUES ('email','fixture@example.test','fixture000','secret-hash','secret-salt',10)").run();
  await db.prepare("INSERT INTO admin_audit VALUES ('audit1','111','Admin','test','fixture000','secret-archive',10)").run();
  for(let i=0;i<102;i++) await db.prepare("INSERT INTO admin_audit VALUES (?, '111','Admin','test','fixture000','secret-archive',10)").bind(`audit${String(i+2).padStart(3,'0')}`).run();
  await db.prepare("INSERT INTO save_revision VALUES ('fixture000',1,'secret-r2','synthetic-sha',12,'operation','secret-payload',10)").run();
  await db.prepare("INSERT INTO mail(id,player_id,title,body,rewards_json,created_at) VALUES ('mail1','fixture000','Fixture mail','secret-body','[]',10)").run();
  rpc = await mf.getWorker('caller');
});
after(async()=>await mf?.dispose());
async function read(operation,args={},who=actor) { return (await rpc.fetch('https://synthetic.test/', {method:'POST',body:JSON.stringify({actor:who,operation,args})})).json(); }
async function role(value) {await db.prepare('UPDATE authority SET role=? WHERE id=?').bind(value,actor.id).run();}
test('actual private RPC allows all current roles and revalidates removal, malformed role, outage',async()=>{
  for(const current of ['internal','manager','guest']) {await role(current); const res=await read('status'); assert.equal(res.status,200); assert.equal(res.body.game,'ec1'); assert.equal(res.body.players,103);}
  await db.prepare('DELETE FROM authority').run(); assert.equal((await read('status')).status,403);
  await db.prepare('INSERT INTO authority VALUES (?,?)').bind(actor.id,'owner').run(); assert.equal((await read('status')).status,503);
  await role('outage'); const failed=await read('status'); assert.equal(failed.status,503); assert.doesNotMatch(JSON.stringify(failed),/secret/); await role('internal');
  const absent=await (await rpc.fetch('https://synthetic.test/',{method:'POST',body:JSON.stringify({actor,operation:'status',missing:true})})).json(); assert.equal(absent.status,503);
});
test('validates actor and operation arguments without exposing public read routes',async()=>{
  for(const who of [null,{}, {...actor,id:'bad'}, {...actor,name:''}]) assert.equal((await read('status',{},who)).status,400);
  for(const [op,args] of [['mutate',{}],['status',{id:'x'}],['player',{}],['players',{query:'x'.repeat(101)}],['players',{cursor:'broken'}],['audit',{cursor:123}],['players',[]]]) assert.equal((await read(op,args)).status,400);
  const worker=await mf.getWorker('workspace'); const res=await worker.fetch('https://synthetic.test/api/workspace/status',{headers:{'X-Admin-ID':actor.id}}); assert.equal(res.status,404);
});
test('keyset pages equal timestamps with no gaps, query scope and safe detail projection',async()=>{
  assert.equal((await read('players',{cursor:''})).status,200);
  const unicode=await read('players',{query:'勇者'}); assert.equal(unicode.status,200); assert.equal((await read('players',{query:'勇者',cursor:unicode.body.nextCursor})).body.players.length,3);
  const first=await read('players'); assert.equal(first.body.players.length,100); assert.ok(first.body.nextCursor);
  const second=await read('players',{cursor:first.body.nextCursor}); assert.equal(second.body.players.length,3); assert.equal(second.body.nextCursor,null);
  assert.equal(new Set([...first.body.players,...second.body.players].map(x=>x.id)).size,103);
  assert.equal((await read('players',{query:'other',cursor:first.body.nextCursor})).status,400);
  assert.equal((await read('players',{query:'%'})).body.players.length,0);
  const detail=await read('player',{id:'fixture000'}); assert.equal(detail.status,200); assert.equal(detail.body.identities[0].subject,'fixture@example.test'); assert.equal(detail.body.revisions[0].sha256,'synthetic-sha'); assert.equal(detail.body.mail[0].title,'Fixture mail'); assert.doesNotMatch(JSON.stringify(detail),/secret|password_hash|device_id|r2_key/);
  assert.equal((await read('player',{id:'missing'})).status,404);
  const audit=await read('audit'); assert.equal(audit.body.events.length,100); const audit2=await read('audit',{cursor:audit.body.nextCursor}); assert.equal(audit2.body.events.length,3); assert.equal(new Set([...audit.body.events,...audit2.body.events].map(x=>x.id)).size,103); assert.doesNotMatch(JSON.stringify(audit),/secret|detail_json/);
});
test('storage outages fail closed with no raw diagnostics',async()=>{
  await db.prepare('ALTER TABLE player RENAME TO unavailable_player').run(); const res=await read('status'); assert.equal(res.status,503); assert.deepEqual(res.body,{error:'storage_unavailable'});
});
