import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
let mf,db,calls=[],mode='save';
const raw=JSON.stringify({gamedata:JSON.stringify({gold:123,ruby:7,timeCounter:1234}),inventory:'^^'});
before(async()=>{
 const b=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createBackupsApp} from './src/game/backups';import {createAuthApp} from './src/auth/index';const app=new Hono();app.use('*',async(c,n)=>{c.set('player',{playerId:c.req.header('X-Player'),scope:c.req.header('X-Scope')||'player'});await n()});app.route('/backups',createBackupsApp());app.route('/api/auth',createAuthApp());app.onError((e,c)=>c.json({error:e.code||'unavailable'},e.status||503));export default {fetch(req,env,ctx){if(req.headers.get('X-Fault')){const bucket=env.PLAYER_SAVES;env={...env,PLAYER_SAVES:{put:bucket.put.bind(bucket),get:async()=>null}};}return app.fetch(req,env,ctx)}};`},bundle:true,format:'esm',platform:'browser',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'legacy-recovery'},r2Buckets:['PLAYER_SAVES','LEGACY_ARCHIVE'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true',PLAYER_TOKEN_SECRET:'synthetic-only-secret-at-least-32-characters',ALLOW_NEW_ACCOUNTS:'false',LEGACY_MIGRATION_ENABLED:'true',PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic',PLAYFAB_RECOVERY_LOOKUP_CUSTOM_ID:'fixture-existing-custom-id',GPGS_RECOVERY_CLIENT_ID:'fixture-client',GPGS_RECOVERY_CLIENT_SECRET:'fixture-secret',GPGS_RECOVERY_APPLICATION_ID:'fixture-app'},outboundService:async req=>{
  const url=new URL(req.url);calls.push(url.pathname);
  if(url.hostname==='oauth2.googleapis.com'){const form=new URLSearchParams(await req.text());assert.equal(form.get('client_id'),'fixture-client');return Response.json({access_token:form.get('code').replace('verify-','')});}
  if(url.hostname==='games.googleapis.com'){assert.equal(url.pathname,'/games/v1/applications/fixture-app/verify');return Response.json({player_id:'gpgs-'+req.headers.get('Authorization').replace('Bearer ','')});}
  assert.equal(url.hostname,'synthetic.playfabapi.com');const b=await req.json();
  if(url.pathname==='/Client/LoginWithCustomID'){assert.equal(b.CreateAccount,false);assert.equal(b.CustomId,'fixture-existing-custom-id');if(mode==='lookup-custom-failed')return Response.json({error:'AccountNotFound'},{status:400});return Response.json({data:{SessionTicket:'fixture-lookup-session',NewlyCreated:false}});}if(url.pathname==='/Client/GetPlayFabIDsFromGooglePlayGamesPlayerIDs'){assert.equal(req.headers.get('X-Authorization'),'fixture-lookup-session');if(mode==='lookup-expired')return Response.json({error:'SessionTicketExpired'},{status:400});if(mode==='lookup-malformed')return Response.json({data:{Data:[]}});return Response.json({data:{Data:[{GooglePlayGamesPlayerId:b.GooglePlayGamesPlayerIDs[0],PlayFabId:mode==='mixed-missing'||mode==='lookup-found'?b.GooglePlayGamesPlayerIDs[0].replace('gpgs-',''):null}]}});}
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
async function signin(source,operationId='gpgs-operation',extra={},suffix=''){
 const r=await mf.dispatchFetch('https://test/api/auth/gpgs/legacy'+suffix,{method:'POST',headers:{'Content-Type':'application/json',...extra.headers},body:JSON.stringify({operationId,serverAuthCode:'verify-'+source,playFabServerAuthCode:'playfab-'+source,...extra.body})});return {status:r.status,body:await r.json()};
}
test('verified legacy cloud atomically creates identity+backup with account creation disabled; later signin calls no PlayFab',async()=>{
 mode='save';const first=await signin('AAAABBBB0001');assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.status,'authenticated');assert.equal(first.body.playerId,'AAAABBBB0001');assert.ok(first.body.accessToken);assert.ok(first.body.refreshToken);
 assert.equal((await db.prepare("SELECT player_id FROM auth_identity WHERE provider='gpgs' AND subject='gpgs-AAAABBBB0001'").first()).player_id,first.body.playerId);
 assert.equal((await db.prepare("SELECT count(*) n FROM classic_backup_revision WHERE player_id='AAAABBBB0001'").first()).n,1);assert.equal((await db.prepare("SELECT count(*) n FROM legacy_recovery_claim WHERE player_id='AAAABBBB0001'").first()).n,2);
 const before=calls.filter(x=>x.startsWith('/Client')||x.startsWith('/Server')).length;mode='network';const later=await signin('AAAABBBB0001','later-operation');assert.equal(later.status,200,JSON.stringify(later));assert.equal(later.body.playerId,first.body.playerId);assert.equal(calls.filter(x=>x.startsWith('/Client')||x.startsWith('/Server')).length,before);
});
test('manual recovery source claim signs into destination owner instead of creating source account or replacing cloud',async()=>{
 mode='save';await player('manual-destination');assert.equal((await post('manual-destination','AAAABBBB0002')).status,200);const before=calls.length;mode='network';const result=await signin('AAAABBBB0002');assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.playerId,'manual-destination');assert.deepEqual(calls.slice(before),['/token','/games/v1/applications/fixture-app/verify']);assert.equal(await db.prepare("SELECT * FROM player WHERE id='AAAABBBB0002'").first(),null);assert.equal((await db.prepare("SELECT count(*) n FROM classic_backup_revision WHERE player_id='manual-destination'").first()).n,1);
});
test('verified empty source does not create player; positive Saved Games fallback atomically migrates and capability cannot cross route domains',async()=>{
 mode='empty';const start=await signin('AAAABBBB0003');assert.equal(start.status,200,JSON.stringify(start));assert.equal(start.body.status,'google_saved_games_required');assert.equal(await db.prepare("SELECT * FROM player WHERE id='AAAABBBB0003'").first(),null);assert.equal(await db.prepare("SELECT * FROM auth_identity WHERE subject='gpgs-AAAABBBB0003'").first(),null);
 await player('foreign-destination');const b={recoveryToken:start.body.recoveryToken,rawSaveJson:raw};assert.equal((await post('foreign-destination','x','gpgs-operation',{body:b},'/google')).status,401);
 assert.equal((await signin('unused','wrong-operation',{body:b},'/google')).status,401);
 const imported=await signin('unused','gpgs-operation',{body:b},'/google');assert.equal(imported.status,200,JSON.stringify(imported));assert.equal(imported.body.status,'authenticated');assert.equal(imported.body.playerId,'AAAABBBB0003');const again=await signin('unused','gpgs-operation',{body:b},'/google');assert.equal(again.status,200);assert.equal(again.body.refreshToken,imported.body.refreshToken);
});
test('true no-account lookup uses only preexisting CustomID CreateAccount false; no SavedGames leaves no fabricated account',async()=>{
 mode='missing';const start=await signin('AAAABBBB0004');assert.equal(start.status,200,JSON.stringify(start));assert.equal(start.body.status,'google_saved_games_required');assert.equal(await db.prepare("SELECT * FROM auth_identity WHERE subject='gpgs-AAAABBBB0004'").first(),null);assert.ok(calls.includes('/Client/LoginWithCustomID'));
 const imported=await signin('unused','gpgs-operation',{body:{recoveryToken:start.body.recoveryToken,rawSaveJson:raw}},'/google');assert.equal(imported.status,200,JSON.stringify(imported));assert.match(imported.body.playerId,/^EC1G/);
 mode='lookup-custom-failed';const failed=await signin('AAAABBBB0005');assert.equal(failed.status,503);assert.equal(failed.body.recoveryToken,undefined);assert.equal(await db.prepare("SELECT * FROM auth_identity WHERE subject='gpgs-AAAABBBB0005'").first(),null);
});
test('bad proof, legacy outages, bans and damaged source create neither identities nor accounts',async()=>{
 let n=10;for(const failure of ['network','auth','mismatch','banned','damaged','mail','lookup-expired','lookup-malformed']){mode=failure;const source='AAAABBBB00'+n++;const r=await signin(source);assert.notEqual(r.status,200,JSON.stringify(r));assert.equal(r.body.recoveryToken,undefined);assert.equal(await db.prepare('SELECT * FROM player WHERE id=?').bind(source).first(),null);assert.equal(await db.prepare('SELECT * FROM auth_identity WHERE subject=?').bind('gpgs-'+source).first(),null);}
});
test('backend owner ban prevents GPGS session even when a source claim proves ownership',async()=>{
 await db.prepare("INSERT INTO player_ban(player_id,reason,created_at) VALUES('manual-destination','fixture',0)").run();mode='network';const r=await signin('AAAABBBB0002','banned-operation');assert.equal(r.status,403);assert.equal(r.body.error,'player_banned');
});
test('simultaneous migration attempts converge on one identity, one first revision and same owner',async()=>{
 mode='save';const result=await Promise.all([signin('AAAABBBB0030','race-operation-one'),signin('AAAABBBB0030','race-operation-two')]);assert.deepEqual(result.map(r=>r.status),[200,200],JSON.stringify(result));assert.equal(result[0].body.playerId,result[1].body.playerId);assert.equal((await db.prepare("SELECT count(*) n FROM classic_backup_revision WHERE player_id='AAAABBBB0030'").first()).n,1);assert.equal((await db.prepare("SELECT count(*) n FROM auth_identity WHERE subject='gpgs-AAAABBBB0030'").first()).n,1);
});
test('failed R2 staging and D1 publication leave no orphan account/identity/source claims',async()=>{
 mode='save';const id='AAAABBBB0040';const r=await signin(id,'stage-operation',{headers:{'X-Fault':'readback'}});assert.equal(r.status,503);assert.equal(await db.prepare('SELECT * FROM player WHERE id=?').bind(id).first(),null);
 const failed='AAAABBBB0041';await db.exec("CREATE TRIGGER fixture_gpgs_failure BEFORE INSERT ON legacy_recovery_receipt WHEN NEW.player_id='AAAABBBB0041' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const d=await signin(failed);assert.notEqual(d.status,200);for(const table of ['player','auth_identity','classic_backup_revision','legacy_recovery_claim'])assert.equal((await db.prepare(`SELECT count(*) n FROM ${table} WHERE ${table==='player'?'id':'player_id'}=?`).bind(failed).first()).n,0);await db.exec('DROP TRIGGER fixture_gpgs_failure');
});
test('existing historical PlayFab claim is safely associated with verified GPGS and cloud remains unchanged',async()=>{
 mode='save';const id='AAAABBBB0050';await player(id);await db.prepare("INSERT INTO legacy_recovery_claim VALUES(?,?,0)").bind('playfab:'+id,id).run();const r=await signin(id);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.playerId,id);assert.equal(await db.prepare('SELECT * FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);assert.equal((await db.prepare("SELECT player_id FROM auth_identity WHERE provider='gpgs' AND subject=?").bind('gpgs-'+id).first()).player_id,id);
});
test('native ban on empty legacy destination blocks publication and cannot leave a GPGS identity',async()=>{
 mode='save';const id='AAAABBBB0060';await player(id);await db.prepare('INSERT INTO player_ban(player_id,reason,created_at) VALUES(?,?,0)').bind(id,'fixture').run();const r=await signin(id);assert.equal(r.status,403,JSON.stringify(r));assert.equal(r.body.error,'player_banned');assert.equal(await db.prepare('SELECT 1 FROM classic_backup_head WHERE player_id=?').bind(id).first(),null);assert.equal(await db.prepare("SELECT 1 FROM auth_identity WHERE provider='gpgs' AND subject=?").bind('gpgs-'+id).first(),null);
});
test('known source binding fails as service outage if D1 publication fails, without minting a session',async()=>{
 const id='known-claim-outage';await player(id);await db.prepare('INSERT INTO legacy_recovery_claim VALUES(?,?,0)').bind('gpgs-claim-not-used',id).run();await db.prepare('INSERT INTO legacy_recovery_claim VALUES(?,?,0)').bind('gpgs:gpgs-AAAABBBB0061',id).run();
 await db.exec("CREATE TRIGGER fixture_binding_failure BEFORE INSERT ON auth_identity WHEN NEW.player_id='known-claim-outage' BEGIN SELECT RAISE(ABORT,'synthetic outage'); END");mode='network';const r=await signin('AAAABBBB0061');assert.equal(r.status,503,JSON.stringify(r));assert.equal(r.body.error,'legacy_identity_publication_unavailable');assert.equal(await db.prepare('SELECT 1 FROM auth_session WHERE player_id=?').bind(id).first(),null);await db.exec('DROP TRIGGER fixture_binding_failure');
});
test('existing canonical backup on original verified PlayFab ID is logged into without replacing any bytes',async()=>{
 mode='save';const id='AAAABBBB0062';await player(id);await db.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,'preexisting-manual','old-hash',1,1,5,0,'manual-existing','old-request')").bind(id).run();await db.prepare('INSERT INTO classic_backup_head VALUES(?,1)').bind(id).run();
 const start=calls.length,r=await signin(id);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.playerId,id);assert.equal(calls.slice(start).includes('/Server/GetUserData'),false);assert.equal((await db.prepare('SELECT sha256 FROM classic_backup_revision WHERE player_id=?').bind(id).first()).sha256,'old-hash');
});


