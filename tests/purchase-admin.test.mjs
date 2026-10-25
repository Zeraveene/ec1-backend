import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
let mf, db, worker;
let outbound = 0;
const now = Date.now(), start = Math.floor((now + 25200000) / 86400000) * 86400000 - 25200000;
before(async () => {
  const bundle = await build({stdin:{contents:`import {dispatchPurchaseAdmin} from './src/purchases/admin'; export default {async fetch(request,env){const b=await request.json();return Response.json(await dispatchPurchaseAdmin({...env,...b.flags},{id:'123',name:'Synthetic'},b.role??'internal',b.operation,b.args??{}));}}`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'purchase-admin-test'},outboundService:()=>{outbound++;throw new Error('outbound forbidden');}}));
  db = await mf.getD1Database('DB'); worker = await mf.getWorker();
  for (const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()) for(const sql of (await readFile(`migrations/${file}`,'utf8')).replace(/;(?=\s*END;)/g,'__INNER_SEMICOLON__').split(';').map(s=>s.replaceAll('__INNER_SEMICOLON__',';').trim()).filter(Boolean)) await db.prepare(sql).run();
  await db.prepare("INSERT INTO player(id,display_name,created_at,updated_at) VALUES ('synthetic','勇者 Synthetic',?,?)").bind(now,now).run();
  const add=async(key,platform,environment,status,created,purchaseTime=created,product='gems')=>db.prepare('INSERT INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,status,created_at,granted_at,save_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(key,platform,platform==='google'?'google:private-token-hash':`apple-${key}`,'synthetic',product,'private-receipt-hash',1,environment,platform==='google'?'google_api':'apple_signed_receipt',JSON.stringify({source:platform==='google'?'google_api':'apple_signed_receipt',purchaseTime,accountBinding:'private-account-binding',orderId:'private-token',price:99999999,currency:'USD',refundStatus:'none'}),status,created,status==='granted'?created:null,status==='granted'?2:null).run();
  // Equal times exercise stable secondary ordering and production-only totals.
  for(let i=0;i<5;i++) await add(`key${i}`,'apple','production',i===0?'revoked':i===1?'verified_pending':'granted',start+1000);
  await add('private-key','google','test','granted',start+1000);
  await add('sandbox','apple','sandbox','verified_pending',start+1000);
  await add('previous','apple','production','granted',start-1);
  await add('old','apple','production','granted',start-100*86400000);
  await add('actual-time','apple','production','granted',start+1000,start-1000,'dated');
});
after(async()=>await mf?.dispose());
async function call(operation='purchases.analytics',args={},role='internal',flags={}) {return (await worker.fetch('https://synthetic.test/',{method:'POST',body:JSON.stringify({operation,args,role,flags})})).json();}
test('actual D1 analytics projects unknown finances, production counts, Jakarta windows and safe detail',async()=>{
 const result=await call(); assert.equal(result.status,200);const body=result.body;
 assert.equal(body.since,start);assert.equal(body.timeZone,'Asia/Jakarta');assert.equal(body.totals.purchases,5);assert.equal(body.totals.granted,3);assert.equal(body.totals.verifiedPending,1);assert.equal(body.totals.revoked,1);assert.equal(body.totals.unknownAmounts,5);assert.equal(body.previous.purchases,2);
 assert.equal(body.recent.length,7);assert.equal(body.daily.reduce((n,r)=>n+r.purchases,0),5);assert.equal(body.products[0].purchases,5);assert.equal(body.buyers[0].purchases,5);assert.equal(body.hourly[0].hour,0);
 assert.equal(body.periodUsd,null);assert.equal(body.todayUsd,null);assert.equal(body.totals.refundedPurchases,null);assert.deepEqual(body.revenue,[]);assert.equal(body.readiness.financialAmounts,false);
 for(const row of body.recent){assert.equal(row.amountMicros,null);assert.equal(row.currency,null);assert.equal(row.refundStatus,'unknown');}
 const google=body.recent.find(row=>row.platform==='google');assert.equal(google.transactionId,null);
 const detail=await call('purchases.detail',{id:google.id});assert.equal(detail.status,200);assert.equal(detail.body.purchase.saveVersion,2);
 assert.doesNotMatch(JSON.stringify([result,detail]),/private-|facts_json|receipt_hash|accountBinding|purchase_key|google:/);assert.equal(outbound,0);
});
test('keyset pages preserve all timestamp ties and enforce cursor search scope',async()=>{
 let cursor,all=[];do {const res=await call('purchases.analytics',{limit:2,...(cursor?{cursor}:{})});assert.equal(res.status,200);all.push(...res.body.recent);cursor=res.body.nextCursor;}while(cursor);
 assert.equal(all.length,7);assert.equal(new Set(all.map(r=>r.id)).size,7);
 const first=await call('purchases.analytics',{limit:2,q:'勇者'});assert.ok(first.body.nextCursor);assert.equal((await call('purchases.analytics',{limit:2,q:'勇者',cursor:first.body.nextCursor})).status,200);assert.equal((await call('purchases.analytics',{q:'other',cursor:first.body.nextCursor})).status,400);
});
test('filters apply to rows, summaries stay production scoped, search escapes wildcards',async()=>{
 for(const [args,n] of [[{platform:'google'},1],[{status:'test'},2],[{status:'revoked'},1],[{q:'%'},0],[{q:'_'},0],[{q:'!'},0],[{q:'\\'},0],[{q:'gems'},7],[{q:'dated'},0]]){const res=await call('purchases.analytics',args);assert.equal(res.status,200);assert.equal(res.body.recent.length,n);assert.equal(res.body.totals.purchases,5);}
 const longSearch=await call('purchases.analytics',{q:'x'.repeat(80)});assert.equal(longSearch.status,200);assert.equal(longSearch.body.recent.length,0);
 assert.equal((await call('purchases.analytics',{days:7})).body.totals.purchases,7);
 const safeOrder='GPA.1234-5678-9012-34567';
 await db.prepare("UPDATE purchase_ledger SET facts_json=json_set(facts_json,'$.orderId',?) WHERE purchase_key='private-key'").bind(safeOrder).run();
 const found=await call('purchases.analytics',{q:safeOrder});assert.equal(found.body.recent.length,1);assert.equal(found.body.recent[0].transactionId,safeOrder);
 assert.equal((await call('purchases.analytics',{q:'private-token'})).body.recent.length,0);
 await db.prepare("UPDATE purchase_ledger SET facts_json=json_set(facts_json,'$.orderId','google-token:private-hash') WHERE purchase_key='private-key'").run();
 assert.equal((await call('purchases.analytics',{platform:'google'})).body.recent[0].transactionId,null);
});
test('rejects non-internal and malformed or excessive arguments before reading data',async()=>{
 for(const role of ['manager','guest','owner','INTERNAL',false])assert.equal((await call('purchases.analytics',{},role)).status,403);
 for(const args of [{days:2},{days:[]},{limit:0},{limit:101},{limit:1.5},{q:'x'.repeat(81)},{q:123},{platform:'pc'},{status:'refunded'},{cursor:'broken'},{cursor:'x'.repeat(801)},{cursor:3},{extra:true},[]])assert.equal((await call('purchases.analytics',args)).status,400);
 for(const id of ['google:private-token-hash','p_0','p_01','p_zzzzzzzzzzz',123])assert.equal((await call('purchases.detail',{id})).status,400);
 assert.equal((await call('purchases.detail',{id:'p_z'})).status,404);assert.equal((await call('purchases.mutate')).status,400);
});
test('readiness reflects effective legacy claim gates without exposing private configuration',async()=>{
 for(const [flags,enabled] of [[{},false],[{IAP_PURCHASES_ENABLED:'true'},true],[{IAP_PURCHASES_ENABLED:'true',EC1_MANUAL_BACKUPS_ENABLED:'true'},false],[{IAP_PURCHASES_ENABLED:'TRUE'},false]]) {
  const res=await call('purchases.analytics',{},'internal',{...flags,IAP_GOOGLE_SERVICE_ACCOUNT:'private-credential'});assert.equal(res.body.readiness.purchasesEnabled,enabled);assert.equal(res.body.readiness.deliveryProtocolReady,false);assert.doesNotMatch(JSON.stringify(res),/private-credential|IAP_GOOGLE_SERVICE_ACCOUNT/);
 }
});
test('malformed facts fall back to ledger time; arbitrary extra finance fields are ignored; errors are redacted',async()=>{
 await db.prepare("UPDATE purchase_ledger SET facts_json='invalid-json' WHERE purchase_key='key0'").run();assert.equal((await call()).status,200);
 await db.prepare('ALTER TABLE purchase_ledger RENAME TO private_ledger_unavailable').run();const res=await call();assert.equal(res.status,503);assert.deepEqual(res.body,{error:'purchase_storage_unavailable'});assert.equal(outbound,0);
});
