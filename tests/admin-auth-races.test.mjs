import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto';
let mf, db, worker, key, jwk, sequence = 0;
const password = 'synthetic-before-reset-password';
const replacement = 'synthetic-after-reset-password';
const requests = [];
const b64 = value => Buffer.from(typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value)).toString('base64url');
before(async () => {
  const keys = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  key = keys.privateKey;
  jwk = {...await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid:'race-fixture',alg:'RS256'};
  const bundle = await build({stdin:{resolveDir:process.cwd(),contents:`
import {Hono} from 'hono';
import {createAuthApp,requirePlayer} from './src/auth/index';
import {signToken} from './src/auth/crypto';
import {identityResetPassword,identityUnlink,identityMove,identityPreviewMove,identitySetEmail} from './src/admin/identities';
const app=new Hono();
app.post('/test/token',async c=>{const b=await c.req.json();return c.json({token:await signToken(c.env.PLAYER_TOKEN_SECRET,{sub:b.id,sid:b.sessionId,provider:b.provider,scope:'player',deviceId:null})});});
app.use('/api/auth/*',async(c,next)=>{
 const config=c.req.header('X-Test-Race');if(!config){await next();return;}
 const race=JSON.parse(config),original=c.env.DB,rawEnv={...c.env,DB:original};let fired=false;
 const actor={id:'synthetic-admin',name:'Synthetic Admin',role:'internal'};
 const fire=async()=>{if(fired)return;fired=true;
  if(race.action==='reset')await identityResetPassword(rawEnv,actor,race.args);
  else if(race.action==='unlink')await identityUnlink(rawEnv,actor,race.args);
  else if(race.action==='email')await identitySetEmail(rawEnv,actor,race.args);
  else if(race.action==='move'){const preview=await identityPreviewMove(rawEnv,actor,race.args);await identityMove(rawEnv,actor,{...race.args,reviewSha256:preview.reviewSha256});}
  else if(race.action==='revoke')await original.prepare('UPDATE auth_session SET revoked_at=1 WHERE player_id=?').bind(race.args.id).run();
  else if(race.action==='deleteChallenge')await original.prepare('DELETE FROM auth_challenge WHERE id=?').bind(race.args.challengeId).run();
  else throw new Error('invalid test race');
 };
 const wrap=(sql,native)=>({native,sql,bind:(...values)=>wrap(sql,native.bind(...values)),
  first:async(...args)=>{const row=await native.first(...args);
   if(race.hook==='passwordRead'&&sql.startsWith('SELECT player_id,password_hash,salt')&&sql.includes("provider='email' AND subject=?"))await fire();
   if(race.hook==='socialRead'&&sql.startsWith('SELECT player_id')&&sql.includes('FROM auth_identity WHERE provider=? AND subject=?'))await fire();
   return row;},
  run:async(...args)=>{if(race.hook==='identityInsert'&&sql.startsWith('INSERT')&&sql.includes('INTO auth_identity('))await fire();return native.run(...args);},
  all:(...args)=>native.all(...args),raw:(...args)=>native.raw(...args)});
 c.env.DB={prepare:sql=>wrap(sql,original.prepare(sql)),batch:async statements=>{
  if(race.hook==='sessionInsert'&&statements.some(s=>s.sql?.includes('INTO auth_session(')))await fire();
  return original.batch(statements.map(s=>s.native??s));
 }};
 try{await next();c.header('X-Test-Race-Fired',fired?'1':'0');}finally{c.env.DB=original;}
});
app.route('/api/auth',createAuthApp());
app.get('/protected',requirePlayer,c=>c.json(c.get('player')));
export default app;
`},bundle:true,format:'esm',platform:'browser',write:false});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'auth-race-test'},bindings:{PLAYER_TOKEN_SECRET:'synthetic-race-secret-longer-than-32-characters',ALLOW_NEW_ACCOUNTS:'true',GOOGLE_CLIENT_IDS:'race-google-client'},outboundService:async request=>{
    requests.push(request.url);
    assert.equal(request.url,'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({keys:[jwk]});
  }}));
  db = await mf.getD1Database('DB'); worker = await mf.getWorker();
  for(const file of ['001_auth.sql','003_admin.sql','010_recovery.sql','021_device_credentials.sql','022_admin_identity.sql'])for(const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
});
after(async()=>mf?.dispose());
async function request(path,body,token,race){const response=await worker.fetch('https://synthetic.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(race?{'X-Test-Race':JSON.stringify(race)}:{})},body:JSON.stringify(body)});const result={status:response.status,body:await response.json()};if(race)assert.equal(response.headers.get('X-Test-Race-Fired'),'1','production path reached the intended race barrier');return result;}
async function fixture({email=true,google=false,apple=true}={}){
  const n=++sequence,id='race-player-'+n,destination='race-destination-'+n,subject=`race${n}@example.test`;
  for(const pid of [id,destination])await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES (?,1,1)').bind(pid).run();
  if(email){const salt=randomBytes(32).toString('base64url'),digest=pbkdf2Sync(password,Buffer.from(salt,'base64url'),100000,32,'sha256').toString('base64url');await db.prepare("INSERT INTO auth_identity VALUES ('email',?,?,?,?,1)").bind(subject,id,digest,salt).run();}
  if(google)await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES ('google',?,?,1)").bind('google-'+n,id).run();
  if(apple)await db.prepare("INSERT INTO auth_identity(provider,subject,player_id,created_at) VALUES ('apple',?,?,1)").bind('apple-'+n,id).run();
  return {id,destination,subject,googleSubject:'google-'+n,n};
}
async function ownerToken(f){const sessionId='owner-session-'+f.n,provider='apple';await db.prepare("INSERT INTO auth_session(id,player_id,provider,created_at,expires_at) VALUES (?,?,?,1,9999999999)").bind(sessionId,f.id,provider).run();return (await request('/test/token',{id:f.id,sessionId,provider})).body.token;}
async function proof(f,intent,token,subject=f.googleSubject){const challenge=await request('/api/auth/provider/google/challenge',{intent},token);assert.equal(challenge.status,200);const head=b64({alg:'RS256',kid:'race-fixture'}),payload=b64({iss:'https://accounts.google.com',aud:'race-google-client',sub:subject,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce:challenge.body.nonce});const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(head+'.'+payload));return {challengeId:challenge.body.challengeId,intent,idToken:head+'.'+payload+'.'+b64(new Uint8Array(signature))};}
async function noLiveSession(id){assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_session WHERE player_id=? AND revoked_at IS NULL').bind(id).first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_refresh r JOIN auth_session s ON s.id=r.session_id WHERE s.player_id=?').bind(id).first()).n,0);}
function reset(f,hook){return {hook,action:'reset',args:{id:f.id,password:replacement,expectedSubject:f.subject,operationId:'reset-race-'+f.n}};}
test('password login cannot publish old credentials after reset, unlink, email change or identity move',async()=>{
  for(const action of ['reset','unlink','email','move']){
    const f=await fixture();let race=reset(f,'passwordRead');
    if(action==='unlink')race={hook:'passwordRead',action,args:{id:f.id,provider:'password',expectedSubject:f.subject,operationId:'unlink-race-'+f.n}};
    if(action==='email')race={hook:'passwordRead',action,args:{id:f.id,email:'changed-'+f.subject,password:replacement,expectedSubject:f.subject,operationId:'email-race-'+f.n}};
    if(action==='move')race={hook:'passwordRead',action,args:{id:f.destination,sourceId:f.id,provider:'password',operationId:'move-race-'+f.n}};
    const denied=await request('/api/auth/login',{email:f.subject,password},null,race);assert.equal(denied.status,401);assert.equal(denied.body.error,'invalid_credentials');await noLiveSession(f.id);
    if(action==='reset')assert.equal((await request('/api/auth/login',{email:f.subject,password:replacement})).status,200);
  }
});
test('social signin cannot authorize stale source ownership after move or unlink',async()=>{
  for(const action of ['move','unlink']){
    const f=await fixture({google:true}),body=await proof(f,'signin');const args=action==='move'?{id:f.destination,sourceId:f.id,provider:'google',operationId:'social-move-'+f.n}:{id:f.id,provider:'google',expectedSubject:f.googleSubject,operationId:'social-unlink-'+f.n};
    const denied=await request('/api/auth/provider/google',body,null,{hook:'socialRead',action,args});assert.equal(denied.status,401);await noLiveSession(f.id);await noLiveSession(f.destination);
  }
});
test('provider link rechecks owner and challenge before inserting an identity',async()=>{
  for(const action of ['reset','revoke','deleteChallenge']){
    const f=await fixture(),token=await ownerToken(f),body=await proof(f,'link',token);
    const race=action==='reset'?reset(f,'identityInsert'):{hook:'identityInsert',action,args:{id:f.id,challengeId:body.challengeId}};
    const denied=await request('/api/auth/provider/google',body,token,race);assert.equal(denied.status,409);
    assert.equal(await db.prepare("SELECT subject FROM auth_identity WHERE provider='google' AND player_id=?").bind(f.id).first(),null);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM auth_session WHERE player_id=? AND provider='google'").bind(f.id).first()).n,0);
  }
});
test('provider link cannot open a new session after admin revokes between identity insert and session publication',async()=>{
  const f=await fixture(),token=await ownerToken(f),body=await proof(f,'link',token);
  const denied=await request('/api/auth/provider/google',body,token,reset(f,'sessionInsert'));assert.equal(denied.status,401);await noLiveSession(f.id);
  assert.equal((await db.prepare("SELECT player_id FROM auth_identity WHERE provider='google' AND subject=?").bind(f.googleSubject).first()).player_id,f.id);
});
test('email link cannot recreate credentials after its initiating owner is revoked',async()=>{
  const f=await fixture({email:false,google:true}),token=await ownerToken(f);
  const denied=await request('/api/auth/link/email',{email:f.subject,password},token,{hook:'identityInsert',action:'move',args:{id:f.destination,sourceId:f.id,provider:'google',operationId:'email-link-race-'+f.n}});
  assert.equal(denied.status,401);assert.equal(await db.prepare("SELECT subject FROM auth_identity WHERE player_id=? AND provider='email'").bind(f.id).first(),null);await noLiveSession(f.id);
});
test('email link resume cannot issue a session with the password reset during its read',async()=>{
  const f=await fixture(),token=await ownerToken(f);
  const denied=await request('/api/auth/link/email',{email:f.subject,password},token,reset(f,'passwordRead'));assert.equal(denied.status,401);await noLiveSession(f.id);
});
test('unchanged credentials and verified provider links still produce usable native sessions',async()=>{
  const f=await fixture(),token=await ownerToken(f),body=await proof(f,'link',token);
  const linked=await request('/api/auth/provider/google',body,token);assert.equal(linked.status,200);assert.equal(linked.body.playerId,f.id);
  const protectedResponse=await worker.fetch('https://synthetic.test/protected',{headers:{Authorization:'Bearer '+linked.body.accessToken}});assert.equal(protectedResponse.status,200);
  const retry=await request('/api/auth/provider/google',body,token);assert.equal(retry.status,200);assert.equal(retry.body.refreshToken,linked.body.refreshToken);
  const email=await request('/api/auth/link/email',{email:f.subject,password},token);assert.equal(email.status,200);
  const emailRetry=await request('/api/auth/link/email',{email:f.subject,password},token);assert.equal(emailRetry.status,200);assert.equal(emailRetry.body.refreshToken,email.body.refreshToken);
  assert.ok(requests.length>0);assert.ok(requests.every(url=>url==='https://www.googleapis.com/oauth2/v3/certs'));
});
