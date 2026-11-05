import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf, db, bucket;
const actor = { id: '111111111111111111', name: 'Synthetic', role: 'internal' };
before(async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import {deleteAccount,accountDeletionStatus} from './src/admin/account-deletion';
    import {readWorkspace} from './src/admin/workspace-read';
    import {requirePlayer} from './src/auth';import {signToken} from './src/auth/crypto';
    import {Hono} from 'hono';const game=new Hono();game.get('/api/game/check',requirePlayer,c=>c.json({ok:true}));
    export default {async fetch(req,env,ctx){
      if(req.method==='GET')return game.fetch(req,env,ctx);
      const b=await req.json();const actor=b.actor;
      try{
        if(b.action==='token')return Response.json(await signToken(env.PLAYER_TOKEN_SECRET,{sub:b.id,sid:'session-'+b.id,scope:'player',provider:'email',deviceId:null}));
        if(b.action==='status')return Response.json(await accountDeletionStatus(env,actor,b.id));
        if(b.action==='read')return Response.json(await readWorkspace(env,'player',{id:b.id}));
        const bucket=env.PLAYER_SAVES;
        return Response.json(await deleteAccount(b.fault?{...env,PLAYER_SAVES:{delete:async()=>{throw Error('synthetic R2 failure')}}}:env,actor,b.id,b.args));
      }catch(e){return Response.json({error:e.code||'unavailable'},{status:e.status||503});}
    }};` }, bundle: true, format: 'esm', write: false, platform: 'browser' });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-10-06', d1Databases: { DB: 'deletion' }, r2Buckets: ['PLAYER_SAVES'], bindings: { PLAYER_TOKEN_SECRET: 'synthetic-deletion-secret-32-characters' }, outboundService: () => { throw Error('No PlayFab or external requests allowed'); } }));
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('PLAYER_SAVES');
  for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    const statements = (await readFile('migrations/' + file, 'utf8')).replace(/;(?=\s*END;)/g, '__INNER__').split(';').map(sql => sql.replaceAll('__INNER__', ';').trim()).filter(Boolean);
    for (const sql of statements) await db.prepare(sql).run();
  }
});
after(async () => mf?.dispose());
async function call(id, args, role = 'internal', action = 'delete', fault = false) {
  const response = await mf.dispatchFetch('https://fixture', { method: 'POST', body: JSON.stringify({ id, args, action, fault, actor: { ...actor, role } }) });
  return { status: response.status, body: await response.json() };
}
const request = id => ({ operationId: 'delete-' + id, confirmation: id, acknowledged: true, reason: 'Synthetic player request' });
async function seed(id) {
  await db.prepare('INSERT INTO player(id,display_name,created_at,updated_at) VALUES(?,?,0,0)').bind(id, 'Synthetic player ' + id).run();
  await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,password_hash,salt,created_at) VALUES('email',?,?, 'private-hash','private-salt',0)").bind(id + '@example.test', id).run();
  await db.prepare("INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES(?,?,'email','player',0,?)").bind('session-' + id, id, Math.floor(Date.now() / 1000) + 10000).run();
  await db.prepare('INSERT INTO auth_refresh(hash,session_id,expires_at) VALUES(?,?,?)').bind('refresh-' + id, 'session-' + id, Math.floor(Date.now() / 1000) + 10000).run();
  await db.prepare('INSERT INTO auth_device_credential(id,player_id,secret_hash,device_id,created_at) VALUES(?,?,?,?,0)').bind('device-' + id, id, 'private-' + id, 'device-id').run();
  await db.prepare('INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES(?,1,?,?,3,1,10,0,?,?)').bind(id, 'backup-' + id, 'hash', 'seed-' + id, 'hash').run();
  await db.prepare('INSERT INTO classic_backup_head VALUES(?,1)').bind(id).run();
  await bucket.put('backup-' + id, 'synthetic snapshot');
  await db.prepare('INSERT INTO liveops_grant(id,player_id,source_type,source_id,rewards_json,created_at) VALUES(?,?,\'mail\',?,\'[]\',0)').bind('grant-' + id, id, 'source-' + id).run();
  await db.prepare('INSERT INTO liveops_mail(id,player_id,title,body,rewards_json,created_at) VALUES(?,?,\'Title\',\'Private body\',\'[]\',0)').bind('mail-' + id, id).run();
  await db.prepare("INSERT INTO purchase_ledger(purchase_key,platform,transaction_id,player_id,product_id,receipt_hash,quantity,environment,verification_source,facts_json,status,created_at) VALUES(?,'apple',?,?,'iap_premium','private-hash',1,'production','apple_signed_receipt','{}','granted',0)").bind('purchase-' + id, 'transaction-' + id, id).run();
}
async function game(token) { return mf.dispatchFetch('https://fixture/api/game/check', { headers: { Authorization: 'Bearer ' + token } }); }
test('role, ID, acknowledgement and reason guards perform no deletion', async () => {
  await seed('guard'); const args = request('guard');
  for (const role of ['manager', 'guest']) assert.equal((await call('guard', args, role)).status, 403);
  for (const invalid of [{ ...args, confirmation: 'other' }, { ...args, acknowledged: false }, { ...args, reason: '' }, { ...args, operationId: '' }]) assert.equal((await call('guard', invalid)).status, 400);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM account_deletion WHERE player_id='guard'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM auth_identity WHERE player_id='guard'").first()).n, 1);
});
test('deletion revokes access, removes snapshots/mail/credentials, retains replay records and other accounts', async () => {
  await seed('deleted'); await seed('untouched');
  const token = (await call('deleted', {}, 'internal', 'token')).body;
  assert.equal((await game(token)).status, 200);
  const args = request('deleted'), result = await call('deleted', args);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.deleted, true);
  assert.equal((await game(token)).status, 401);
  for (const table of ['auth_identity', 'auth_session', 'auth_device_credential', 'classic_backup_revision', 'classic_backup_head', 'liveops_mail']) assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE player_id=?`).bind('deleted').first()).n, 0, table);
  assert.equal(await bucket.get('backup-deleted'), null); assert.ok(await bucket.get('backup-untouched'));
  for (const table of ['purchase_ledger', 'liveops_grant']) assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE player_id='deleted'`).first()).n, 1);
  assert.equal((await db.prepare("SELECT display_name FROM player WHERE id='deleted'").first()).display_name, null);
  assert.equal((await call('deleted', {}, 'internal', 'read')).body.status, 404);
  assert.deepEqual((await call('deleted', args)).body, result.body);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE player_id='deleted'").first()).n, 2);
});
test('storage failure is resumable and blocks racing sign-in, save publication, identity moves and unban', async () => {
  await seed('retry'); const args = request('retry');
  assert.equal((await call('retry', args, 'internal', 'delete', true)).body.error, 'deletion_incomplete_retry');
  assert.equal((await call('retry', {}, 'internal', 'status')).body.state, 'cleanup_pending');
  assert.equal((await db.prepare("SELECT save_state FROM player WHERE id='retry'").first()).save_state, 'deleted');
  for (const sql of [
    "INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES('late-session','retry','email','player',0,9999999999)",
    "INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES('google','foreign-subject','retry',0)",
    "UPDATE player SET save_state='migrated' WHERE id='retry'",
    "INSERT OR REPLACE INTO player(id,created_at,updated_at) VALUES('retry',0,0)",
    "INSERT OR REPLACE INTO player_ban(player_id,reason,created_at) VALUES('retry','other',0)",
    "UPDATE auth_identity SET player_id='retry' WHERE player_id='untouched'",
    "UPDATE player_ban SET revoked_at=1 WHERE player_id='retry'",
    "INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash) VALUES('retry',2,'late-key','hash',3,1,20,0,'late-op','hash')",
  ]) await assert.rejects(db.prepare(sql).run(), /account_deleted/);
  assert.equal((await call('retry', { ...args, operationId: 'different-op' })).status, 409);
  assert.equal((await call('retry', args)).status, 200);
  assert.equal((await call('retry', {}, 'internal', 'status')).body.state, 'complete');
});
test('concurrent exact retries converge and failed audit rolls back the access block', async () => {
  await seed('parallel'); const args = request('parallel');
  const pair = await Promise.all([call('parallel', args), call('parallel', args)]);
  assert.deepEqual(pair.map(row => row.status), [200, 200]);
  await seed('auditfail');
  await db.prepare("CREATE TRIGGER fail_deletion_audit BEFORE INSERT ON admin_audit WHEN NEW.player_id='auditfail' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
  assert.equal((await call('auditfail', request('auditfail'))).status, 503);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM account_deletion WHERE player_id='auditfail'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM auth_identity WHERE player_id='auditfail'").first()).n, 1);
  assert.ok(await bucket.get('backup-auditfail'));
});
