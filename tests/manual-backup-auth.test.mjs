import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
test('explicit manual-mode registration and login create no gameplay backup and make zero source calls',async()=>{
 const built=await build({stdin:{resolveDir:process.cwd(),contents:`import {createAuthApp} from './src/auth';export default createAuthApp();`},bundle:true,format:'esm',platform:'browser',write:false});
 let sourceCalls=0;const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'manual-auth-test'},r2Buckets:['PLAYER_SAVES'],bindings:{EC1_MANUAL_BACKUPS_ENABLED:'true',ALLOW_NEW_ACCOUNTS:'true',PLAYER_TOKEN_SECRET:'synthetic-manual-auth-secret-longer-than-32-characters'},outboundService:()=>{sourceCalls++;throw Error('network forbidden');}}));
 try{
  const db=await mf.getD1Database('DB');for(const f of ['001_auth.sql','002_game.sql','030_liveops_leaderboards.sql','033_structured_fortress.sql','021_device_credentials.sql','023_manual_backups.sql'])for(const sql of(await readFile('migrations/'+f,'utf8')).replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  const body={email:'manual@example.test',password:'synthetic-secure-password',bootstrapId:'manual-auth-bootstrap',bootstrapSecret:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'};
  const call=path=>mf.dispatchFetch('https://local.test/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const registered=await call('register');assert.equal(registered.status,200);const session=await registered.json();assert.ok(session.accessToken);assert.equal(session.saveVersion,0);
  const signedIn=await call('login');assert.equal(signedIn.status,200);
  for(const table of ['save_revision','classic_backup_revision','classic_backup_head'])assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0);
  const bucket=await mf.getR2Bucket('PLAYER_SAVES');assert.equal((await bucket.list()).objects.length,0);assert.equal(sourceCalls,0);
 }finally{await mf.dispose();}
});
