import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('structured migration preserves historical entries, accepted receipts and legacy save-linked rows',async()=>{
 const built=await build({stdin:{resolveDir:process.cwd(),contents:`import {Hono} from 'hono';import {createLeaderboardsApp} from './src/liveops/leaderboards';import {signToken} from './src/auth/crypto';const app=new Hono();app.route('/api/liveops/leaderboards',createLeaderboardsApp());app.get('/token',async c=>c.json({token:await signToken(c.env.PLAYER_TOKEN_SECRET,{sub:'fixture',sid:'fixture-session',scope:'player',provider:'email'})}));export default app;`},bundle:true,format:'esm',platform:'browser',write:false});
 let calls=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'structured-migration'},bindings:{PLAYER_TOKEN_SECRET:'synthetic-structured-migration-secret-32'},outboundService:()=>{calls++;throw Error('network forbidden')}}));
 try {
  const db=await mf.getD1Database('DB');
  const migrate=async name=>db.exec((await readFile('migrations/'+name,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
  for(const name of (await readdir('migrations')).filter(x=>x.endsWith('.sql')&&x<'033').sort())await migrate(name);
  await db.prepare("INSERT INTO player(id,display_name,created_at,updated_at) VALUES ('fixture','Fixture',1,1)").run();
  await db.prepare("INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES ('fixture-session','fixture','email','player',1,4102444800)").run();
  await db.prepare("INSERT INTO save_revision(player_id,version,r2_key,sha256,playtime,operation_id,payload_hash,created_at) VALUES ('fixture',1,'retained','hash',1,'save','save-hash',42)").run();
  await db.prepare("INSERT INTO player_leaderboard VALUES ('fixture',2147000003,1,42)").run();
  await db.prepare("INSERT INTO classic_leaderboard_entry VALUES ('infinity_fortress',1,'fixture',2147000003,3,2147,0,42)").run();
  const records=[{character:0,floor:1,cleartime:99999},{character:2,floor:269,cleartime:1},{character:3,floor:2147,cleartime:0}];
  for(const [i,r] of records.entries()) {
   const hash=createHash('sha256').update(JSON.stringify({version:1,...r})).digest('hex');
   await db.prepare("INSERT INTO classic_leaderboard_submission VALUES ('infinity_fortress',1,'fixture',?,?,?,42)").bind('old-'+i,hash,r.floor*1000000-r.cleartime*10+r.character).run();
  }
  await migrate('033_structured_fortress.sql');
  assert.deepEqual(await db.prepare("SELECT character,floor,cleartime,updated_at FROM classic_leaderboard_entry").first(),{character:3,floor:2147,cleartime:0,updated_at:42});
  assert.deepEqual(await db.prepare("SELECT character,floor,cleartime,save_version,updated_at FROM player_leaderboard").first(),{character:3,floor:2147,cleartime:0,save_version:1,updated_at:42});
  const token=(await (await mf.dispatchFetch('https://local.test/token')).json()).token;
  for(const [i,r] of records.entries()) {
   const response=await mf.dispatchFetch('https://local.test/api/liveops/leaderboards/infinity_fortress/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({season:1,version:1,operationId:'old-'+i,record:r})});
   assert.equal(response.status,200);assert.deepEqual((await response.json()).acceptedRecord,r);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM save_revision').first()).n,1);
  for(const table of ['classic_leaderboard_entry','classic_leaderboard_submission','player_leaderboard'])
   assert.equal((await db.prepare('PRAGMA table_info('+table+')').all()).results.some(x=>x.name==='score'),false);
  assert.equal(calls,0);
 } finally {await mf.dispose();}
});
