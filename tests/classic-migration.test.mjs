import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
let mf,db,calls=0;
const schema=JSON.parse(await readFile('src/game/canonical-schema.json','utf8'));
function defaults(t){if(['int','float','Rarity','EquipmentType','ItemType'].includes(t))return 0;if(t==='bool')return false;if(t==='string')return '';if(t.startsWith('List<'))return [];if(t.startsWith('Dictionary<'))return {};if(['FortressSaveRecord','ItemRecord'].includes(t))return null;return Object.fromEntries(Object.entries(schema[t]).map(([k,v])=>[k,defaults(v)]));}
function snapshot(time=1){const s=defaults('GameSaveRecord');s.schemaVersion=1;s.progress.timeCounter=time;s.characters=Array.from({length:4},(_,i)=>({...defaults('CharacterSaveRecord'),character:i}));s.achievements=Array(27).fill(0);s.daily.quests=Array.from({length:3},()=>defaults('DailyQuestSaveRecord'));return JSON.stringify(s);}
before(async()=>{
 const b=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createClassicMigrationApp,verifyClassicMigrationForCutover} from './src/migration/classic';import {createBackupsApp} from './src/game/backups';const app=new Hono();app.use('*',async(c,n)=>{c.set('player',{playerId:c.req.header('X-Player')||'ABCDEF123456',scope:c.req.header('X-Scope')||'migration'});await n()});app.post('/verify-cutover',async c=>c.json(await verifyClassicMigrationForCutover(c.env,c.get('player').playerId)));app.route('/backups',createBackupsApp());app.route('/',createClassicMigrationApp());app.onError((e,c)=>c.json({error:e.code||'unavailable'},e.status||503));export default {fetch(req,env,ctx){const fault=req.headers.get('X-Fault');if(fault){const bucket=env.PLAYER_SAVES;env={...env,PLAYER_SAVES:{put:fault==='put'?async()=>{throw Error('synthetic')}:bucket.put.bind(bucket),get:fault==='readback'?async()=>null:bucket.get.bind(bucket)}};}return app.fetch(req,env,ctx);}};`},bundle:true,format:'esm',platform:'browser',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'classic-migration'},r2Buckets:['PLAYER_SAVES','LEGACY_ARCHIVE'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true',LEGACY_MIGRATION_ENABLED:'true',PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic-only'},outboundService:async req=>{calls++;assert.equal(new URL(req.url).pathname,'/Server/GetUserData');const player=(await req.json()).PlayFabId;if(player==='AAAABBBB8888')return Response.json({data:{Data:{},DataVersion:0}});if(player==='AAAABBBB9999')return Response.json({data:{Data:{CLOUD_ALL_DATA:{Value:''}}}});if(player==='AAAABBBB0000')return Response.json({data:{Data:[]}});if(player==='AAAABBBB5555')return Response.json({data:{Data:{BROKEN:{Value:'original retained'}}}});return Response.json({data:{Data:{CLOUD_ALL_DATA:{Value:'{"legacy":"raw ✓"}'},EC_MAIL_REWARDS:{Value:'retained'}}}});}}));
 db=await mf.getD1Database('DB');for(const file of ['001_auth.sql','023_manual_backups.sql','026_classic_migration.sql'])await db.exec((await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 await db.exec("INSERT INTO player(id,created_at,updated_at) VALUES('ABCDEF123456',0,0)");
});
after(async()=>mf?.dispose());
async function post(path,body={},scope='migration',player='ABCDEF123456',fault){return mf.dispatchFetch('https://test/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Scope':scope,'X-Player':player,...(fault?{'X-Fault':fault}:{})},body:JSON.stringify(body)});}
test('source is immutable, cloud conversion seeds exactly first canonical revision; retries preserve provenance',async()=>{
 const source=await(await post('source')).json();assert.equal(source.rawSaveJson,'{"legacy":"raw ✓"}');assert.equal(calls,1);assert.deepEqual(await(await post('source')).json(),source);assert.equal(calls,1);
 const row=await db.prepare('SELECT * FROM classic_migration').first(),archive=await(await mf.getR2Bucket('LEGACY_ARCHIVE')).get(row.archive_key);assert.equal(JSON.parse(await archive.text()).userData.Data.EC_MAIL_REWARDS.Value,'retained');
 assert.equal((await post('import',{sourceHash:'wrong',snapshotJson:snapshot(),expectedRevision:0})).status,409);
 assert.equal((await post('import',{sourceHash:source.sourceHash,snapshotJson:'{}',expectedRevision:0})).status,400);
 const body={sourceHash:source.sourceHash,snapshotJson:snapshot(),expectedRevision:0};const imported=await(await post('import',body)).json();assert.equal(imported.revision,1);assert.deepEqual(await(await post('import',body)).json(),imported);assert.equal((await post('import',{...body,snapshotJson:snapshot(2)})).status,409);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM classic_backup_revision').first()).n,1);assert.equal((await db.prepare('SELECT source FROM classic_backup_revision').first()).source,'playfab_migration');assert.equal((await db.prepare('SELECT completed_at FROM classic_migration').first()).completed_at,null);assert.equal(calls,1);
});
test('completion needs native identity; restricted import cannot finalize and source corruption is rejected',async()=>{
 assert.equal((await post('complete')).status,403);assert.equal((await post('complete',{},'player')).status,403);
 await db.exec("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('email','synthetic@example.test','ABCDEF123456',0)");
 let response=await post('complete',{},'player');assert.equal(response.status,200);assert.equal((await response.json()).complete,true);assert.equal((await db.prepare('SELECT save_state FROM player').first()).save_state,'migrated');
 assert.equal((await post('complete',{},'player')).status,200);
 const row=await db.prepare('SELECT archive_key FROM classic_migration').first();await(await mf.getR2Bucket('LEGACY_ARCHIVE')).put(row.archive_key,'corrupt');assert.equal((await post('source')).status,503);assert.equal(calls,1);
});

async function player(id){await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES(?,0,0)').bind(id).run();}
test('storage failures and malformed conversion preserve source without publishing; native new accounts never call PlayFab',async()=>{
 const id='AAAABBBB1111';await player(id);const src=await(await post('source',{},'migration',id)).json(),row=await db.prepare('SELECT * FROM classic_migration WHERE player_id=?').bind(id).first();
 const archiveBucket=await mf.getR2Bucket('LEGACY_ARCHIVE'),original=await(await archiveBucket.get(row.archive_key)).text();
 const body={sourceHash:src.sourceHash,snapshotJson:snapshot(),expectedRevision:0};
 for(const fault of ['put','readback'])assert.equal((await post('import',body,'migration',id,fault)).status,503);
 assert.equal((await post('import',{...body,snapshotJson:'{}'},'migration',id)).status,400);
 assert.equal(await db.prepare('SELECT 1 FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);assert.equal(await(await archiveBucket.get(row.archive_key)).text(),original);
 await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('google',?,?,0)").bind('synthetic-'+id,id).run();assert.equal((await post('complete',{},'player',id)).status,409);
 const before=calls;assert.deepEqual(await(await post('source',{},'migration',id)).json(),src);assert.equal(calls,before);
 const other='AAAABBBB2222';await player(other);assert.equal((await post('source',{},'player',other)).status,403);assert.equal(calls,before);assert.equal((await post('import',body,'migration',other)).status,409);
});
test('lost acknowledgment retries return migration revision after manual head advances; existing first head never overwritten',async()=>{
 const id='AAAABBBB3333';await player(id);const src=await(await post('source',{},'migration',id)).json();const body={sourceHash:src.sourceHash,snapshotJson:snapshot(5),expectedRevision:0};
 const first=await(await post('import',body,'migration',id)).json();assert.equal(first.revision,1);
 await db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) SELECT player_id,2,r2_key||'/manual',sha256,bytes,schema_version,1,created_at,'manual-after','manual' FROM classic_backup_revision WHERE player_id=? AND revision=1").bind(id).run();await db.prepare('UPDATE classic_backup_head SET revision=2 WHERE player_id=?').bind(id).run();
 assert.deepEqual(await(await post('import',body,'migration',id)).json(),first);assert.equal((await db.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first()).revision,2);
 const racer='AAAABBBB4444';await player(racer);const source=await(await post('source',{},'migration',racer)).json();
 await db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,'manual-race','hash',1,1,0,0,'manual-race','manual')").bind(racer).run();await db.prepare('INSERT INTO classic_backup_head VALUES(?,1)').bind(racer).run();
 assert.equal((await post('import',{...body,sourceHash:source.sourceHash},'migration',racer)).status,409);assert.equal((await db.prepare('SELECT source FROM classic_backup_revision WHERE player_id=?').bind(racer).first()).source,'manual_upload');assert.equal((await db.prepare('SELECT revision FROM classic_migration WHERE player_id=?').bind(racer).first()).revision,null);
});

test('missing legacy core still preserves original and retries never refetch; corrupt canonical bytes cannot complete',async()=>{
 const missing='AAAABBBB5555';await player(missing);assert.equal((await post('source',{},'migration',missing)).status,409);const row=await db.prepare('SELECT * FROM classic_migration WHERE player_id=?').bind(missing).first();assert.ok(row);const archive=await(await mf.getR2Bucket('LEGACY_ARCHIVE')).get(row.archive_key);assert.equal(JSON.parse(await archive.text()).userData.Data.BROKEN.Value,'original retained');const before=calls;assert.equal((await post('source',{},'migration',missing)).status,409);assert.equal(calls,before);
 const id='AAAABBBB6666';await player(id);const src=await(await post('source',{},'migration',id)).json();assert.equal((await post('import',{sourceHash:src.sourceHash,snapshotJson:snapshot(),expectedRevision:0},'migration',id)).status,200);await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('google',?,?,0)").bind('synthetic-'+id,id).run();const revision=await db.prepare('SELECT r2_key FROM classic_backup_revision WHERE player_id=?').bind(id).first();await(await mf.getR2Bucket('PLAYER_SAVES')).put(revision.r2_key,'corrupt');assert.equal((await post('complete',{},'player',id)).status,503);assert.equal((await db.prepare('SELECT completed_at FROM classic_migration WHERE player_id=?').bind(id).first()).completed_at,null);
});

test('concurrent manual upload and migration compete for exactly one first revision',async()=>{
 const id='AAAABBBB7777';await player(id);const src=await(await post('source',{},'migration',id)).json();
 const manual=mf.dispatchFetch('https://test/backups/latest',{method:'PUT',headers:{'Content-Type':'application/json','X-Player':id,'X-Scope':'player'},body:JSON.stringify({game:'ec1',schemaVersion:1,expectedRevision:0,operationId:'manual-racing',snapshotJson:snapshot(9)})});
 const imported=post('import',{sourceHash:src.sourceHash,snapshotJson:snapshot(2),expectedRevision:0,deviceId:'different-device-is-ignored'},'migration',id);
 const pair=await Promise.all([manual,imported]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM classic_backup_revision WHERE player_id=?').bind(id).first()).n,1);assert.equal((await db.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first()).revision,1);
});

test('verified empty legacy account cuts over identity without a fabricated revision or local upload',async()=>{
 const id='AAAABBBB8888';await player(id);const response=await post('source',{},'migration',id);assert.equal(response.status,200);const src=await response.json();assert.equal(src.hasCloudSave,false);assert.equal(src.playerId,id);assert.equal(typeof src.sourceHash,'string');assert.equal('rawSaveJson' in src,false);
 const before=calls;assert.deepEqual(await(await post('source',{},'migration',id)).json(),src);assert.equal(calls,before);assert.deepEqual(await(await post('verify-cutover',{},'migration',id)).json(),{hasCloudSave:false,playerId:id,sourceHash:src.sourceHash});
 assert.equal((await post('import',{sourceHash:src.sourceHash,expectedRevision:0,snapshotJson:snapshot()},'migration',id)).status,409);assert.equal(await db.prepare('SELECT 1 FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);assert.equal(await db.prepare('SELECT 1 FROM classic_backup_revision WHERE player_id=?').bind(id).first(),null);
 const row=await db.prepare('SELECT * FROM classic_migration WHERE player_id=?').bind(id).first();assert.equal(row.revision,null);assert.equal(row.completed_at,null);const bucket=await mf.getR2Bucket('LEGACY_ARCHIVE');const original=await(await bucket.get(row.archive_key)).text();assert.deepEqual(JSON.parse(original).userData,{Data:{},DataVersion:0});
 await db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,'empty-conflict','hash',1,1,0,0,'empty-conflict','manual')").bind(id).run();await db.prepare('INSERT INTO classic_backup_head VALUES(?,1)').bind(id).run();assert.equal((await post('verify-cutover',{},'migration',id)).status,409);
 await bucket.put(row.archive_key,'corrupt');assert.equal((await post('verify-cutover',{},'migration',id)).status,503);
});
test('empty core string and non-object Data stay damaged sources, never empty-account cutover',async()=>{
 for(const id of ['AAAABBBB9999','AAAABBBB0000']){await player(id);assert.equal((await post('source',{},'migration',id)).status,409);assert.equal((await post('verify-cutover',{},'migration',id)).status,409);assert.ok(await db.prepare('SELECT archive_key FROM classic_migration WHERE player_id=?').bind(id).first());assert.equal(await db.prepare('SELECT 1 FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);}
});
