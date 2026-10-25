import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
let mf,db,worker;const actor={id:'111111111111111111',name:'Synthetic Admin'};
before(async()=>{
 const bundle=await build({stdin:{contents:`import {Hono} from 'hono';import {createNewsApp,dispatchNewsAdmin} from './src/liveops/news';import {signToken} from './src/auth/crypto';const app=new Hono();app.route('/api/liveops/news',createNewsApp());app.post('/test/admin',async c=>{const b=await c.req.json();return c.json(await dispatchNewsAdmin(c.env,b.actor,b.role,b.operation,b.args));});app.get('/test/token/:id',async c=>c.json({token:await signToken(c.env.PLAYER_TOKEN_SECRET,{sub:c.req.param('id'),sid:c.req.param('id'),provider:'email',scope:'player',deviceId:null})}));export default app;`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'news-test'},bindings:{PLAYER_TOKEN_SECRET:'synthetic-news-test-key'},outboundService:()=>{throw new Error('Unexpected network call');}}));db=await mf.getD1Database('DB');worker=await mf.getWorker();
 for(const file of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort())await db.exec((await readFile(`migrations/${file}`,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 for(const id of ['player-a','player-b']){await db.prepare('INSERT INTO player(id,created_at,updated_at) VALUES (?,1,1)').bind(id).run();await db.prepare("INSERT INTO auth_session(id,player_id,provider,scope,created_at,expires_at) VALUES (?,?,'email','player',1,9999999999)").bind(id,id).run();}
});
after(async()=>await mf?.dispose());
async function admin(operation,args,role='manager'){return (await worker.fetch('https://synthetic.test/test/admin',{method:'POST',body:JSON.stringify({actor,role,operation,args})})).json();}
const post=(id,extra={})=>({id,titles:{en:'Announcement',id:'Berita'},bodies:{en:'Plain text news'},publishAt:null,expireAt:null,pinned:false,draft:true,order:0,rewards:[{id:'gold',amount:10}],...extra});
async function publicGet(path=''){const r=await worker.fetch('https://synthetic.test/api/liveops/news'+path);return {status:r.status,body:await r.json()};}
async function playerPost(id,path,body={}){const {token}=await(await worker.fetch('https://synthetic.test/test/token/'+id)).json();const r=await worker.fetch('https://synthetic.test/api/liveops/news'+path,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
test('public schedule, drafts, expiration and bounded list/detail agree',async()=>{
 for(const [id,extra]of [['draft',{}],['future',{draft:false,publishAt:'2099-01-01T00:00:00Z'}],['expired',{draft:false,expireAt:'2000-01-01T00:00:00Z'}],['live',{draft:false}],['pinned',{draft:false,pinned:true}]])assert.equal((await admin('news.create',{operationId:'create-'+id,post:post(id,extra)})).status,201);
 const listed=await publicGet('?limit=1');assert.equal(listed.status,200);assert.deepEqual(listed.body.news.map(x=>x.id),['pinned']);assert.equal(listed.body.news[0].bodies,undefined);assert.ok(listed.body.nextCursor);assert.deepEqual((await publicGet('?limit=1&cursor='+listed.body.nextCursor)).body.news.map(x=>x.id),['live']);
 for(const id of ['draft','future','expired'])assert.equal((await publicGet('/'+id)).status,404);assert.equal((await publicGet('/live')).status,200);
 for(const q of ['?limit=101','?limit=0','?cursor=-1','?cursor=garbage'])assert.equal((await publicGet(q)).status,400);
});
test('roles, immutable IDs, bounded content, reward validation and optimistic revision',async()=>{
 assert.equal((await admin('news.list',{},'guest')).status,200);assert.equal((await admin('news.create',{operationId:'guest',post:post('guest')},'guest')).status,403);
 for(const p of [post('bad-html',{bodies:{en:'<script>bad</script>'}}),post('bad-lang',{titles:{en:'x',fr:'x'}}),post('bad-size',{bodies:{en:'x'.repeat(20001)}}),post('bad-reward',{rewards:[{id:'unknown',amount:1}]}),post('bad-date',{publishAt:'2026-10-25'})])assert.equal((await admin('news.create',{operationId:p.id,post:p})).status,400);
 assert.equal((await admin('news.update',{operationId:'conflict',id:'live',expectedRevision:99,post:post('live')})).status,409);
 assert.equal((await admin('news.update',{operationId:'rename',id:'live',expectedRevision:1,post:post('rename')})).status,400);
});
test('admin operation replay is durable, audit atomic, concurrency has one winner',async()=>{
 const args={id:'live',expectedRevision:1,operationId:'publish-live',published:true};const first=await admin('news.publish',args);assert.equal(first.status,200);assert.deepEqual(await admin('news.publish',args),first);assert.equal((await admin('news.publish',{...args,published:false})).status,409);
 assert.equal((await db.prepare("SELECT count(*) AS n FROM admin_audit WHERE action='news.publish'").first()).n,1);
 const raced=await Promise.all(['a','b'].map(x=>admin('news.publish',{id:'live',expectedRevision:2,operationId:'race-'+x,published:true})));assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);
 const before=(await db.prepare('SELECT count(*) AS n FROM liveops_news').first()).n;
 await db.prepare("CREATE TRIGGER news_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action='news.create' BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END").run();assert.equal((await admin('news.create',{operationId:'audit-fail',post:post('audit-fail')})).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM liveops_news').first()).n,before);assert.equal(await db.prepare("SELECT * FROM liveops_news_operation WHERE operation_id='audit-fail'").first(),null);await db.prepare('DROP TRIGGER news_audit_failure').run();
});
test('authenticated reads and concurrent claims issue one immutable receipt, recover after archive and isolate owners',async()=>{
 assert.equal((await worker.fetch('https://synthetic.test/api/liveops/news/live/read',{method:'POST'})).status,401);
 assert.equal((await playerPost('player-a','/draft/read')).status,404);assert.equal((await playerPost('player-a','/live/read')).status,200);assert.equal((await playerPost('player-a','/live/read')).status,200);assert.equal((await db.prepare('SELECT count(*) AS n FROM liveops_news_read').first()).n,1);
 const claims=await Promise.all(['one','two'].map(operationId=>playerPost('player-a','/live/claim',{operationId})));assert.equal(claims[0].status,200);assert.equal(claims[0].body.receipt.id,claims[1].body.receipt.id);assert.deepEqual(claims[0].body.receipt.rewards,[{id:'gold',amount:10}]);
 const detail=await admin('news.detail',{id:'live'});assert.equal((await admin('news.archive',{id:'live',expectedRevision:detail.body.news.revision,operationId:'archive-live'})).status,200);assert.equal((await publicGet('/live')).status,404);
 const recovered=await playerPost('player-a','/live/claim',{operationId:'retry'});assert.equal(recovered.body.receipt.id,claims[0].body.receipt.id);assert.equal((await playerPost('player-b','/live/claim',{operationId:'other'})).status,404);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM save_revision').first()).n,0);assert.equal((await db.prepare("SELECT save_version FROM player WHERE id='player-a'").first()).save_version,0);
});
test('reorder is all-or-nothing and archived receipts cannot be reset',async()=>{
 const pinned=(await admin('news.detail',{id:'pinned'})).body.news;const draft=(await admin('news.detail',{id:'draft'})).body.news;
 assert.equal((await admin('news.reorder',{operationId:'bad-order',items:[{id:'pinned',expectedRevision:pinned.revision,order:7},{id:'draft',expectedRevision:99,order:8}]})).status,409);assert.equal((await admin('news.detail',{id:'pinned'})).body.news.order,pinned.order);
 assert.equal((await admin('news.reorder',{operationId:'order',items:[{id:'pinned',expectedRevision:pinned.revision,order:7},{id:'draft',expectedRevision:draft.revision,order:8}]})).status,200);
 const live=(await admin('news.detail',{id:'live'})).body.news;assert.equal((await admin('news.publish',{id:'live',expectedRevision:live.revision,operationId:'unarchive',published:true})).status,409);
});
test('issued claims survive reward edits, unpublication and expiry; maximum reorder stays bounded',async()=>{
 assert.equal((await admin('news.create',{operationId:'create-recovery',post:post('recovery',{draft:false})})).status,201);
 const issued=await playerPost('player-a','/recovery/claim',{operationId:'issue'});assert.equal(issued.status,200);
 assert.equal((await admin('news.update',{id:'recovery',expectedRevision:1,operationId:'expire-recovery',post:post('recovery',{draft:true,expireAt:'2000-01-01T00:00:00Z',rewards:[{id:'ruby',amount:999}]})})).status,200);
 assert.deepEqual((await playerPost('player-a','/recovery/claim',{operationId:'recover'})).body.receipt,issued.body.receipt);
 assert.equal((await playerPost('player-b','/recovery/claim',{operationId:'not-issued'})).status,404);
 const items=[];
 for(let i=0;i<100;i++){const id='bulk-'+i;await db.prepare("INSERT INTO liveops_news(id,titles_json,bodies_json,created_at,updated_at) VALUES (?, '{\"en\":\"Synthetic\"}', '{\"en\":\"Body\"}', 1,1)").bind(id).run();items.push({id,expectedRevision:1,order:i});}
 assert.equal((await admin('news.reorder',{operationId:'max-reorder',items})).status,200);assert.equal((await admin('news.reorder',{operationId:'oversize-reorder',items:[...items,{id:'live',expectedRevision:1,order:0}]})).status,400);
});

test('runtime invalid roles are denied for reads and writes',async()=>{
 for(const role of [null,'owner','',{},[],123])for(const [operation,args]of [['news.list',{}],['news.detail',{id:'draft'}],['news.create',{operationId:'invalid-role',post:post('invalid-role')}]])assert.equal((await admin(operation,args,role)).status,403);
});

test('duplicate rewards are rejected and banned sessions retain typed 403 errors',async()=>{
 const duplicate=post('duplicates',{rewards:[{id:'gold',amount:1},{id:'gold',amount:1}]});assert.equal((await admin('news.create',{operationId:'duplicates-create',post:duplicate})).status,400);
 const draft=(await admin('news.detail',{id:'draft'})).body.news;assert.equal((await admin('news.update',{id:'draft',expectedRevision:draft.revision,operationId:'duplicates-update',post:{...duplicate,id:'draft'}})).status,400);
 await db.prepare("INSERT INTO player_ban(player_id,reason,created_at) VALUES ('player-b','Synthetic ban',1)").run();
 for(const path of ['/pinned/read','/pinned/claim']){const result=await playerPost('player-b',path,{operationId:'banned'});assert.equal(result.status,403);assert.deepEqual(result.body,{error:'player_banned'});}
 await db.prepare("DELETE FROM player_ban WHERE player_id='player-b'").run();
});

test('player read and claim enforce a 4KiB body limit',async()=>{
 for(const path of ['/pinned/read','/pinned/claim']){const response=await playerPost('player-a',path,{operationId:'size-limit',padding:'x'.repeat(4096)});assert.equal(response.status,413);assert.deepEqual(response.body,{error:'request_too_large'});}
});
