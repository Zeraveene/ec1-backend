import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf,db,central;
const origin='https://classic-admin.test';
before(async()=>{
 const built=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'classic',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'integration-classic'},bindings:{CLASSIC_ADMIN_ORIGIN:origin},serviceBindings:{EC2_ADMIN_SESSION:'central'},outboundService:()=>{throw Error('No network allowed');}},{name:'central',modules:true,compatibilityDate:'2026-10-06',d1Databases:{DB:'integration-central'},script:`export default {async fetch(req,env){if(req.headers.get('Cookie')!=='ec2mod_session=synthetic')return Response.json({error:'unauthenticated'},{status:401});const row=await env.DB.prepare('SELECT role FROM state').first();if(row.role==='removed')return Response.json({}, {status:401});return Response.json({discordId:'111111111111111111',username:'Synthetic',role:row.role});}};`}]}));
 db=await mf.getD1Database('DB','classic');central=await mf.getD1Database('DB','central');await central.exec("CREATE TABLE state(role TEXT); INSERT INTO state VALUES('manager');");
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 await db.prepare("INSERT INTO player(id,created_at,updated_at) VALUES('recipient',1,1)").run();
});
after(async()=>mf?.dispose());
async function req(path,body,headers={}) {const response=await mf.dispatchFetch(origin+'/api/classic-admin'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'ec2mod_session=synthetic',...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
const read=(feature,action,args={})=>req(`/liveops/${feature}/${action}?${new URLSearchParams({args:JSON.stringify(args)})}`);
const write=(feature,action,args)=>req(`/liveops/${feature}/${action}`,args);
test('direct admin transport authenticates, separates reads/writes and uses Classic catalog',async()=>{
 assert.equal((await req('/liveops/catalog',undefined,{Cookie:''})).status,401);
 const catalog=await req('/liveops/catalog');assert.equal(catalog.status,200);assert.equal(catalog.body.game,'ec1');assert.ok(catalog.body.items.some(i=>i.id==='gold'));assert.ok(catalog.body.items.some(i=>i.id==='apple'&&i.itemCategory===2));
 for(const id of ['louisaUnlock','soulUnlock','premium','more_exp','double_loot','booster_pack'])assert.ok(catalog.body.items.some(i=>i.id===id&&i.maxAmount===1&&i.name&&i.itemCategory===undefined));
 assert.equal((await read('mail','send')).status,404);
 assert.equal((await write('coupons','list',{})).status,404);
 assert.equal((await read('__proto__','list')).status,404);
 assert.equal((await req('/liveops/coupons/list?args=not-json')).status,400);
 assert.equal((await req('/liveops/mail/send',{}, {Origin:'https://evil.invalid'})).status,403);
 assert.equal((await write('news','create',{padding:'x'.repeat(270000)})).status,413);
 assert.equal((await req('/capabilities')).body.canWrite,false);assert.equal((await req('/capabilities')).body.canManageLiveOps,true);
});
test('manager creates all feature records over mounted routes; guest cannot mutate',async()=>{
 const coupon=await write('coupons','create',{operationId:'coupon-create',code:'INTEGRATION',title:'Synthetic',rewards:[{id:'gold',amount:2}],enabled:true});assert.equal(coupon.status,201,JSON.stringify(coupon));
 assert.equal((await read('coupons','list')).body.coupons.length,1);
 const args={operationId:'mail-create',playerId:'recipient',title:'Synthetic mail',body:'For integration',rewards:[{id:'apple',amount:1}]};
 const mail=await write('mail','send',args);assert.equal(mail.status,201,JSON.stringify(mail));assert.deepEqual(await write('mail','send',args),mail);assert.equal((await read('mail','history',{playerId:'recipient'})).body.mail.length,1);
 const news=await write('news','create',{operationId:'news-create',post:{id:'integration',titles:{en:'Synthetic'},bodies:{en:'Plain text'},publishAt:null,expireAt:null,pinned:false,draft:false,order:0,rewards:[]}});assert.equal(news.status,201,JSON.stringify(news));
 const publicNews=await mf.dispatchFetch('https://player.test/api/liveops/news');assert.equal(publicNews.status,200);assert.equal((await publicNews.json()).news[0].id,'integration');
 const board=await read('leaderboards','status');assert.equal(board.status,200);assert.equal(board.body.submissionPaused,true);
 assert.equal((await read('leaderboards','top')).status,200);
 await central.prepare("UPDATE state SET role='guest'").run();
 assert.equal((await req('/capabilities')).body.canManageLiveOps,false);
 for(const [feature,action,args] of [['mail','send',{operationId:'guest-mail',playerId:'recipient',title:'No'}],['coupons','disable',{}],['news','archive',{}],['leaderboards','pause',{}]])assert.equal((await write(feature,action,args)).status,403);
 for(const [feature,action,args] of [['mail','history',{playerId:'recipient'}],['coupons','list',{}],['news','list',{}],['leaderboards','status',{}]])assert.equal((await read(feature,action,args)).status,200);
 await central.prepare("UPDATE state SET role='removed'").run();assert.equal((await read('news','list')).status,401);
 assert.equal((await db.prepare('SELECT save_version FROM player WHERE id=?').bind('recipient').first()).save_version,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM save_revision').first()).n,0);
 for(const path of ['/api/liveops/mail','/api/liveops/grants','/api/liveops/coupons/check'])assert.equal((await mf.dispatchFetch('https://player.test'+path,{method:path.endsWith('check')?'POST':'GET'})).status,401);
});

test('Classic purchase dashboard requires current internal role and exposes only safe EC1 projections',async()=>{
 for(const role of ['guest','manager']) {
  await central.prepare('UPDATE state SET role=?').bind(role).run();
  for(const path of ['/purchases','/purchases/catalog','/purchases/p_1'])assert.equal((await req(path)).status,403);
 }
 await central.prepare("UPDATE state SET role='internal'").run();
 const catalog=await req('/purchases/catalog');assert.equal(catalog.status,200);assert.equal(catalog.body.game,'ec1');
 const products=catalog.body.products;assert.equal(products.find(p=>p.platform==='google'&&p.productId==='ruby1').rewards[0].amount,9);
 assert.equal(products.find(p=>p.platform==='apple'&&p.productId==='iap_archer').name,'Unlock Louisa');
 assert.equal(products.some(p=>p.productId==='date_pack_a'),false);
 const time=Date.now();
 await db.prepare('INSERT INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind('google:private-ledger-key','google','private-google-token-hash','recipient','ruby1','private-receipt-hash',1,'production','google_api',JSON.stringify({environment:'production',quantity:1,purchaseTime:time,orderId:'GPA.1234-1234-1234-12345',accountBinding:'private-account-binding',amountMicros:99999999}), 'verified_pending',time).run();
 const result=await req('/purchases?days=7');assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.totals.verifiedPending,1);assert.equal(result.body.periodUsd,null);
 const serial=JSON.stringify(result.body);for(const secret of ['private-ledger-key','private-google-token-hash','private-receipt-hash','private-account-binding','facts_json'])assert.equal(serial.includes(secret),false);
 const entry=result.body.recent[0];assert.equal(entry.amountMicros,null);assert.equal((await req('/purchases/'+entry.id)).status,200);
 assert.equal((await req('/purchases/sample',{sampleId:'synthetic'})).status,404);
 assert.equal((await req('/purchases?game=ec2')).status,400);
 assert.equal((await req('/purchases?days=999')).status,400);assert.equal((await req('/purchases?platform=ec2')).status,400);
 assert.equal((await req('/purchases',undefined,{Cookie:''})).status,401);
 assert.equal((await req('/purchases',undefined,{'X-Admin-Role':'internal',Cookie:''})).status,401);
 await central.prepare("UPDATE state SET role='removed'").run();assert.equal((await req('/purchases')).status,401);
 assert.equal((await db.prepare('SELECT save_version FROM player WHERE id=?').bind('recipient').first()).save_version,0);
});
