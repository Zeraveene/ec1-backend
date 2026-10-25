import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf,db,archives,saves,mode='ok',calls=0;
const id='ABCDEF1234567890',other='ABCDEF1234567891',origin='https://admin.test';
const equipment=i=>({id:'same-sword',m_name:'Fixture Sword',type:0,rarity:1,enhanceLevel:i,unknownRoll:{marker:i}});
const item=(id,amount)=>({id,amount,unknown:{preserve:true}});
const inventory=[JSON.stringify(equipment(1))+'|'+JSON.stringify(equipment(2)),JSON.stringify(item('ironbar',10))+'|'+JSON.stringify(item('cloth',2)),JSON.stringify(item('apple',5))].join('^');
let payload=JSON.stringify({gamedata:JSON.stringify({gold:10,ruby:20,stageProgress:3,timeCounter:50,unknownProgress:{keep:true}}),inventory,unknownPreference:'keep-me'});
before(async()=>{
 const bundled=await build({stdin:{contents:`export {default} from './src/index';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'classic',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'legacy-edit'},r2Buckets:['PLAYER_SAVES','LEGACY_ARCHIVE'],bindings:{CLASSIC_ADMIN_ORIGIN:origin,PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic-secret'},serviceBindings:{EC2_ADMIN_SESSION:'central'},outboundService:async req=>{
   calls++;assert.match(req.url,/^https:\/\/synthetic.playfabapi.com\/(Admin\/GetUserAccountInfo|Server\/GetUserData)$/i);assert.equal(req.method,'POST');const b=await req.json();
   if(mode==='outage')return Response.json({error:'ServiceUnavailable'},{status:503});
   return Response.json({data:req.url.endsWith('GetUserAccountInfo')?{UserInfo:{PlayFabId:b.PlayFabId,Username:'fixture'}}:{Data:{CLOUD_ALL_DATA:{Value:payload},Playtime:{Value:'50'}}}});
  }},
  {name:'central',modules:true,compatibilityDate:'2026-10-06',script:`export default {fetch(req){const cookie=req.headers.get('Cookie');if(!cookie)return Response.json({error:'unauthenticated'},{status:401});return Response.json({discordId:cookie.includes('second')?'222222222222222222':'111111111111111111',username:'Synthetic admin',role:cookie.includes('guest')?'guest':cookie.includes('manager')?'manager':'internal'});}};`},
 ]}));db=await mf.getD1Database('DB','classic');archives=await mf.getR2Bucket('LEGACY_ARCHIVE','classic');saves=await mf.getR2Bucket('PLAYER_SAVES','classic');
 for(const file of ['001_auth.sql','002_game.sql','003_admin.sql','025_legacy_admin_revisions.sql'])for(const sql of (await readFile('migrations/'+file,'utf8')).split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
});
after(async()=>mf?.dispose());
async function req(path,body,cookie='internal') {const response=await mf.dispatchFetch(origin+'/api/classic-admin/legacy/'+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:'ec2mod_session='+cookie}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
async function editor(player=id){const r=await req(player+'/editor');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
const body=(review,patch,operationId=crypto.randomUUID())=>({...review.edit,patch,operationId});
let firstRequest;
test('only current internal sessions edit; captures full source before editing without creating player accounts',async()=>{
 const count=calls;assert.equal((await req(id+'/editor',undefined,'')).status,401);
 for(const role of ['guest','manager']){assert.equal((await req(id+'/editor',undefined,role)).status,403);assert.equal((await req(id+'/revisions',{},role)).status,403);}assert.equal(calls,count);
 const review=await editor();assert.equal(review.edit.expectedRevision,0);const raw=await archives.get(`ec1/admin-edit/${id}/${review.edit.reviewId}.json`);assert.ok(raw);assert.equal(JSON.parse(await raw.text()).source.data.CLOUD_ALL_DATA,payload);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM player').first()).n,0);
 firstRequest=body(review,{account:{gold:99,ruby:7,stageProgress:8},amounts:[{category:'materials',index:0,amount:25}],removals:[{category:'equipment',index:0},{category:'consumables',index:0}]});
 assert.equal((await req(id+'/revisions',firstRequest,'second')).status,403);
 const saved=await req(id+'/revisions',firstRequest);assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
 const row=await db.prepare('SELECT * FROM legacy_admin_revision WHERE player_id=?').bind(id).first();const stored=JSON.parse(await (await saves.get(row.r2_key)).text());const prefs=JSON.parse(stored.data.CLOUD_ALL_DATA);
 assert.equal(prefs.unknownPreference,'keep-me');assert.equal(JSON.parse(prefs.gamedata).unknownProgress.keep,true);assert.equal(prefs.inventory.split('^')[0],JSON.stringify(equipment(2)));assert.equal(JSON.parse(prefs.inventory.split('^')[1].split('|')[0]).unknown.preserve,true);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM player').first()).n,0);
 const before=calls,view=await req(id);assert.equal(view.body.source,'backend_revision');assert.equal(view.body.revision,1);assert.equal(view.body.account.gold,99);assert.equal(view.body.inventory.materials[0].amount,25);assert.equal(view.body.inventory.equipment.length,1);assert.deepEqual(view.body.inventory.consumables,[]);assert.equal(calls,before);
});
test('append-only history, operation replay after newer head, invalid patches and simultaneous saves',async()=>{
 const review=await editor();assert.equal(review.edit.expectedRevision,1);
 for(const patch of [{account:{ruby:-1}},{account:{ruby:1.5}},{account:{ruby:2147483648}},{account:{password:3}},{amounts:[{category:'equipment',index:0,amount:3}]},{removals:[{category:'materials',index:999}]},{amounts:[{category:'materials',index:0,amount:2}],removals:[{category:'materials',index:0}]}])assert.equal((await req(id+'/revisions',body(review,patch))).status,400);
 const a=body(review,{account:{ruby:9}}),b=body(review,{account:{ruby:11}}),race=await Promise.all([req(id+'/revisions',a),req(id+'/revisions',b)]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
 assert.equal((await req(id+'/revisions',firstRequest)).body.revision,1);
 assert.equal((await req(id+'/revisions',{...firstRequest,patch:{account:{gold:101}}})).status,409);
 const history=await db.prepare('SELECT revision FROM legacy_admin_revision ORDER BY revision').all();assert.deepEqual(history.results.map(r=>r.revision),[1,2]);
 const audits=await db.prepare("SELECT count(*) AS n FROM admin_audit WHERE action='legacy.save_edit'").first();assert.equal(audits.n,2);
});
test('changed live source and provider outages cannot be saved or mistaken for absence',async()=>{
 const review=await editor(other);const request=body(review,{account:{gold:12}});
 const original=payload;payload=JSON.stringify({...JSON.parse(payload),changed:'later live save'});assert.equal((await req(other+'/revisions',request)).status,409);payload=original;
 mode='outage';assert.equal((await req(other+'/revisions',request)).status,503);mode='ok';
 assert.equal((await db.prepare('SELECT count(*) AS n FROM legacy_admin_revision WHERE player_id=?').bind(other).first()).n,0);
});
test('failed publication rolls back history, head and audit while retaining the archived original',async()=>{
 const review=await editor();await db.prepare("CREATE TRIGGER fail_edit_audit BEFORE INSERT ON admin_audit WHEN NEW.action='legacy.save_edit' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").run();
 const failed=await req(id+'/revisions',body(review,{account:{gold:200}}));assert.equal(failed.status,503);assert.equal((await db.prepare('SELECT revision FROM legacy_admin_head WHERE player_id=?').bind(id).first()).revision,2);assert.equal((await db.prepare('SELECT count(*) AS n FROM legacy_admin_revision').first()).n,2);
 assert.ok(await archives.get(`ec1/admin-edit/${id}/${review.edit.reviewId}.json`));
 await db.prepare('DROP TRIGGER fail_edit_audit').run();
});
