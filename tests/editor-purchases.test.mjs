import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
const secret='synthetic-editor-test-only';
const op=s=>createHash('sha256').update(s).digest('hex');
let mf,db;
function token(id,scope='player') {
 const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const a=b({alg:'HS256',typ:'JWT'}),p=b({iss:'ec1-backend',aud:'ec1-player',sub:id,sid:'session-'+id+'-'+scope,provider:'email',scope,deviceId:null,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+900});
 return a+'.'+p+'.'+createHmac('sha256',secret).update(a+'.'+p).digest('base64url');
}
async function req(path,body,owner='tester',scope='player') {
 const r=await mf.dispatchFetch('https://isolated.test/api/purchases'+path,{method:'POST',headers:{'Content-Type':'application/json',...(owner?{Authorization:'Bearer '+token(owner,scope)}:{})},body:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
const body=(name='premium',operation='purchase-1')=>({protocol:'ec1-grants-v1',platform:'google',productId:name,operationId:op(operation),mode:'test',test:true});
before(async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createPurchasesApp} from './src/purchases';const app=new Hono();app.route('/api/purchases',createPurchasesApp());export default app;`},bundle:true,write:false,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'isolated-editor-purchases'},r2Buckets:['PLAYER_SAVES','AUDIT_BLOBS','LEGACY_ARCHIVE'],bindings:{PLAYER_TOKEN_SECRET:secret,IAP_EDITOR_TEST_ENABLED:'true',IAP_EDITOR_TEST_PLAYERS:'tester'},outboundService:()=>{throw Error('No outbound calls allowed')}}));
 db=await mf.getD1Database('DB');
 for(const f of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+f,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 for(const id of ['tester','other']){
  await db.prepare("INSERT INTO player(id,display_name,save_version,playtime,save_state,created_at,updated_at) VALUES(?,?,0,0,'native_uninitialized',?,?)").bind(id,id,Date.now(),Date.now()).run();
  for(const scope of ['player','migration'])await db.prepare('INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind('session-'+id+'-'+scope,id,'email',scope,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)+3600).run();
 }
});
after(async()=>mf?.dispose());
test('only the configured player with a real player session can issue test grants',async()=>{
 assert.equal((await req('/editor-test',body(),null)).status,401);
 assert.equal((await req('/editor-test',body(),'other')).status,403);
 assert.equal((await req('/editor-test',body(),'tester','migration')).status,403);
 const r=await req('/editor-test',body());assert.equal(r.status,200,JSON.stringify(r));
 assert.equal(r.body.environment,'test');assert.equal(r.body.verificationSource,'unity_editor');assert.equal(r.body.entitlements.premium,1);
 assert.equal(r.body.purchaseKey,'editor:'+op('tester/'+op('purchase-1')));
 const ledger=await db.prepare('SELECT environment,verification_source,status FROM purchase_ledger WHERE purchase_key=?').bind(r.body.purchaseKey).first();
 assert.deepEqual(ledger,{environment:'test',verification_source:'unity_editor',status:'verified_pending'});
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM save_revision').first()).n,0);
 assert.equal((await db.prepare('SELECT save_version FROM player WHERE id=?').bind('tester').first()).save_version,0);
});
test('retries and concurrent requests preserve one immutable server-defined grant',async()=>{
 const [a,b]=await Promise.all([req('/editor-test',body('ruby1','race')),req('/editor-test',body('ruby1','race'))]);
 assert.equal(a.status,200);assert.deepEqual(a,b);assert.equal(a.body.rewards[0].amount,9);
 assert.equal((await req('/editor-test',body('ruby2','race'))).status,409);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM purchase_editor_grant WHERE player_id=? AND operation_id=?').bind('tester',op('race')).first()).n,1);
});
test('client cannot supply rewards, spoof production or buy retired products',async()=>{
 for(const patch of [{rewards:[{id:'ruby',amount:999}]},{environment:'production'},{test:false},{platform:'editor'},{productId:'starter'},{productId:'xmas_pack'},{productId:'wyvern_red_alaster'}])assert.equal((await req('/editor-test',{...body(),...patch})).status,400);
});
test('hero and booster catalog grants are marked test and ack is player-bound and repeatable',async()=>{
 for(const [sku,flags] of [['archer',['louisaUnlock']],['souru',['soulUnlock']],['booster_pack',['more_exp','double_loot','dualTaken']]]){
  const b=body(sku,sku), r=await req('/editor-test',b);assert.equal(r.status,200,JSON.stringify(r));
  for(const flag of flags)assert.equal(r.body.entitlements[flag],1);
  const path='/editor-test/'+r.body.grantId+'/ack';
  assert.equal((await req(path,{operationId:b.operationId},'other')).status,404);
  assert.equal((await req(path,{operationId:op('wrong')})).status,404);
  const ack=await req(path,{operationId:b.operationId});assert.equal(ack.status,200);assert.deepEqual(ack,await req(path,{operationId:b.operationId}));
  assert.equal((await db.prepare('SELECT status FROM purchase_ledger WHERE purchase_key=?').bind(r.body.purchaseKey).first()).status,'granted');
 }
});
