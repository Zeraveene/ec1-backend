import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
let mf,db;
const id='EC1Xsynthetic';
const schema=JSON.parse(await readFile('src/game/canonical-schema.json','utf8'));
function defaults(type){if(type==='int'||type==='float'||['Rarity','EquipmentType','ItemType'].includes(type))return 0;if(type==='bool')return false;if(type==='string')return '';if(type.startsWith('List<'))return [];if(type.startsWith('Dictionary<'))return {};if(type==='FortressSaveRecord'||type==='ItemRecord')return null;return Object.fromEntries(Object.entries(schema[type]).map(([k,v])=>[k,defaults(v)]));}
function snapshot(time=100){const s=defaults('GameSaveRecord');s.schemaVersion=1;s.progress.timeCounter=time;s.characters=Array.from({length:4},(_,i)=>({...defaults('CharacterSaveRecord'),character:i,level:1}));s.daily.quests=Array.from({length:3},()=>defaults('DailyQuestSaveRecord'));s.achievements=Array(27).fill(0);s.future={preserved:'✓'};return JSON.stringify(s);}

before(async()=>{const b=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createBackupsApp} from './src/game/backups';import * as admin from './src/admin/revisions';const app=new Hono();app.use('*',async(c,n)=>{c.set('player',{playerId:c.req.header('X-Player')||'${id}',scope:'player'});await n()});app.route('/backups',createBackupsApp());app.post('/admin-test',async c=>{const b=await c.req.json();return c.json(await admin[b.action](c.env,b.actor,b.args))});app.onError((e,c)=>c.json({error:e.code||'unavailable'},e.status||503));export default {fetch(req,env,ctx){const fault=req.headers.get('X-Fault');if(fault){const bucket=env.PLAYER_SAVES;return app.fetch(req,{...env,PLAYER_SAVES:{put:fault==='put'?async()=>{throw Error('synthetic failure')}:bucket.put.bind(bucket),get:fault==='stage'?async()=>null:bucket.get.bind(bucket)}},ctx);}return app.fetch(req,env,ctx);}};`},bundle:true,format:'esm',platform:'browser',write:false});mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'manual-test'},r2Buckets:['PLAYER_SAVES'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true'}}));db=await mf.getD1Database('DB');await db.exec('CREATE TABLE player(id TEXT PRIMARY KEY)');await db.exec((await readFile('migrations/023_manual_backups.sql','utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));await db.exec('CREATE TABLE admin_audit(id TEXT PRIMARY KEY,actor_id TEXT,actor_name TEXT,action TEXT,player_id TEXT,detail_json TEXT,created_at INTEGER)');await db.prepare('INSERT INTO player(id) VALUES(?)').bind(id).run();});
after(async()=>mf?.dispose());
async function request(path,body,player,fault){return mf.dispatchFetch('https://example.test/backups/'+path,{method:body?'PUT':'GET',headers:{'Content-Type':'application/json',...(fault?{'X-Fault':fault}:{}),...(player?{'X-Player':player}:{})},...(body?{body:JSON.stringify(body)}:{})});}
const envelope=(n,operationId,time)=>({game:'ec1',schemaVersion:1,expectedRevision:n,operationId,snapshotJson:snapshot(time)});
test('empty metadata, immutable exact payload, lower time, replay and account isolation',async()=>{assert.deepEqual(await(await request('latest')).json(),{playerId:id,exists:false,revision:0});const first=envelope(0,'manual-first',100);let r=await request('latest',first);assert.equal(r.status,200);const m=await r.json();assert.equal(m.revision,1);assert.equal(m.playtime,100);assert.equal((await(await request('revisions/1')).json()).snapshotJson,first.snapshotJson);assert.equal((await request('revisions/1',null,'EC1Xother')).status,404);r=await request('latest',envelope(1,'manual-lower',2));assert.equal(r.status,200);assert.equal((await r.json()).playtime,2);assert.equal((await(await request('latest',first)).json()).revision,1);assert.equal((await request('latest',{...first,snapshotJson:snapshot(8)})).status,409);assert.equal((await(await request('revisions/1')).json()).snapshotJson,first.snapshotJson);});
test('same-head concurrent requests commit only one, malformed bodies do not advance',async()=>{const pair=await Promise.all([request('latest',envelope(2,'race-save-a',3)),request('latest',envelope(2,'race-save-b',4))]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);const head=await(await request('latest')).json();assert.equal(head.revision,3);for(const bad of ['{}','{"schemaVersion":2}','{"schemaVersion":1,"schemaVersion":1}'])assert.equal((await request('latest',{...envelope(3,'invalid-save',3),snapshotJson:bad})).status,400);assert.equal((await(await request('latest')).json()).revision,3);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM classic_backup_revision').first()).n,3);});
test('required nested types, duplicate properties, secrets and depth are rejected without publishing',async()=>{
 const base=JSON.parse(snapshot(5));
 const bodies=[];
 for(const mutate of [s=>delete s.purchases.premium,s=>s.progress.gold='2',s=>s.characters[0].weapon=null,s=>s.preferences.accessToken='forbidden',s=>s.progress.timeCounter=-1]){const s=structuredClone(base);mutate(s);bodies.push(JSON.stringify(s));}
 bodies.push(snapshot(5).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'));
 bodies.push('{"schemaVersion":1,"nested":'+ '['.repeat(65)+'0'+']'.repeat(65)+'}');
 for(const snapshotJson of bodies){const r=await request('latest',{...envelope(3,'rejected-body',5),snapshotJson});assert.equal(r.status,400);}
 assert.equal((await(await request('latest')).json()).revision,3);
});

async function admin(action,args,role='internal'){return mf.dispatchFetch('https://example.test/admin-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args,actor:{id:'synthetic-admin',name:'Tester',role}})});}
test('canonical admin format scopes metadata, download and append-only reviewed restore',async()=>{
 const args={id,format:'canonical',version:1};
 assert.equal((await admin('revisionGet',args,'guest')).status,403);
 const listing=await(await admin('revisionList',args,'guest')).json();assert.equal(listing.headRevision,3);assert.equal(listing.revisions[0].format,'canonical');
 const download=await(await admin('revisionGet',args)).json();assert.equal(download.snapshotJson,snapshot(100));
 const preview=await(await admin('revisionPreviewRestore',args)).json();
 const restore={...args,expectedSaveVersion:3,operationId:'admin-restoring',reviewSha256:preview.reviewSha256};
 let r=await admin('revisionRestore',restore);assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.revision,4);
 assert.deepEqual(await(await admin('revisionRestore',restore)).json(),saved);
 assert.equal((await admin('revisionRestore',{...restore,version:2})).status,409);
 assert.equal((await(await request('revisions/4')).json()).snapshotJson,snapshot(100));
 assert.equal((await(await request('revisions/1')).json()).snapshotJson,snapshot(100));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE action="canonical_backup.restore"').first()).n,1);
 assert.equal((await admin('revisionGet',{...args,format:'unknown'})).status,400);
 const stale=await admin('revisionRestore',{...restore,operationId:'admin-stale-op'});assert.equal(stale.status,409);
});
test('R2 publication failures keep the previous head; exact download detects corrupt storage',async()=>{
 for(const fault of ['put','stage']){const r=await request('latest',envelope(4,'fault-save-'+fault,9),null,fault);assert.equal(r.status,503);assert.equal((await(await request('latest')).json()).revision,4);}
 const row=await db.prepare('SELECT r2_key FROM classic_backup_revision WHERE player_id=? AND revision=1').bind(id).first();
 const bucket=await mf.getR2Bucket('PLAYER_SAVES');await bucket.put(row.r2_key,'corrupt synthetic bytes');
 assert.equal((await request('revisions/1')).status,503);
 assert.equal((await(await request('latest')).json()).revision,4);
});
