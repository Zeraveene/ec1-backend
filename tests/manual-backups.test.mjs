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

before(async()=>{const b=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createBackupsApp} from './src/game/backups';import * as admin from './src/admin/revisions';const app=new Hono();app.use('*',async(c,n)=>{c.set('player',{playerId:c.req.header('X-Player')||'${id}',scope:'player'});await n()});app.route('/backups',createBackupsApp());app.post('/admin-test',async c=>{const b=await c.req.json();return c.json(await admin[b.action](c.env,b.actor,b.args))});app.onError((e,c)=>c.json({error:e.code||'unavailable',...e.details},e.status||503));export default {fetch(req,env,ctx){const fault=req.headers.get('X-Fault');if(fault){const bucket=env.PLAYER_SAVES;return app.fetch(req,{...env,PLAYER_SAVES:{put:fault==='put'?async()=>{throw Error('synthetic failure')}:bucket.put.bind(bucket),get:fault==='stage'?async()=>null:bucket.get.bind(bucket)}},ctx);}return app.fetch(req,env,ctx);}};`},bundle:true,format:'esm',platform:'browser',write:false});mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'manual-test'},r2Buckets:['PLAYER_SAVES'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true',PLAYER_TOKEN_SECRET:'synthetic-ownership-test-secret'}}));db=await mf.getD1Database('DB');await db.exec('CREATE TABLE player(id TEXT PRIMARY KEY,display_name TEXT)');await db.exec((await readFile('migrations/023_manual_backups.sql','utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));await db.exec((await readFile('migrations/032_save_ownership.sql','utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));await db.exec('CREATE TABLE admin_audit(id TEXT PRIMARY KEY,actor_id TEXT,actor_name TEXT,action TEXT,player_id TEXT,detail_json TEXT,created_at INTEGER)');await db.prepare('INSERT INTO player(id) VALUES(?)').bind(id).run();});
after(async()=>mf?.dispose());
function gameplay(json){const s=JSON.parse(json);delete s.ownership;return JSON.stringify(s);}
async function request(path,body,player,fault){return mf.dispatchFetch('https://example.test/backups/'+path,{method:body?'PUT':'GET',headers:{'Content-Type':'application/json',...(fault?{'X-Fault':fault}:{}),...(player?{'X-Player':player}:{})},...(body?{body:JSON.stringify(body)}:{})});}
const envelope=(n,operationId,time)=>({game:'ec1',schemaVersion:1,expectedRevision:n,operationId,snapshotJson:snapshot(time)});
test('empty metadata, immutable exact payload, lower time, replay and account isolation',async()=>{assert.deepEqual(await(await request('latest')).json(),{playerId:id,exists:false,revision:0});const first=envelope(0,'manual-first',100);let r=await request('latest',first);assert.equal(r.status,200);const m=await r.json();assert.equal(m.revision,1);assert.equal(m.playtime,100);assert.equal(gameplay((await(await request('revisions/1')).json()).snapshotJson),first.snapshotJson);assert.equal((await request('revisions/1',null,'EC1Xother')).status,404);r=await request('latest',envelope(1,'manual-lower',2));assert.equal(r.status,200);assert.equal((await r.json()).playtime,2);assert.equal((await(await request('latest',first)).json()).revision,1);assert.equal((await request('latest',{...first,snapshotJson:snapshot(8)})).status,409);assert.equal(gameplay((await(await request('revisions/1')).json()).snapshotJson),first.snapshotJson);});
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
 const download=await(await admin('revisionGet',args)).json();assert.equal(gameplay(download.snapshotJson),snapshot(100));
 const preview=await(await admin('revisionPreviewRestore',args)).json();
 const restore={...args,expectedSaveVersion:3,operationId:'admin-restoring',reviewSha256:preview.reviewSha256};
 let r=await admin('revisionRestore',restore);assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.revision,4);
 assert.deepEqual(await(await admin('revisionRestore',restore)).json(),saved);
 assert.equal((await admin('revisionRestore',{...restore,version:2})).status,409);
 assert.equal(gameplay((await(await request('revisions/4')).json()).snapshotJson),snapshot(100));
 assert.equal(gameplay((await(await request('revisions/1')).json()).snapshotJson),snapshot(100));
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

test('save lineage claims once atomically, signs authoritative ownership and preserves request replay',async()=>{
 const players=['EC1XlineageA','EC1XlineageB','EC1XlineageC'];
 for(const player of players)await db.prepare('INSERT INTO player(id,display_name) VALUES(?,?)').bind(player,'Name '+player).run();
 const unbound={saveId:'synthetic_lineage_123456789',playerId:'',displayName:'untrusted',proof:''};
 const body={...envelope(0,'lineage-first',88),snapshotJson:JSON.stringify({...JSON.parse(snapshot(88)),ownership:unbound})};
 const pair=await Promise.all(players.slice(0,2).map(player=>request('latest',body,player)));
 assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
 const winner=players[pair.findIndex(r=>r.status===200)],loser=players.find(p=>p!==winner&&p!==players[2]);
 const metadata=await pair.find(r=>r.status===200).json();
 assert.equal(metadata.ownership.playerId,winner);assert.equal(metadata.ownership.displayName,'Name '+winner);assert.ok(metadata.ownership.proof.length>32);
 const restored=await(await request('revisions/1',null,winner)).json();
 assert.deepEqual(JSON.parse(restored.snapshotJson).ownership,metadata.ownership);
 assert.deepEqual((await(await request('latest',body,winner)).json()).ownership,metadata.ownership);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM classic_save_owner WHERE save_id=?').bind(unbound.saveId).first()).n,1);
 assert.equal((await(await request('latest',null,loser)).json()).revision,0);
 const bound={...body,operationId:'lineage-bound',expectedRevision:1,snapshotJson:restored.snapshotJson};
 assert.equal((await request('latest',bound,winner)).status,200);
 const mismatch=await request('latest',{...bound,expectedRevision:0},loser);assert.equal(mismatch.status,409);
 const denied=await mismatch.json();assert.equal(denied.error,'account_mismatch');assert.equal(denied.owner.playerId,winner);assert.equal(denied.owner.proof,undefined);
 const tampered=JSON.parse(restored.snapshotJson);tampered.ownership.proof='forged';
 assert.equal((await request('latest',{...bound,expectedRevision:2,operationId:'lineage-forged',snapshotJson:JSON.stringify(tampered)},winner)).status,400);
 // Stripping the signed owner while retaining known lineage never permits a second claim.
 const strippedResponse=await request('latest',{...body,operationId:'lineage-stripped'},loser);assert.equal(strippedResponse.status,409);
 const strippedError=await strippedResponse.json();assert.deepEqual(strippedError.owner,{saveId:unbound.saveId,playerId:winner,displayName:'Name '+winner});assert.equal(strippedError.owner.proof,undefined);
 // A staged or conditional-publication failure cannot reserve ownership.
 for(const fault of ['stage','put']){
  const saveId='failed_lineage_'+fault+'_12345',snapshotJson=JSON.stringify({...JSON.parse(snapshot(99)),ownership:{...unbound,saveId}});
  assert.equal((await request('latest',{...body,snapshotJson,operationId:'lineage-fail-'+fault},players[2],fault)).status,503);
  assert.equal(await db.prepare('SELECT * FROM classic_save_owner WHERE save_id=?').bind(saveId).first(),null);
 }
 const staleId='stale_lineage_123456789';
 assert.equal((await request('latest',{...body,expectedRevision:9,operationId:'lineage-stale',snapshotJson:JSON.stringify({...JSON.parse(snapshot()),ownership:{...unbound,saveId:staleId}})},players[2])).status,409);
 assert.equal(await db.prepare('SELECT * FROM classic_save_owner WHERE save_id=?').bind(staleId).first(),null);
 // A failure after both revision and owner INSERT rolls the entire batch back.
 await db.exec("CREATE TRIGGER fail_ownership_head BEFORE INSERT ON classic_backup_head WHEN NEW.player_id='EC1XlineageC' BEGIN SELECT RAISE(ABORT,'synthetic atomic failure'); END");
 const failedId='rollback_lineage_123456789';
 const rollback=await request('latest',{...body,operationId:'lineage-rollback',snapshotJson:JSON.stringify({...JSON.parse(snapshot()),ownership:{...unbound,saveId:failedId}})},players[2]);
 assert.equal(rollback.status,503);
 assert.equal(await db.prepare('SELECT * FROM classic_save_owner WHERE save_id=?').bind(failedId).first(),null);
 assert.equal(await db.prepare('SELECT * FROM classic_backup_revision WHERE player_id=?').bind(players[2]).first(),null);
 await db.exec('DROP TRIGGER fail_ownership_head');
});

test('legacy immutable revision receives owner envelope without rewriting its bytes',async()=>{
 const player='EC1XlegacyOwnership',bytes=snapshot(334);
 await db.prepare('INSERT INTO player(id,display_name) VALUES(?,?)').bind(player,'Legacy Owner').run();
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bytes))).toString('hex');
 await(await mf.getR2Bucket('PLAYER_SAVES')).put('legacy-immutable-ownership',bytes);
 await db.prepare('INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,?,?,?,?,334,1,?,?)').bind(player,'legacy-immutable-ownership',hash,Buffer.byteLength(bytes),1,'legacy-owned-op','original-request-hash').run();
 await db.prepare('INSERT INTO classic_backup_head(player_id,revision) VALUES(?,1)').bind(player).run();
 const result=await(await request('revisions/1',null,player)).json();
 assert.equal(result.snapshotJson,bytes);assert.equal(result.ownership.playerId,player);assert.ok(result.ownership.saveId.startsWith('legacy_'));
 assert.deepEqual((await(await request('latest',null,player)).json()).ownership,result.ownership);
 const other='EC1XlegacyOwnershipOther';await db.prepare('INSERT INTO player(id) VALUES(?)').bind(other).run();
 const stripped={...result.ownership,playerId:'',proof:''};
 const crossAccount=await request('latest',{...envelope(0,'legacy-stripped-claim',334),snapshotJson:JSON.stringify({...JSON.parse(bytes),ownership:stripped})},other);
 assert.equal(crossAccount.status,409);assert.equal((await crossAccount.json()).error,'account_mismatch');
 assert.equal(await db.prepare('SELECT * FROM classic_save_owner WHERE save_id=?').bind(stripped.saveId).first(),null);
 assert.equal((await(await request('revisions/1',null,player)).json()).snapshotJson,bytes);
});

test('ownership-less legacy uploads share global canonical content lineage',async()=>{
 for(const id of ['EC1XoldClientA','EC1XoldClientB'])await db.prepare('INSERT INTO player(id) VALUES(?)').bind(id).run();
 const body=envelope(0,'legacy-global-claim',845);
 const first=await request('latest',body,'EC1XoldClientA');assert.equal(first.status,200);
 assert.ok((await first.json()).ownership.saveId.startsWith('unbound_'));
 const second=await request('latest',body,'EC1XoldClientB');assert.equal(second.status,409);
 const denied=await second.json();assert.equal(denied.error,'account_mismatch');assert.equal(denied.owner.playerId,'EC1XoldClientA');assert.equal(denied.owner.displayName,'EC1XoldClientA');assert.equal(denied.owner.proof,undefined);
});
