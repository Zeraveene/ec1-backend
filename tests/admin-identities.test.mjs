import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
let mf,db,worker;
const actor={id:'admin',name:'Synthetic',role:'internal'};
before(async()=>{
 const code=await build({stdin:{contents:`import * as actions from './src/admin/identities'; import {passwordHash} from './src/auth/crypto'; export default {async fetch(req,env){const b=await req.json();try {if(b.race){const original=env.DB;env={...env,DB:{prepare:(...a)=>original.prepare(...a),batch:async statements=>{await original.prepare("UPDATE player SET save_version=save_version+1 WHERE id='source'").run();return original.batch(statements);}}};}if(b.action==='verify'){const i=await env.DB.prepare("SELECT * FROM auth_identity WHERE player_id=? AND provider='email'").bind(b.args.id).first();return Response.json({valid:i.password_hash===await passwordHash(b.args.password,i.salt)});}return Response.json(await actions[b.action](env,b.actor,b.args));}catch(e){return Response.json({error:e.code??'unexpected'},{status:e.status??500});}}};`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:code.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'identity-test'},bindings:{PLAYER_TOKEN_SECRET:'synthetic-test-secret'}}));db=await mf.getD1Database('DB');worker=await mf.getWorker();
 for(const name of ['001_auth.sql','003_admin.sql','010_recovery.sql','021_device_credentials.sql','022_admin_identity.sql'])for(const sql of (await readFile('migrations/'+name,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 for(const id of ['source','destination','single'])await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES (?,1,1)').bind(id).run();
 for(const [id,p,sub] of [['source','email','source@example.test'],['source','google','google-source'],['destination','discord','discord-dest'],['single','apple','apple-single']])await db.prepare('INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES (?,?,?,1)').bind(p,sub,id).run();
});
after(async()=>mf?.dispose());
async function call(action,args={},who=actor,race=false){const res=await worker.fetch('https://test/',{method:'POST',body:JSON.stringify({action,args,actor:who,race})});return {status:res.status,body:await res.json()};}
test('safe read, roles, last durable sign-in and expected subject',async()=>{
 const read=await call('identityRead',{id:'source'});assert.equal(read.status,200);assert.equal(read.body.identities.find(x=>x.provider==='password').email,'source@example.test');assert.doesNotMatch(JSON.stringify(read.body),/salt|password_hash/);
 for(const role of ['guest','manager'])assert.equal((await call('identityUnlink',{id:'source',provider:'google',expectedSubject:'google-source',operationId:role},{...actor,role})).status,403);
 assert.equal((await call('identityUnlink',{id:'single',provider:'apple',expectedSubject:'apple-single',operationId:'last'})).body.error,'last_signin_method');
 assert.equal((await call('identityUnlink',{id:'source',provider:'google',expectedSubject:'stale',operationId:'stale'})).status,409);
});
test('changed preview, move preserves saves, atomically revokes and replays lost acknowledgements',async()=>{
 const args={id:'destination',sourceId:'source',provider:'google'};const preview=(await call('identityPreviewMove',args)).body;
 await db.prepare("UPDATE player SET save_version=1 WHERE id='source'").run();
 assert.equal((await call('identityMove',{...args,reviewSha256:preview.reviewSha256,operationId:'changed'})).body.error,'review_changed');
 const fresh=(await call('identityPreviewMove',args)).body;
 for(const id of ['source','destination']){await db.prepare("INSERT INTO auth_session(id,player_id,provider,created_at,expires_at) VALUES (?,?,'google',1,9999999999)").bind('session-'+id,id).run();await db.prepare('INSERT INTO auth_refresh(hash,session_id,expires_at) VALUES (?,?,9999999999)').bind('refresh-'+id,'session-'+id).run();await db.prepare('INSERT INTO auth_device_credential(id,player_id,secret_hash,device_id,created_at) VALUES (?,?,?,?,1)').bind('device-'+id,id,'secret-'+id,'device').run();await db.prepare('INSERT INTO auth_bootstrap VALUES (?,?,?,?,1)').bind('boot-'+id,'secret','fingerprint',id).run();}
 const commit={...args,reviewSha256:fresh.reviewSha256,operationId:'move'};const results=await Promise.all([call('identityMove',commit),call('identityMove',commit)]);for(const r of results)assert.equal(r.status,200);assert.deepEqual(results[0].body,results[1].body);
 assert.deepEqual((await call('identityMove',commit)).body,results[0].body);assert.equal((await call('identityMove',{...commit,provider:'apple'})).body.error,'operation_conflict');
 assert.equal((await db.prepare("SELECT player_id FROM auth_identity WHERE provider='google'").first()).player_id,'destination');assert.equal((await db.prepare("SELECT save_version FROM player WHERE id='source'").first()).save_version,1);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_session WHERE revoked_at IS NULL').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_refresh').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_bootstrap').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_device_credential WHERE revoked_at IS NULL').first()).n,0);assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='identity_move'").first()).n,1);
});
test('password uses existing PBKDF2; email ownership and null creation are guarded',async()=>{
 const reset={id:'source',password:'synthetic-password-42',expectedSubject:'source@example.test',operationId:'reset'};
 assert.equal((await call('identityResetPassword',reset)).status,200);assert.equal((await call('verify',{id:'source',password:reset.password})).body.valid,true);
 assert.equal((await call('identitySetEmail',{id:'destination',email:'source@example.test',password:reset.password,expectedSubject:null,operationId:'collision'})).body.error,'email_already_linked');
 assert.equal((await call('identitySetEmail',{id:'destination',email:'new@example.test',password:reset.password,expectedSubject:null,operationId:'create'})).status,200);
 assert.equal((await call('identitySetEmail',{id:'destination',email:'other@example.test',password:reset.password,expectedSubject:null,operationId:'stale-create'})).status,409);
 assert.doesNotMatch(JSON.stringify((await db.prepare('SELECT * FROM admin_identity_operation').all()).results),/synthetic-password/);
});
test('explicit preview warns and permits moving last durable method; unlink keeps another method',async()=>{
 const args={id:'destination',sourceId:'single',provider:'apple'};
 const preview=(await call('identityPreviewMove',args)).body;assert.match(preview.warnings[0],/no durable/);
 assert.equal((await call('identityMove',{...args,reviewSha256:preview.reviewSha256,operationId:'last-move'})).status,200);
 assert.equal((await call('identityRead',{id:'single'})).body.identities.length,0);
 assert.equal((await call('identityUnlink',{id:'destination',provider:'discord',expectedSubject:'discord-dest',operationId:'unlink'})).status,200);
 assert.equal((await call('identitySetEmail',{id:'destination',email:'changed@example.test',password:'changed-password-synthetic',expectedSubject:'new@example.test',operationId:'change-email'})).status,200);
 assert.equal((await call('verify',{id:'destination',password:'changed-password-synthetic'})).body.valid,true);
});
test('guard aborts zero-row race before side effects or receipt',async()=>{
 const before=(await db.prepare('SELECT COUNT(*) n FROM admin_audit').first()).n;
 const result=await call('identityResetPassword',{id:'source',password:'another-synthetic-password',expectedSubject:'source@example.test',operationId:'guard-race'},actor,true);
 assert.equal(result.status,409);assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit').first()).n,before);assert.equal(await db.prepare("SELECT operation_id FROM admin_identity_operation WHERE operation_id='guard-race'").first(),null);
});
test('database outage is not account absence',async()=>{await db.prepare('ALTER TABLE player RENAME TO unavailable_player').run();assert.equal((await call('identityRead',{id:'source'})).status,503);});
