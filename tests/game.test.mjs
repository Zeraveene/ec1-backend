import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
let mf,db,guest,requests=[],workerScript;
const bases=Object.fromEntries(await Promise.all(['alaster','edna'].map(async c=>[c,await readFile(`tests/fixtures/${c}base.json`,'utf8')])));
const keys=['alaster_attributes','edna_attributes','louisa_attributes','soul_attributes','gamedata','inventory','consumable','LastReward','LastRewardTime','selected','getOffer','achievements_new','task0_claimed','task1_claimed','task2_claimed','task_all_claimed','dailyBoosterQuota','entry_treasure','entry_march','entry_chaos','lbId','lbName','louisaUnlock','soulUnlock','premium','more_exp','double_loot','dualTaken',...['alaster','edna','louisa','soul'].flatMap(c=>Array.from({length:8},(_,i)=>`costume_${c}_${i+1}`))];
function snapshot(version=0,id='initial-save',progress=0,time=0){
 const prefs=Object.fromEntries(keys.map(k=>[k,'0']));
 for(const k of ['elysianTaken','stepUp1','stepUp2','stepUp3','stepUp4','stepUp5','task0','task1','task2','task0_progress','task1_progress','task2_progress','petCombat','marchWave','chaosWave','fortress','legendUnlock','gameclear','difficulty','tutorial_status','tutorial_inventory','tutorial_skill','tutorial_blacksmith','tutorial_merchant','tutorial_companion','dailyReset','buff_exp_end','buff_loot_end','playtime'])prefs[k]='0';
 for(const c of ['alaster','edna','louisa','soul']){prefs[`costume_${c}`]='0';prefs[`transmog_${c}`]='';}
 prefs.selectedPet='';prefs.stageEpilog='';
 Object.assign(prefs,{alaster_attributes:bases.alaster,edna_attributes:bases.edna,louisa_attributes:'',soul_attributes:'',gamedata:JSON.stringify({gold:0,ruby:0,stageProgress:progress,tutorialProgress:0,timeCounter:time,usedCoupons:[],stageInfo:[],stat_goldEarned:0,stat_rubyEarned:0}),inventory:'^^',consumable:'',LastRewardTime:'',selected:'alaster',achievements_new:Array(27).fill('0').join('|'),lbId:'',lbName:'',elysianTaken:'0',future_field:'zero-preserved',dailyReset:'0'});
 return {game:'ec1',schemaVersion:1,playtime:time,data:{CLOUD_ALL_DATA:JSON.stringify(prefs),Playtime:String(time),future:'preserved'},expectedSaveVersion:version,operationId:id,intent:'new_game'};
}
before(async()=>{
 const result=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono'; import {createAuthApp,requirePlayer} from './src/auth';import {createGameApp,publishSnapshot} from './src/game';import {selectMigrationWinner} from './src/migration';import {readPlayFab} from './src/migration/playfab';const app=new Hono();app.route('/api/auth',createAuthApp());app.route('/api/game',createGameApp());app.post('/test/winner',async c=>{const b=await c.req.json();return c.json(selectMigrationWinner(b.cloud,b.local));});app.post('/test/mutation',async c=>c.json(await readPlayFab(c.env,'Server/UpdateUserData',{})));app.put('/test/failed-stage',requirePlayer,async c=>c.json(await publishSnapshot({...c.env,PLAYER_SAVES:{put:(...args)=>c.env.PLAYER_SAVES.put(...args),get:async()=>null}},c.get('player').playerId,await c.req.json())));app.onError((e,c)=>c.json({error:e.code||'error',reason:e.reason},e.status||503));export default app;`},bundle:true,format:'esm',platform:'browser',write:false});
 workerScript=result.outputFiles[0].text;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'game-test'},r2Buckets:['PLAYER_SAVES','AUDIT_BLOBS','LEGACY_ARCHIVE'],bindings:{PLAYER_TOKEN_SECRET:'synthetic-only-player-secret-longer-than-32-chars',ALLOW_NEW_ACCOUNTS:'true',LEGACY_MIGRATION_ENABLED:'false'},outboundService:async req=>{requests.push(req.url);throw new Error('PlayFab forbidden for native test');}}));
 db=await mf.getD1Database('DB');for(const file of ['001_auth.sql','002_game.sql'])for(const statement of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 guest=await request('/api/auth/guest',{bootstrapId:'game-guest',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'});
});
after(async()=>await mf?.dispose());
async function request(path,body,method='POST',token=guest?.accessToken){const res=await mf.dispatchFetch(`https://ec1.local${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await res.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed={error:text};}return {status:res.status,...parsed};}
test('complete fresh source fixture saves, restart signin, preserves zeroes and unknown fields with zero PlayFab calls',async()=>{
 assert.equal(keys.length,60);
 const empty=await request('/api/game/save',null,'GET');assert.equal(empty.error,'no_save');assert.equal(empty.saveState,'native_uninitialized');
 const input=snapshot();const saved=await request('/api/game/save',input,'PUT');assert.equal(saved.status,200);assert.equal(saved.saveVersion,1);assert.deepEqual(saved.data,input.data);
 const replay=await request('/api/game/save',input,'PUT');assert.equal(replay.saveVersion,1);
 assert.equal((await request('/api/game/save',{...input,playtime:1},'PUT')).error,'operation_id_reused');
 const linked=await request('/api/auth/link/email',{email:'game-save@fixture.invalid',password:'synthetic-recoverable-password'});
 const login=await request('/api/auth/login',{email:'game-save@fixture.invalid',password:'synthetic-recoverable-password'});
 const loaded=await request('/api/game/save',null,'GET',login.accessToken);assert.deepEqual(loaded.data,input.data);assert.equal(linked.playerId,guest.playerId);assert.equal(requests.length,0);
});
test('reject incomplete/truncated saves and credential prefs; allow explicit intentional empty new game',async()=>{
 const incomplete=snapshot(1,'incomplete-save');delete JSON.parse(incomplete.data.CLOUD_ALL_DATA).inventory;
 const prefs=JSON.parse(incomplete.data.CLOUD_ALL_DATA);delete prefs.inventory;incomplete.data.CLOUD_ALL_DATA=JSON.stringify(prefs);
 assert.equal((await request('/api/game/save',incomplete,'PUT')).error,'incomplete_save');
 prefs.inventory='^^';prefs.PF_PASSWORD='blocked-fixture';incomplete.data.CLOUD_ALL_DATA=JSON.stringify(prefs);
 assert.equal((await request('/api/game/save',incomplete,'PUT')).error,'invalid_save');
 const broken=snapshot(1,'truncated-save');broken.data.CLOUD_ALL_DATA='{"gamedata"';assert.equal((await request('/api/game/save',broken,'PUT')).error,'invalid_save');
 const second=await request('/api/auth/guest',{bootstrapId:'second-save',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'});
 const s=snapshot(0,'new-intent-absent');delete s.intent;
 assert.equal((await request('/api/game/save',s,'PUT',second.accessToken)).error,'new_game_intent_required');
 s.intent='new_game';assert.equal((await request('/api/game/save',s,'PUT',second.accessToken)).status,200);
});
test('stage verification failure publishes no revision, CAS concurrent writers publish only one',async()=>{
 const fail=await request('/test/failed-stage',snapshot(1,'stage-failure',1,10),'PUT');assert.equal(fail.error,'save_stage_verification_failed');
 assert.equal((await request('/api/game/save',null,'GET')).saveVersion,1);
 const a=snapshot(1,'concurrent-one',2,100),b=snapshot(1,'concurrent-two',3,110);
 const race=await Promise.all([request('/api/game/save',a,'PUT'),request('/api/game/save',b,'PUT')]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM save_revision WHERE player_id=?').bind(guest.playerId).first()).n,2);
 assert.equal((await request('/api/game/save',snapshot(2,'time-regression',3,0),'PUT')).error,'playtime_regression');
 assert.equal((await request('/api/game/save',snapshot(2,'high-clock-reset',0,999999),'PUT')).error,'damaged_save_rejected');
});
test('durable mail claims atomic with saves, response replay and concurrent devices grant once; unsupported items stay unclaimed',async()=>{
 await db.prepare('INSERT INTO mail(id,player_id,title,body,rewards_json,created_at) VALUES(?,?,?,?,?,?)').bind('gold-mail',guest.playerId,'Fixture','Synthetic',JSON.stringify([{id:'gold',amount:100}]),Date.now()).run();
 assert.equal((await request('/api/game/inbox',null,'GET')).mail.length,1);
 assert.equal((await request('/api/game/mail/gold-mail/read',{})).read,true);
 const race=await Promise.all([request('/api/game/mail/gold-mail/claim',{expectedSaveVersion:2,operationId:'mail-operation-one'}),request('/api/game/mail/gold-mail/claim',{expectedSaveVersion:2,operationId:'mail-operation-two'})]);
 assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);const lost=race.find(r=>r.status===409),won=race.find(r=>r.status===200);assert.equal(lost.error,'reward_already_claimed');assert.equal(lost.receipt.operationId,won.operationId);assert.equal(lost.latestSaveVersion,3);assert.equal(lost.data,undefined);
 const retry=await request('/api/game/mail/gold-mail/claim',{expectedSaveVersion:2,operationId:won.operationId});assert.equal(retry.saveVersion,3);
 const saved=await request('/api/game/save',null,'GET');assert.equal(JSON.parse(JSON.parse(saved.data.CLOUD_ALL_DATA).gamedata).gold,100);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM grant_receipt WHERE player_id=?').bind(guest.playerId).first()).n,1);
 await db.prepare('INSERT INTO mail(id,player_id,title,body,rewards_json,created_at) VALUES(?,?,?,?,?,?)').bind('bad-mail',guest.playerId,'Fixture','Synthetic',JSON.stringify([{id:'unknown_equipment_without_codec',amount:1}]),Date.now()).run();
 assert.equal((await request('/api/game/mail/bad-mail/claim',{expectedSaveVersion:3,operationId:'unsupported-mail'})).error,'reward_unsupported');
 assert.equal((await db.prepare("SELECT claimed_at FROM mail WHERE id='bad-mail'").first()).claimed_at,null);
});
test('daily elapsed24h claims and coupons publish exact whole-save grants and recover lost acknowledgments',async()=>{
 await db.prepare('INSERT INTO game_config(key,value_json,updated_at) VALUES(?,?,?)').bind('daily_rewards',JSON.stringify({rewards:[[{id:'ruby',amount:10}]]}),Date.now()).run();
 const input={expectedSaveVersion:3,operationId:'daily-operation'};
 assert.equal((await request('/api/game/daily/check',null,'GET')).eligible,true);
 const claim=await request('/api/game/daily/claim',input);assert.equal(claim.saveVersion,4);
 assert.equal((await request('/api/game/daily/claim',input)).saveVersion,4);
 assert.equal((await request('/api/game/daily/claim',{expectedSaveVersion:4,operationId:'different-daily'})).error,'daily_not_ready');
 await db.prepare('INSERT INTO coupon(code,rewards_json,enabled) VALUES(?,?,1)').bind('FIXTURE',JSON.stringify([{id:'costume_alaster_1',amount:1}])).run();
 const coupon={expectedSaveVersion:4,operationId:'coupon-operation',code:'FIXTURE'};
 const redeemed=await request('/api/game/coupon/redeem',coupon);assert.equal(redeemed.saveVersion,5);
 assert.equal((await request('/api/game/coupon/redeem',coupon)).saveVersion,5);
 const prefs=JSON.parse(redeemed.data.CLOUD_ALL_DATA);assert.equal(prefs.costume_alaster_1,'1');assert.deepEqual(JSON.parse(prefs.gamedata).usedCoupons,['FIXTURE']);
});
test('migration ranking rejects reset high separate Playtime, cloud ties win, corrupted sources cannot rank; mutation denylist always fails',async()=>{
 const healthy=snapshot(0,'local-progress',4,100),reset=snapshot(0,'cloud-reset',0,0);reset.playtime=100000;
 assert.equal((await request('/test/winner',{cloud:reset,local:healthy})).winner,'local');
 assert.equal((await request('/test/winner',{cloud:healthy,local:healthy})).winner,'cloud');
 assert.equal((await request('/test/winner',{cloud:reset,local:reset})).error,'migration_recovery_required');
 assert.equal((await request('/test/mutation',{})).error,'legacy_mutation_forbidden');
 assert.equal((await request('/api/game/migration/proof',{sessionTicket:'synthetic-session-ticket'})).error,'migration_disabled');
 assert.equal(requests.length,0);
});
test('intercepted legacy migration proves source/device ownership, archives both, returns committed winner on retry, requires matching native auth completion',async()=>{
 const legacyCalls=[],legacyId='ABCDEF1234',customId='synthetic-legacy-device';
 let cloud=snapshot(0,'legacy-cloud-save',2,50),expired=false,loginId=legacyId;
 cloud.data.EC_MAIL_REWARDS=JSON.stringify([{id:'gold',name:'Gold',amount:50,itemCategory:4},{id:'voids',name:'Void Soul',amount:2,itemCategory:1}]);
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:workerScript,compatibilityDate:'2026-10-06',d1Databases:{DB:'migration-fixture'},r2Buckets:['PLAYER_SAVES','AUDIT_BLOBS','LEGACY_ARCHIVE'],bindings:{PLAYER_TOKEN_SECRET:'synthetic-only-player-secret-longer-than-32-chars',ALLOW_NEW_ACCOUNTS:'true',LEGACY_MIGRATION_ENABLED:'true',PLAYFAB_TITLE_ID:'FIXTURE',PLAYFAB_SECRET_KEY:'synthetic-only-test-secret'},outboundService:async req=>{
   const endpoint=new URL(req.url).pathname.slice(1),body=await req.json();legacyCalls.push(endpoint);
   const allowed=['Server/AuthenticateSessionTicket','Server/GetUserData','Server/GetUserInventory','Server/GetPlayerProfile','Server/GetUserAccountInfo','Client/LoginWithEmailAddress'];assert.ok(allowed.includes(endpoint),`forbidden ${endpoint}`);
   if(endpoint==='Server/AuthenticateSessionTicket') return Response.json({data:{UserInfo:{PlayFabId:legacyId},IsSessionTicketExpired:expired}});
   if(endpoint==='Server/GetUserAccountInfo') return Response.json({data:{UserInfo:{PlayFabId:legacyId,CustomIdInfo:{CustomId:customId},GoogleInfo:{GoogleId:'legacy-google-subject'},PrivateInfo:{Email:'legacy@fixture.invalid'}}}});
   if(endpoint==='Server/GetUserData') return Response.json({data:{Data:Object.fromEntries(Object.entries(cloud.data).map(([k,v])=>[k,{Value:v}]))}});
   if(endpoint==='Server/GetUserInventory') return Response.json({data:{Inventory:[],VirtualCurrency:{}}});
   if(endpoint==='Server/GetPlayerProfile') return Response.json({data:{PlayerProfile:{}}});
   assert.equal(body.CreateAccount,false);return Response.json({code:200,data:{PlayFabId:loginId}});
 }}));
 try {
   const legacyDb=await runtime.getD1Database('DB');for(const file of ['001_auth.sql','002_game.sql'])for(const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await legacyDb.prepare(sql).run();
   const call=async(path,body,token,method='POST')=>{const res=await runtime.dispatchFetch(`https://ec1.local${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,...await res.json()};};
   expired=true;assert.equal((await call('/api/game/migration/proof',{sessionTicket:'synthetic-session-ticket',deviceId:customId})).error,'legacy_proof_invalid');expired=false;
   const proof=await call('/api/game/migration/proof',{sessionTicket:'synthetic-session-ticket',deviceId:customId});assert.equal(proof.playerId,legacyId);
   assert.equal((await call('/api/game/save',snapshot(),proof.accessToken,'PUT')).error,'insufficient_scope');
   const local={...snapshot(0,'legacy-local-save',3,200),deviceId:customId};
   const input={sessionTicket:'synthetic-session-ticket',operationId:'migration-import-operation',localSnapshot:{...local,deviceId:'wrong-device'}};
   assert.equal((await call('/api/game/migration/import',input,proof.accessToken)).error,'local_owner_mismatch');
   const archive=await runtime.getR2Bucket('LEGACY_ARCHIVE');assert.equal((await archive.list()).objects.length,2);
   input.localSnapshot=local;const saved=await call('/api/game/migration/import',input,proof.accessToken);assert.equal(saved.status,200);assert.equal(saved.playtime,200);assert.equal(saved.saveState,'imported_pending_auth');assert.deepEqual(saved.data,local.data);
   assert.equal((await legacyDb.prepare('SELECT COUNT(*) n FROM mail WHERE player_id=?').bind(legacyId).first()).n,1);
   cloud=snapshot(0,'changed-source-save',30,9999);
   const retried=await call('/api/game/migration/import',{...input,localSnapshot:snapshot(0,'changed-local-save',40,10000)},proof.accessToken);assert.deepEqual(retried.data,saved.data);assert.equal(retried.saveVersion,1);
   assert.equal((await call('/api/game/readiness',null,proof.accessToken,'GET')).nativeComplete,false);
   assert.equal((await call('/api/game/migration/complete',{},proof.accessToken)).error,'native_authentication_required');
   loginId='BADBAD1234';assert.equal((await call('/api/auth/link/email',{email:'other@fixture.invalid',password:'synthetic-legacy-password'},proof.accessToken)).error,'legacy_identity_mismatch');loginId=legacyId;
   const linked=await call('/api/auth/link/email',{email:'legacy@fixture.invalid',password:'synthetic-legacy-password'},proof.accessToken);assert.equal(linked.status,200);
   assert.equal((await call('/api/game/migration/complete',{},linked.accessToken)).complete,true);
   assert.equal((await call('/api/game/readiness',null,proof.accessToken,'GET')).status,401);
   assert.equal((await call('/api/game/readiness',null,linked.accessToken,'GET')).nativeComplete,true);
   assert.equal((await legacyDb.prepare('SELECT status,winner FROM migration_record WHERE player_id=?').bind(legacyId).first()).winner,'local');
   assert.ok(legacyCalls.every(x=>!/(Update|Delete|Link|Unlink|Register|Create)/.test(x)));
 } finally {await runtime.dispose();}
});
test('same operation concurrent changed bytes return operation reuse; shipped fresh Unity99 fixture round trips',async()=>{
 const user=await request('/api/auth/guest',{bootstrapId:'operation-race',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'});
 const actual=JSON.parse(await readFile('tests/fixtures/unity-fresh-save.json','utf8'));
 delete actual.deviceId;
 actual.intent='new_game';
 const first=await request('/api/game/save',actual,'PUT',user.accessToken);assert.equal(first.status,200);assert.deepEqual(first.data,actual.data);
 const a=snapshot(1,'identical-operation-race',2,100),b=snapshot(1,'identical-operation-race',3,101);
 const race=await Promise.all([request('/api/game/save',a,'PUT',user.accessToken),request('/api/game/save',b,'PUT',user.accessToken)]);
 assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal(race.find(r=>r.status===409).error,'operation_id_reused');
});
test('canonical shipped material/consume grant uses existing quantities, ignores asset sample counts, preserves unknown fields and rejects overflow without claim',async()=>{
 const user=await request('/api/auth/guest',{bootstrapId:'inventory-grants',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'});
 assert.equal((await request('/api/game/save',snapshot(0,'inventory-initial'),'PUT',user.accessToken)).status,200);
 const rewards=[{id:'apple',amount:1,itemCategory:2},{id:'medred',amount:3,itemCategory:2},{id:'voids',amount:2,itemCategory:1}];
 await db.prepare('INSERT INTO mail(id,player_id,title,body,rewards_json,created_at) VALUES(?,?,?,?,?,?)').bind('inventory-mail',user.playerId,'Fixture','Synthetic',JSON.stringify(rewards),Date.now()).run();
 const claimed=await request('/api/game/mail/inventory-mail/claim',{expectedSaveVersion:1,operationId:'inventory-claim'},'POST',user.accessToken);assert.equal(claimed.status,200);
 const prefs=JSON.parse(claimed.data.CLOUD_ALL_DATA),groups=prefs.inventory.split('^').map(g=>g.split('|').filter(Boolean).map(JSON.parse));
 assert.equal(groups[1][0].id,'voids');assert.equal(groups[1][0].amount,2);assert.equal(groups[2].find(i=>i.id==='apple').amount,1);assert.equal(groups[2].find(i=>i.id==='medred').amount,3);assert.equal(prefs.future_field,'zero-preserved');
 await db.prepare('INSERT INTO mail(id,player_id,title,body,rewards_json,created_at) VALUES(?,?,?,?,?,?)').bind('overflow-mail',user.playerId,'Fixture','Synthetic',JSON.stringify([{id:'apple',amount:999,itemCategory:2}]),Date.now()).run();
 assert.equal((await request('/api/game/mail/overflow-mail/claim',{expectedSaveVersion:2,operationId:'overflow-item'},'POST',user.accessToken)).error,'reward_stack_overflow');
 assert.equal((await db.prepare("SELECT claimed_at FROM mail WHERE id='overflow-mail'").first()).claimed_at,null);
 assert.equal((await request('/api/game/save',null,'GET',user.accessToken)).saveVersion,2);
});
test('Fortress leaderboard attests versioned record and display name; arbitrary scoreboard writes and active banned entries are excluded',async()=>{
 const user=await request('/api/auth/guest',{bootstrapId:'leaderboard-guest',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'}),s=snapshot(0,'fortress-save',3,100);
 const prefs=JSON.parse(s.data.CLOUD_ALL_DATA),gd=JSON.parse(prefs.gamedata);gd.fortress_edna={character:1,floor:10,cleartime:123};prefs.gamedata=JSON.stringify(gd);s.data.CLOUD_ALL_DATA=JSON.stringify(prefs);
 assert.equal((await request('/api/game/save',s,'PUT',user.accessToken)).status,200);
 assert.equal((await request('/api/game/profile',{displayName:'Fixture Hero'},'PUT',user.accessToken)).displayName,'Fixture Hero');
 assert.equal((await request('/api/game/profile',{displayName:'<color>fake</color>'},'PUT',user.accessToken)).error,'invalid_display_name');
 const board=await request('/api/game/leaderboard',null,'GET',user.accessToken);assert.equal(board.me.score,10_000_000-1230+1);assert.equal(board.me.saveVersion,1);assert.equal(board.me.playerName,'Fixture Hero');assert.equal(board.me.rank,1);
 assert.equal((await request('/api/game/leaderboard',{score:2_147_483_647},'POST',user.accessToken)).status,404);
 await db.prepare('INSERT INTO player_ban(player_id,reason,created_at) VALUES(?,?,?)').bind(user.playerId,'Synthetic fixture ban',Math.floor(Date.now()/1000)).run();
 const filtered=await request('/api/game/leaderboard',null,'GET');assert.ok(filtered.entries.every(e=>e.playerId!==user.playerId));
 assert.equal((await request('/api/game/save',null,'GET',user.accessToken)).error,'player_banned');
});
