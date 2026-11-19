import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
let mf,db,calls=[],mode='save';
const raw=JSON.stringify({gamedata:JSON.stringify({gold:123,ruby:7,timeCounter:1234}),inventory:'^^'});
before(async()=>{
 const b=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createBackupsApp} from './src/game/backups';const app=new Hono();app.use('*',async(c,n)=>{c.set('player',{playerId:c.req.header('X-Player'),scope:c.req.header('X-Scope')||'player'});await n()});app.route('/backups',createBackupsApp());app.onError((e,c)=>c.json({error:e.code||'unavailable'},e.status||503));export default {fetch(req,env,ctx){if(req.headers.get('X-Fault')){const bucket=env.PLAYER_SAVES;env={...env,PLAYER_SAVES:{put:bucket.put.bind(bucket),get:async()=>null}};}return app.fetch(req,env,ctx)}};`},bundle:true,format:'esm',platform:'browser',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'legacy-recovery'},r2Buckets:['PLAYER_SAVES','LEGACY_ARCHIVE'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true',PLAYER_TOKEN_SECRET:'synthetic-only-secret',LEGACY_MIGRATION_ENABLED:'true',PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic',PLAYFAB_RECOVERY_LOOKUP_SESSION_TICKET:'fixture-lookup-session',GPGS_RECOVERY_CLIENT_ID:'fixture-client',GPGS_RECOVERY_CLIENT_SECRET:'fixture-secret',GPGS_RECOVERY_APPLICATION_ID:'fixture-app'},outboundService:async req=>{
  const url=new URL(req.url);calls.push(url.pathname);
  if(url.hostname==='oauth2.googleapis.com'){const form=new URLSearchParams(await req.text());assert.equal(form.get('client_id'),'fixture-client');return Response.json({access_token:form.get('code').replace('verify-','')});}
  if(url.hostname==='games.googleapis.com'){assert.equal(url.pathname,'/games/v1/applications/fixture-app/verify');return Response.json({player_id:'gpgs-'+req.headers.get('Authorization').replace('Bearer ','')});}
  assert.equal(url.hostname,'synthetic.playfabapi.com');const b=await req.json();
  if(url.pathname==='/Client/GetPlayFabIDsFromGooglePlayGamesPlayerIDs'){assert.equal(req.headers.get('X-Authorization'),'fixture-lookup-session');if(mode==='lookup-expired')return Response.json({error:'SessionTicketExpired'},{status:400});if(mode==='lookup-malformed')return Response.json({data:{Data:[]}});return Response.json({data:{Data:[{GooglePlayGamesPlayerId:b.GooglePlayGamesPlayerIDs[0],PlayFabId:mode==='mixed-missing'||mode==='lookup-found'?b.GooglePlayGamesPlayerIDs[0].replace('gpgs-',''):null}]}});}
  if(url.pathname==='/Client/LoginWithGooglePlayGamesServices'){assert.equal(b.CreateAccount,false);assert.equal('SessionTicket' in b,false);if(mode==='network')return Response.json({error:'ServiceUnavailable'},{status:503});if(mode==='auth')return Response.json({error:'InvalidGoogleToken'},{status:400});if(mode==='missing'||mode==='mixed-missing'||mode.startsWith('lookup-'))return Response.json({error:'AccountNotFound'},{status:400});return Response.json({data:{PlayFabId:b.ServerAuthCode.replace('playfab-',''),NewlyCreated:false}});}
  if(url.pathname==='/Server/GetUserAccountInfo')return Response.json({data:{UserInfo:{PlayFabId:b.PlayFabId,GooglePlayGamesInfo:{GooglePlayGamesPlayerId:mode==='mismatch'?'other':'gpgs-'+b.PlayFabId},TitleInfo:{isBanned:mode==='banned'}}}});
  if(url.pathname==='/Server/GetUserData')return Response.json({data:{Data:mode==='empty'?{}:{CLOUD_ALL_DATA:{Value:mode==='damaged'?'':raw},Playtime:{Value:'99999'},...(mode==='mail'?{EC_MAIL_REWARDS:{Value:'[{"gold":1}]'}}:{})}}});
  if(url.pathname==='/Server/GetUserInventory')return Response.json({data:{Inventory:[],VirtualCurrency:{}}});
  throw Error('Unexpected source mutation/network '+url.pathname);
 }}));
 db=await mf.getD1Database('DB');for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
});
after(async()=>mf?.dispose());
async function player(id){await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES(?,0,0)').bind(id).run();}
async function post(id,source,op='recover-operation',extra={},suffix=''){const r=await mf.dispatchFetch('https://test/backups/legacy-recovery'+suffix,{method:'POST',headers:{'Content-Type':'application/json','X-Player':id,...extra.headers},body:JSON.stringify({operationId:op,serverAuthCode:'verify-'+source,playFabServerAuthCode:'playfab-'+source,...extra.body})});return {status:r.status,body:await r.json()};}
test('verified GPGS source imports cloud only, archives original and idempotently replays without provider calls',async()=>{
 mode='save';await player('dest-one');const r=await post('dest-one','AAAABBBB0001');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.status,'recovered');assert.equal(r.body.playerId,'dest-one');assert.equal(r.body.playtime,1234);
 const revision=await db.prepare('SELECT * FROM classic_backup_revision WHERE player_id=?').bind('dest-one').first();const bytes=await(await(await mf.getR2Bucket('PLAYER_SAVES')).get(revision.r2_key)).text();assert.equal(JSON.parse(bytes).progress.gold,123);assert.equal(JSON.parse(bytes).ownership.playerId,'dest-one');
 const receipt=await db.prepare('SELECT * FROM legacy_recovery_receipt').first();const original=JSON.parse(await(await(await mf.getR2Bucket('LEGACY_ARCHIVE')).get(receipt.archive_key)).text());assert.equal(original.userData.Data.CLOUD_ALL_DATA.Value,raw);
 const before=calls.length;assert.deepEqual(await post('dest-one','AAAABBBB0001'),r);assert.equal(calls.length,before);
 await player('dest-two');assert.equal((await post('dest-two','AAAABBBB0001')).body.error,'legacy_source_claimed');
});
test('existing destination rejected before any provider call; migration scope rejected',async()=>{
 const before=calls.length;assert.equal((await post('dest-one','AAAABBBB0002','another-operation')).body.error,'cloud_backup_already_exists');assert.equal(calls.length,before);
 assert.equal((await post('dest-two','AAAABBBB0002','another-operation',{headers:{'X-Scope':'migration'}})).status,403);
});
test('only confirmed absence allows Google fallback; proof bound destination and operation',async()=>{
 mode='missing';await player('google-dest');await player('google-other');const start=await post('google-dest','AAAABBBB0003');assert.equal(start.body.status,'google_saved_games_required');const body={recoveryToken:start.body.recoveryToken,rawSaveJson:raw,legacyPlaytime:777};
 assert.equal((await post('google-other','x','recover-operation',{body},'/google')).status,401);
 assert.equal((await post('google-dest','x','different-operation',{body},'/google')).status,401);
 const result=await post('google-dest','x','recover-operation',{body},'/google');assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.status,'recovered');assert.equal((await db.prepare("SELECT COUNT(*) n FROM legacy_recovery_claim WHERE player_id='google-dest'").first()).n,1);
});
test('network/auth/mismatched identity, bans and malformed present saves never produce fallback',async()=>{
 let i=10;for(const failure of ['network','auth','mismatch','banned','damaged','mail']){mode=failure;const id='failure-'+failure;await player(id);const result=await post(id,'AAAABBBB00'+i++);assert.notEqual(result.status,200,JSON.stringify(result));assert.equal(result.body.recoveryToken,undefined);assert.equal(await db.prepare('SELECT * FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);}
});
test('stage failure commits no claims and a retry succeeds',async()=>{
 mode='save';await player('stage-dest');const failed=await post('stage-dest','AAAABBBB0020','recover-operation',{headers:{'X-Fault':'readback'}});assert.equal(failed.status,503);assert.equal((await db.prepare("SELECT COUNT(*) n FROM legacy_recovery_claim WHERE player_id='stage-dest'").first()).n,0);assert.equal((await post('stage-dest','AAAABBBB0020')).status,200);
});
test('two destinations compete atomically for same source',async()=>{
 mode='save';await player('race-one');await player('race-two');const pair=await Promise.all([post('race-one','AAAABBBB0030'),post('race-two','AAAABBBB0030')]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);assert.equal((await db.prepare("SELECT COUNT(*) n FROM classic_backup_revision WHERE player_id IN ('race-one','race-two')").first()).n,1);
});
test('classic publisher cannot claim a recovered source and its whole batch rolls back',async()=>{
 const source='AAAABBBB0001';await player(source);
 await assert.rejects(db.batch([
 db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,'classic-conflict','hash',1,1,0,0,'classic-conflict','hash')").bind(source),
 db.prepare("INSERT INTO classic_migration(player_id,source_hash,archive_key,raw_save_hash,revision,created_at) VALUES(?,'hash','classic-original','hash',1,0)").bind(source)]));
 assert.equal(await db.prepare('SELECT * FROM classic_backup_revision WHERE player_id=?').bind(source).first(),null);
});
test('a historical Classic publication blocks recovery to another destination',async()=>{
 mode='save';const source='AAAABBBB0040';await player(source);await player('already-migrated');
 await db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,'classic-existing','hash',1,1,0,0,'classic-existing','hash')").bind(source).run();
 await db.prepare("INSERT INTO classic_migration(player_id,source_hash,archive_key,raw_save_hash,revision,created_at) VALUES(?,'hash','classic-original-40','hash',1,0)").bind(source).run();
 assert.equal((await post('already-migrated',source)).body.error,'legacy_source_claimed');
});
test('mixed code absence cannot bypass imported source, and independent lookup recovers actual verified source',async()=>{
 mode='mixed-missing';await player('mixed-code');assert.equal((await post('mixed-code','AAAABBBB0040','recover-operation',{body:{playFabServerAuthCode:'playfab-UNRELATED'}})).body.error,'legacy_source_claimed');
 mode='lookup-found';await player('lookup-found');const found=await post('lookup-found','AAAABBBB0050','recover-operation',{body:{playFabServerAuthCode:'playfab-UNRELATED'}});assert.equal(found.status,200,JSON.stringify(found));assert.equal(found.body.status,'recovered');
 for(const failure of ['lookup-expired','lookup-malformed']){mode=failure;await player(failure);const result=await post(failure,'AAAABBBB0060');assert.equal(result.status,503);assert.equal(result.body.recoveryToken,undefined);}
});
test('empty legacy authentication cutover is eligible; fallback claims both verified source aliases',async()=>{
 mode='empty';await player('empty-cutover');await db.prepare("UPDATE player SET migrated_at=123,save_state='migrated' WHERE id='empty-cutover'").run();
 const r=await post('empty-cutover','AAAABBBB0070');assert.equal(r.body.status,'google_saved_games_required');const imported=await post('empty-cutover','unused','recover-operation',{body:{recoveryToken:r.body.recoveryToken,rawSaveJson:raw}},'/google');assert.equal(imported.status,200,JSON.stringify(imported));assert.equal((await db.prepare("SELECT count(*) n FROM legacy_recovery_claim WHERE player_id='empty-cutover'").first()).n,2);
});
test('manual first upload racing recovery publishes exactly one backup without leaked source claims',async()=>{
 mode='save';await player('manual-race');const row=await db.prepare("SELECT r2_key FROM classic_backup_revision WHERE player_id='dest-one'").first();const snapshot=JSON.parse(await(await(await mf.getR2Bucket('PLAYER_SAVES')).get(row.r2_key)).text());delete snapshot.ownership;
 const manual=mf.dispatchFetch('https://test/backups/latest',{method:'PUT',headers:{'Content-Type':'application/json','X-Player':'manual-race'},body:JSON.stringify({game:'ec1',schemaVersion:1,expectedRevision:0,operationId:'manual-race-operation',snapshotJson:JSON.stringify(snapshot)})});
 const recovery=post('manual-race','AAAABBBB0080');const [upload,recovered]=await Promise.all([manual,recovery]);assert.deepEqual([upload.status,recovered.status].sort(),[200,409]);assert.equal((await db.prepare("SELECT count(*) n FROM classic_backup_revision WHERE player_id='manual-race'").first()).n,1);
 if(upload.status===200)assert.equal((await db.prepare("SELECT count(*) n FROM legacy_recovery_claim WHERE player_id='manual-race'").first()).n,0);
});
test('publication failure rolls back claims, ownership and revision together',async()=>{
 mode='save';await player('db-failure');await db.exec("CREATE TRIGGER fixture_recovery_failure BEFORE INSERT ON legacy_recovery_receipt WHEN NEW.player_id='db-failure' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.equal((await post('db-failure','AAAABBBB0090')).status,503);
 for(const table of ['legacy_recovery_claim','classic_save_owner','classic_backup_revision','classic_backup_head'])assert.equal((await db.prepare(`SELECT count(*) n FROM ${table} WHERE player_id='db-failure'`).first()).n,0);
 await db.exec('DROP TRIGGER fixture_recovery_failure');assert.equal((await post('db-failure','AAAABBBB0090')).status,200);
});

