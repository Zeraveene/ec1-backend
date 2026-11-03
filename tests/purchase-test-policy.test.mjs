import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
let store;
before(async()=>{
 const bundle=await build({entryPoints:['src/purchases/store.ts'],bundle:true,write:false,format:'esm',platform:'node'});
 store=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
});
const env={IAP_ALLOW_TEST_PURCHASES:'false',IAP_TEST_PURCHASE_PLAYERS:'dev-one,dev-two',IAP_APPLE_VERIFICATION_MODE:'receipt'};
const account={google_account_id:'binding',apple_account_token:'account-token'};
const proof={platform:'apple',transactionId:'synthetic-transaction',purchaseTimeMs:1,appleData:{environment:'Sandbox',appAccountToken:'account-token',quantity:1}};
test('sandbox opt-in requires exact authenticated allowlisted identity and excludes purchase guests',async()=>{
 for(const playerId of ['dev-one','dev-two']){
  const player={playerId,provider:'email'};
  assert.equal(store.testPurchasesAllowed(env,player),true);
  assert.equal((await store.verifyStore(env,proof,account,player)).environment,'test');
 }
 for(const player of [undefined,{playerId:'other',provider:'email'},{playerId:'dev-one-extra',provider:'email'},{playerId:'dev-one',provider:'purchase_guest'}]){
  assert.equal(store.testPurchasesAllowed(env,player),false);
  await assert.rejects(()=>store.verifyStore(env,proof,account,player),e=>e.code==='test_purchase_not_allowed');
 }
 assert.equal(store.testPurchasesAllowed({}, {playerId:'dev-one',provider:'email'}),false);
});
test('sandbox allowlist does not bypass store ownership, revocation or quantity checks',async()=>{
 const player={playerId:'dev-one',provider:'email'};
 for(const [patch,code] of [[{appAccountToken:'foreign'},'purchase_owner_mismatch'],[{quantity:2},'purchase_quantity_unsupported'],[{revocationDate:1},'revoked_transaction']])
  await assert.rejects(()=>store.verifyStore(env,{...proof,appleData:{...proof.appleData,...patch}},account,player),e=>e.code===code);
 assert.equal((await store.verifyStore(env,{...proof,appleData:{...proof.appleData,environment:'Production'}},account,{playerId:'other',provider:'email'})).environment,'production');
});
