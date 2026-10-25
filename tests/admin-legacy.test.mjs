import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const bundled = await build({ stdin:{contents:`export {inspectLegacySave} from './src/admin/legacy-save'; export {readWorkspace} from './src/admin/workspace-read';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node' });
const {inspectLegacySave,readWorkspace} = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const base=JSON.parse(await readFile('tests/fixtures/alasterbase.json','utf8'));
const prefs={gamedata:JSON.stringify({gold:12000,ruby:75,timeCounter:10,stageProgress:12,note:'A $ inside JSON'}),alaster_attributes:JSON.stringify({...base,level:35,Str:42,skillB_lv:3,passiveA:9}),costume_alaster:'2',transmog_alaster:'synthetic-sword',lbName:'Fixture Hero',playtime:'120'};
const payload=JSON.stringify(prefs);
test('nested legacy strings preserve zeroes, four slots, skills, masteries, costume and transmog',()=>{
 const result=inspectLegacySave(payload,'36000');
 assert.equal(result.state,'available');assert.deepEqual(result.warnings,[]);
 assert.equal(result.account.gold,12000);assert.equal(result.account.ruby,75);assert.equal(result.account.playtime,36000);
 const h=result.heroes[0];assert.equal(h.name,'Alaster');assert.deepEqual(h.attributes,{STR:42,INT:0,AGI:0,VIT:0});
 assert.deepEqual(h.equipment.map(e=>e.slot),['Weapon','Armor','Gloves','Shoes']);assert.equal(h.equipment[0].id,'aweapon');
 assert.equal(h.skills.length,4);assert.equal(h.skills[1].level,3);assert.equal(h.skills[0].name,'Counter Guard');assert.equal(h.masteries.length,4);assert.equal(h.masteries[0].level,9);
 assert.equal(h.costumeName,'Brave Knight');assert.equal(h.transmog,'synthetic-sword');assert.equal(h.costume,2);
 assert.equal(inspectLegacySave(payload,undefined).account.playtime,120);
});
test('historical positional saves split only unquoted dollars using Unity field order',async()=>{
 const keys=JSON.parse(await readFile('src/admin/legacy-keys.json','utf8'));
 const positional=keys.map(k=>prefs[k]??'').join('$');
 const result=inspectLegacySave(positional,'99');assert.equal(result.account.gold,12000);assert.equal(result.heroes[0].level,35);assert.equal(result.account.leaderboardName,'Fixture Hero');
});
test('malformed sections do not hide healthy heroes or fabricate zero balances',()=>{
 const result=inspectLegacySave(JSON.stringify({...prefs,gamedata:'broken',edna_attributes:'{',alaster_attributes:JSON.stringify({...base,s_weapon:'broken'})}),undefined);
 assert.equal(result.account.gold,null);assert.equal(result.account.ruby,null);assert.equal(result.heroes.length,1);assert.equal(result.heroes[0].equipment[0].id,null);assert.equal(result.heroes[0].equipment.length,4);assert.match(result.warnings.join(';'),/Game data: unreadable JSON/);assert.match(result.warnings.join(';'),/Alaster weapon: unreadable JSON/);assert.match(result.warnings.join(';'),/Edna: unreadable JSON/);
 assert.equal(inspectLegacySave(undefined,undefined).state,'missing');assert.equal(inspectLegacySave('{',undefined).state,'unreadable');
 assert.equal(inspectLegacySave(JSON.stringify({schemaVersion:99}),undefined).state,'unreadable');
});
test('schema 1 records have object equipment and hero-specific appearance',()=>{
 const r=inspectLegacySave({schemaVersion:1,progress:{gold:0,ruby:0},profile:{playtime:50},characters:[{...base,character:3,weapon:{id:'fixture',enhanceLevel:5,mainOption1:{option:1,value:34}}}],unlocks:{selectedCostumes:{soul:1},transmogs:{soul:'fixture'}}},undefined);
 assert.equal(r.account.gold,0);assert.equal(r.account.playtime,50);assert.equal(r.heroes[0].name,'Zerav');assert.equal(r.heroes[0].costumeName,'Christmas Wolf Zerav');assert.deepEqual(r.heroes[0].equipment[0].stats,[{slot:'mainOption1',label:'ATK',value:34}]);
});
let originalFetch; const calls=[]; let mode='ok';
const env={DB:{prepare:()=>({first:async()=>null})},PLAYFAB_TITLE_ID:'SYNTHETIC',PLAYFAB_SECRET_KEY:'synthetic-server-secret',LEGACY_MIGRATION_ENABLED:'false'};
before(()=>{originalFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{
 assert.match(url,/^https:\/\/SYNTHETIC.playfabapi.com\/(Admin\/GetUserAccountInfo|Server\/GetUserData)$/);assert.equal(init.method,'POST');
 const body=JSON.parse(init.body);calls.push({url,body});
 if(mode==='outage')return Response.json({error:'ServiceUnavailable',errorMessage:'secret upstream diagnostic'},{status:503});
 if(mode==='bad-key')return Response.json({error:'InvalidSecretKey'},{status:400});
 if(mode==='missing')return Response.json({error:'AccountNotFound'},{status:400});
 if(url.endsWith('GetUserData'))return Response.json({data:{Data:{CLOUD_ALL_DATA:{Value:payload,LastUpdated:'2026-10-23T00:00:00Z'},Playtime:{Value:'600'}}}});
 return Response.json({data:{UserInfo:{PlayFabId:'ABCDEF1234567890',Username:'fixture',PrivateInfo:{Email:'fixture@example.invalid'},AndroidDeviceInfo:{AndroidDeviceId:'secret-device'},CustomIdInfo:{CustomId:'secret-id'}}}});
};});
after(()=>{globalThis.fetch=originalFetch;});
test('admin reads work with migration disabled, project safe fields and never mutate PlayFab',async()=>{
 calls.length=0;const search=await readWorkspace(env,'legacy-search',{query:'fixture'});assert.equal(search.status,200);assert.equal(search.body.results.length,1);assert.equal(calls.length,2);
 const result=await readWorkspace(env,'legacy-player',{id:'ABCDEF1234567890'});assert.equal(result.status,200);assert.equal(result.body.account.playtime,600);assert.doesNotMatch(JSON.stringify(result),/secret/);assert.equal(calls.at(-1).body.Keys.join(','),'CLOUD_ALL_DATA,Playtime');
 for(const args of [{},{query:''},{query:'x',actor:'bad'},{query:'x\n'},{query:'x'.repeat(101)}])assert.equal((await readWorkspace(env,'legacy-search',args)).status,400);
 assert.equal((await readWorkspace(env,'legacy-player',{id:'EC1X_new'})).status,400);
 assert.equal((await readWorkspace({},'legacy-search',{query:'fixture'})).body.error,'legacy_viewer_not_configured');
});
test('not found, upstream failure and invalid credentials remain distinct',async()=>{
 mode='missing';assert.deepEqual((await readWorkspace(env,'legacy-search',{query:'fixture'})).body.results,[]);assert.equal((await readWorkspace(env,'legacy-player',{id:'ABCDEF1234567890'})).status,404);
 for(mode of ['outage','bad-key']){const r=await readWorkspace(env,'legacy-search',{query:'fixture'});assert.equal(r.status,503);assert.equal(r.body.error,'legacy_source_unavailable');assert.doesNotMatch(JSON.stringify(r),/secret/);}mode='ok';
});

test('legacy inventory handles quoted delimiters, duplicates and equipment detail fields',()=>{
 const weapon={id:'fixture-weapon',m_name:'Sword | of ^ Flame $',description:'Quote \" and pipe | caret ^',type:0,rarity:2,enhanceLevel:8,levelReq:40,sellPrice:900,mainOption1:{option:1,value:132},subOption1:{option:3,value:4.5},socket1:{option:9,value:7},socket2:{option:0,value:0}};
 const inventory=[JSON.stringify(weapon)+'|'+JSON.stringify({...weapon,enhanceLevel:2}),JSON.stringify({id:'ironbar',amount:27}),JSON.stringify({id:'apple',amount:3})].join('^');
 for(const raw of [inventory,JSON.stringify(inventory)]) {
  const r=inspectLegacySave(JSON.stringify({...prefs,inventory:raw}),undefined);
  assert.equal(r.inventory.state,'available');assert.equal(r.inventory.equipment.length,2);
  const eq=r.inventory.equipment[0];assert.equal(eq.name,'Sword | of ^ Flame $');assert.equal(eq.description,weapon.description);assert.equal(eq.sellPrice,900);assert.equal(eq.enhancement,8);
  assert.deepEqual(eq.sockets,[{slot:'socket1',state:'filled'},{slot:'socket2',state:'empty'}]);assert.equal(eq.stats.find(s=>s.slot==='socket1').label,'STR');
  assert.equal(r.inventory.equipment[1].enhancement,2);assert.equal(r.inventory.materials[0].amount,27);assert.equal(r.inventory.consumables[0].name,'Apple');assert.equal(r.inventory.consumables[0].amount,3);
 }
});
test('object inventory supports compact definitions and keeps unknown IDs without invented amounts',()=>{
 const r=inspectLegacySave({schemaVersion:1,inventory:{equipment:[{id:'unknown-equip',enhanceLevel:0}],materials:[{id:'ironbar',amount:0}],consumables:[{id:'unknown-potion',m_name:'Unknown potion'}]}},undefined);
 assert.equal(r.inventory.state,'available');assert.equal(r.inventory.equipment[0].level,null);assert.equal(r.inventory.equipment[0].sockets[0].state,'missing');
 assert.equal(r.inventory.materials[0].amount,0);assert.equal(r.inventory.consumables[0].name,'Unknown potion');assert.equal(r.inventory.consumables[0].amount,null);
});
test('empty, missing and damaged inventories are distinct and healthy neighbours survive',()=>{
 assert.equal(inspectLegacySave(payload,undefined).inventory.state,'missing');
 const empty=inspectLegacySave(JSON.stringify({...prefs,inventory:'^^'}),undefined);assert.equal(empty.inventory.state,'available');assert.deepEqual(empty.inventory.equipment,[]);
 const damaged=inspectLegacySave(JSON.stringify({...prefs,inventory:JSON.stringify({equipment:[{id:'healthy'},'{bad',{id:'healthy2'}],materials:'broken',consumables:[]})}),undefined);
 assert.equal(damaged.inventory.state,'partial');assert.deepEqual(damaged.inventory.equipment.map(e=>e.id),['healthy','healthy2']);assert.equal(damaged.inventory.materials,null);assert.equal(damaged.heroes[0].level,35);assert.match(damaged.warnings.join(';'),/equipment #2: unreadable item/);
 assert.equal(inspectLegacySave(JSON.stringify({...prefs,inventory:'bad^sections'}),undefined).inventory.state,'unreadable');
});
