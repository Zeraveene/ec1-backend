import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin='https://admin.test';
let mf,db,central;
const legacyCalls=[];
before(async()=>{
  const built=await build({stdin:{resolveDir:process.cwd(),contents:`
    import worker from './src/index';
    import {publishSnapshot} from './src/game/storage';
    import {nativeKeys} from './src/game/validation';
    export default {async fetch(request,env,ctx){
      const path=new URL(request.url).pathname;
      if(path==='/fixture/keys')return Response.json(nativeKeys);
      if(path==='/fixture/publish'){const b=await request.json();return Response.json(await publishSnapshot(env,b.id,b.snapshot));}
      return worker.fetch(request,env,ctx);
    }};`},bundle:true,format:'esm',write:false,platform:'browser',external:['cloudflare:workers']});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[
    {name:'classic',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-06',
      d1Databases:{DB:'control-classic'},r2Buckets:['PLAYER_SAVES','AUDIT_BLOBS','LEGACY_ARCHIVE'],
      bindings:{PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic-legacy-secret',CLASSIC_ADMIN_ORIGIN:origin,ENVIRONMENT:'synthetic',PLAYER_TOKEN_SECRET:'synthetic-player-secret-longer-than-32-characters',ADMIN_SESSION_SECRET:'synthetic-admin-secret-longer-than-32-characters'},
      serviceBindings:{EC2_ADMIN_SESSION:'central'},outboundService:async request=>{
        assert.match(request.url,/^https:\/\/SYNTHETIC.playfabapi.com\/(Admin\/GetUserAccountInfo|Server\/GetUserData)$/i);
        assert.equal(request.method,'POST');legacyCalls.push({url:request.url,body:await request.json()});
        return Response.json({data:request.url.endsWith('GetUserAccountInfo')?{UserInfo:{PlayFabId:'ABCDEF1234567890',Username:'Fixture'}}:{Data:{CLOUD_ALL_DATA:{Value:JSON.stringify({gamedata:JSON.stringify({gold:5,ruby:0})})},Playtime:{Value:'60'}}}});
      }},
    {name:'central',modules:true,compatibilityDate:'2026-10-06',d1Databases:{DB:'control-authority'},script:`
      export default {async fetch(req,env){
        if(req.url!=='${origin}/api/me'||req.method!=='GET'||req.headers.get('Cookie')!=='ec2mod_session=fixture'||req.headers.has('Authorization')||req.headers.has('X-Admin-Id'))return Response.json({error:'unauthenticated'},{status:401});
        const row=await env.DB.prepare('SELECT mode FROM state').first();
        if(row.mode==='outage')return Response.json({error:'unavailable'},{status:503});
        if(row.mode==='unauthorized')return Response.json({error:'unauthenticated'},{status:401});
        if(row.mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://attacker.invalid'}});
        if(row.mode==='malformed')return Response.json({discordId:'111111111111111111',username:'Test',role:'root'});
        return Response.json({discordId:'111111111111111111',username:'Test admin',globalName:'Synthetic admin',role:row.mode});
      }};`,outboundService:()=>{throw Error('External requests forbidden');}},
  ]}));
  db=await mf.getD1Database('DB','classic');central=await mf.getD1Database('DB','central');
  await central.exec("CREATE TABLE state(mode TEXT); INSERT INTO state VALUES('internal');");
  for(const file of ['001_auth.sql','002_game.sql','003_admin.sql','010_recovery.sql','020_purchases.sql','021_device_credentials.sql','022_admin_identity.sql'])
    for(const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const id of ['source','destination'])await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES(?,0,0)').bind(id).run();
  await db.prepare("INSERT INTO auth_identity VALUES('email','source@example.invalid','source','old-hash','old-salt',1)").run();
  await db.prepare("INSERT INTO auth_identity VALUES('google','source-google','source',NULL,NULL,1)").run();
  await db.prepare("INSERT INTO auth_identity VALUES('email','destination@example.invalid','destination','old-hash','old-salt',1)").run();
  const keys=await (await mf.dispatchFetch(origin+'/fixture/keys')).json();
  const data=Object.fromEntries(keys.map(k=>[k,'0']));
  Object.assign(data,{alaster_attributes:await readFile('tests/fixtures/alasterbase.json','utf8'),edna_attributes:await readFile('tests/fixtures/ednabase.json','utf8'),louisa_attributes:'',soul_attributes:'',inventory:'^^',consumable:'',achievements_new:Array(27).fill('0').join('|'),selected:'alaster'});
  for(const [version,time] of [[0,10],[1,20]]) {
    const snapshot={game:'ec1',schemaVersion:1,playtime:time,expectedSaveVersion:version,operationId:'fixture_publish_'+version,data:{CLOUD_ALL_DATA:JSON.stringify({...data,gamedata:JSON.stringify({gold:time,ruby:0,stageProgress:1,tutorialProgress:1,timeCounter:time,usedCoupons:[],stageInfo:[]})}),Playtime:String(time)}};
    const response=await mf.dispatchFetch(origin+'/fixture/publish',{method:'POST',body:JSON.stringify({id:'destination',snapshot})});
    assert.equal(response.status,200,await response.text());
  }
});
after(async()=>mf?.dispose());
async function mode(value){await central.prepare('UPDATE state SET mode=?').bind(value).run();}
async function request(path,{method='GET',body,headers={},host=origin,cookie='ec2mod_session=fixture; ec1_admin=NOT_FORWARDED'}={}){
  const response=await mf.dispatchFetch(host+'/api/classic-admin'+path,{method,headers:{Cookie:cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};
}
test('central session and current role are required; caller identity is ignored',async()=>{
  assert.equal((await request('/capabilities',{cookie:'',headers:{'X-Admin-Id':'111111111111111111','X-Admin-Role':'internal'}})).status,401);
  assert.equal((await request('/capabilities',{cookie:'ec2mod_session=invalid'})).status,401);
  const allowed=await request('/capabilities',{headers:{Authorization:'attacker','X-Admin-Id':'attacker'}});
  assert.equal(allowed.status,200);assert.equal(allowed.body.canWrite,true);assert.equal(allowed.cache,'no-store');
  assert.equal((await request('/capabilities',{host:'https://ec1.test'})).status,403);
  for(const value of ['outage','redirect','malformed']){await mode(value);assert.equal((await request('/capabilities')).status,503);}
  await mode('unauthorized');assert.equal((await request('/capabilities')).status,401);await mode('internal');
});
test('origin, JSON, size and current role protect every action',async()=>{
  const path='/players/source/identities/password/reset';
  const body={password:'new-password-long',expectedSubject:'source@example.invalid',operationId:'origin_operation'};
  assert.equal((await request(path,{method:'POST',body,headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await request(path,{method:'POST',body,headers:{Origin:''}})).status,403);
  assert.equal((await request(path,{method:'POST',body,headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await request(path,{method:'POST',body:'x'.repeat(40000)})).status,413);
  assert.equal((await request(path,{method:'POST',body:'{bad'})).status,400);
  for(const role of ['manager','guest']){
    await mode(role);assert.equal((await request('/capabilities')).body.canWrite,false);
    assert.equal((await request('/players/destination/revisions')).status,200);
    assert.equal((await request('/players/destination/revisions/1')).status,403);
    assert.equal((await request(path,{method:'POST',body,headers:{'X-Admin-Role':'internal'}})).status,403);
  }
  await mode('internal');
});
test('identity controls use Classic storage and preserve exact operation retries',async()=>{
  const identities=await request('/players/source/identities');assert.equal(identities.status,200);
  assert.ok(identities.body.identities.some(i=>i.provider==='password'));
  assert.equal(JSON.stringify(identities.body).includes('old-hash'),false);
  const path='/players/source/identities/password/reset';
  const body={password:'private-new-password',expectedSubject:'source@example.invalid',operationId:'reset_operation'};
  const reset=await request(path,{method:'POST',body});assert.equal(reset.status,200,JSON.stringify(reset));
  assert.deepEqual((await request(path,{method:'POST',body})).body,reset.body);
  assert.equal(JSON.stringify(reset.body).includes(body.password),false);
  const preview=await request('/players/destination/identities/google/move/preview',{method:'POST',body:{sourceId:'source'}});
  assert.equal(preview.status,200,JSON.stringify(preview));
  const moved=await request('/players/destination/identities/google/move',{method:'POST',body:{sourceId:'source',reviewSha256:preview.body.reviewSha256,operationId:'move_operation'}});
  assert.equal(moved.status,200,JSON.stringify(moved));
  assert.equal((await db.prepare("SELECT player_id FROM auth_identity WHERE provider='google' AND subject='source-google'").first()).player_id,'destination');
  assert.equal((await db.prepare("SELECT save_version FROM player WHERE id='destination'").first()).save_version,2);
});
test('revision preview/download and confirmed restore work through the direct EC1 route',async()=>{
  const list=await request('/players/destination/revisions');assert.deepEqual(list.body.revisions.map(r=>r.version),[2,1]);
  const source=await request('/players/destination/revisions/1');assert.equal(source.status,200);assert.ok(source.body.download.content);
  const path='/players/destination/revisions/1';
  const preview=await request(path+'/preview',{method:'POST',body:{}});assert.equal(preview.status,200);assert.equal(preview.body.warning,true);
  const body={expectedSaveVersion:preview.body.currentVersion,reviewSha256:preview.body.reviewSha256,operationId:'restore_operation'};
  const restored=await request(path+'/restore',{method:'POST',body});assert.equal(restored.status,200,JSON.stringify(restored));assert.equal(restored.body.saveVersion,3);
  assert.deepEqual((await request(path+'/restore',{method:'POST',body})).body,restored.body);
  assert.deepEqual((await request('/players/destination/revisions/3')).body.snapshot.data,source.body.snapshot.data);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='save.restore'").first()).n,1);
});

test('direct workspace reads use current central session without RPC, redact storage and scope cursors',async()=>{
  for(const path of ['/status','/players','/players/source','/audit']) {
    assert.equal((await request(path,{cookie:'',headers:{'X-Admin-Id':'111111111111111111','X-Admin-Role':'internal'}})).status,401);
    await mode('unauthorized');assert.equal((await request(path)).status,401);
    await mode('malformed');assert.equal((await request(path)).status,503);
  }
  await mode('internal');
  for(let i=0;i<103;i++)await db.prepare('INSERT INTO player(id,display_name,created_at,updated_at,device_id) VALUES(?,?,1,50,?)').bind(`readfixture${String(i).padStart(3,'0')}`,'Read synthetic','private-device').run();
  await db.prepare("INSERT INTO admin_audit VALUES ('read-audit','111','Admin','synthetic','source','private-audit-detail',10)").run();
  for(const role of ['internal','manager','guest']) {
    await mode(role);
    const status=await request('/status');assert.equal(status.status,200);assert.equal(status.body.game,'ec1');assert.equal(status.body.manualBackupsEnabled,false);assert.equal(status.cache,'no-store');
    const first=await request('/players?query=readfixture');assert.equal(first.status,200);assert.equal(first.body.players.length,100);assert.ok(first.body.nextCursor);
    const second=await request('/players?query=readfixture&cursor='+first.body.nextCursor);assert.equal(second.body.players.length,3);
    assert.equal(new Set([...first.body.players,...second.body.players].map(p=>p.id)).size,103);
    assert.equal((await request('/players?query=other&cursor='+first.body.nextCursor)).status,400);
    assert.equal((await request('/audit?cursor='+first.body.nextCursor)).status,400);
    assert.equal((await request('/players?cursor=broken')).status,400);
    assert.equal((await request('/players?query='+('x'.repeat(101)))).status,400);
    const detail=await request('/players/source');assert.equal(detail.status,200);assert.ok(detail.body.player);assert.ok(detail.body.canonicalBackups);
    assert.doesNotMatch(JSON.stringify(detail.body),/password_hash|old-hash|old-salt|device_id|r2_key/);
    assert.doesNotMatch(JSON.stringify(first.body),/device_id|private-device/);
    const audit=await request('/audit');assert.equal(audit.status,200);assert.doesNotMatch(JSON.stringify(audit.body),/detail_json|private-audit-detail/);
    assert.equal((await request('/players/missing')).status,404);
  }
  await mode('unauthorized');assert.equal((await request('/status')).status,401);
  await mode('outage');assert.equal((await request('/players')).status,503);
  await mode('internal');
});

test('direct legacy viewer is authenticated, audited, immutable and independent from migration',async()=>{
  legacyCalls.length=0;
  assert.equal((await request('/legacy?query=Fixture',{cookie:''})).status,401);
  assert.equal(legacyCalls.length,0);
  for(const role of ['guest','manager','internal']) {
    await mode(role);
    const found=await request('/legacy?query=Fixture');assert.equal(found.status,200);assert.equal(found.body.results[0].id,'ABCDEF1234567890');assert.equal(found.cache,'no-store');
    const detail=await request('/legacy/ABCDEF1234567890');assert.equal(detail.status,200);assert.equal(detail.body.account.gold,5);assert.equal(detail.body.account.ruby,0);
  }
  const audit=await db.prepare("SELECT actor_id,actor_name,action,player_id,detail_json FROM admin_audit WHERE action LIKE 'legacy-%'").all();
  assert.equal(audit.results.length,6);assert.ok(audit.results.every(row=>row.actor_id==='111111111111111111'&&row.actor_name==='Synthetic admin'&&row.detail_json==='{}'));
  const count=legacyCalls.length;
  assert.equal((await request('/legacy?query=')).status,400);assert.equal((await request('/legacy/EC1X_new')).status,400);
  await mode('unauthorized');assert.equal((await request('/legacy/ABCDEF1234567890')).status,401);assert.equal(legacyCalls.length,count);
  await mode('internal');assert.equal((await request('/legacy/ABCDEF1234567890',{method:'POST',body:{}})).status,404);
});
