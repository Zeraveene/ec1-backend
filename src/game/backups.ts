import { validateOwnership, ownershipEnvelope, prepareOwnership, checkOwnership } from './ownership';
import schema from "./canonical-schema.json";
import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { GameError, objectJson, sha256, stableJson } from "./validation";

type Row = { revision:number; r2_key:string; sha256:string; bytes:number; schema_version:number; playtime:number; created_at:number; operation_id:string; request_hash:string; save_id?:string|null };
async function metadata(env:Env,playerId:string,row:Row) {
  return {ownership:await ownershipEnvelope(env,playerId,row.save_id),playerId,exists:true,revision:row.revision,playtime:row.playtime,schemaVersion:row.schema_version,sha256:row.sha256,bytes:row.bytes,createdAt:row.created_at,operationId:row.operation_id};
}
// Shape parity with SaveMigration.ValidateModernShape; catalog hydration remains client-owned.
function validateShape(value:any, kind:string, path:string, nullable=false):void {
 const fail=()=>{throw new GameError("malformed_snapshot",400,path);};
 if(value===null){if(nullable)return;fail();}
 if(value===undefined)fail();
 if(kind==='int'||['Rarity','EquipmentType','ItemType'].includes(kind)){if(!Number.isInteger(value)||value < -2147483648||value>2147483647)fail();return;}
 if(kind==='float'){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>3.4028234663852886e38)fail();return;}
 if(kind==='string'||kind==='bool'){if(typeof value!==(kind==='bool'?'boolean':'string'))fail();return;}
 const list=/^List<(.+)>$/.exec(kind),dict=/^Dictionary<string,\s*(.+)>$/.exec(kind);
 if(list){if(!Array.isArray(value)||value.length>10000)fail();for(const v of value)validateShape(v,list[1],path+'[]');return;}
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 if(dict){for(const [k,v] of Object.entries(value))validateShape(v,dict[1],path+'.'+k);return;}
 const fields=(schema as Record<string,Record<string,string>>)[kind];if(!fields)fail();
 const gear=['id','mainOption1','mainOption2','enhanceLevel','subOption1','subOption2','subOption3','socket1','socket2'];
 for(const [k,t]of Object.entries(fields)){
  if(kind==='GameSaveRecord'&&k==='ownership')continue;
  if((kind==='EquipmentRecord'||kind==='ItemRecord')&&value.definition===true&&!(kind==='EquipmentRecord'?gear:['id','amount']).includes(k))continue;
  validateShape(value[k],t,path+'.'+k,t==='FortressSaveRecord'||t==='ItemRecord'||(['EquipmentRecord','ItemRecord'].includes(kind)&&t==='string'&&k!=='id'));
 }
}
export function validateCanonicalSnapshot(json:unknown): {json:string;playtime:number;bytes:number} {
  if(typeof json!=="string") throw new GameError("malformed_snapshot");
  const bytes=new TextEncoder().encode(json).length;
  if(bytes>2_000_000) throw new GameError("snapshot_too_large",413);
  // Bound nesting before parsing to avoid pathological recursive validation.
  let depth=0,quoted=false,escape=false;
  for(const c of json) { if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='['){if(++depth>64)throw new GameError("malformed_snapshot",400,"nesting_limit");}else if(c==='}'||c===']')depth--; }
  let s:any;
  try{s=objectJson(json,"snapshot");}catch{throw new GameError("malformed_snapshot");}
  if(s.schemaVersion!==1) throw new GameError("unsupported_save_schema");
  validateShape(s,'GameSaveRecord','snapshot');
  validateOwnership(s.ownership);
  const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
  for(const key of ['progress','consumableSlots','inventory','daily','unlocks','purchases','profile','preferences'])
    if(!object(s[key])) throw new GameError("incomplete_snapshot",400,key);
  if(!Array.isArray(s.characters)||s.characters.length!==4||!Array.isArray(s.achievements)||s.achievements.length!==27||!Array.isArray(s.daily.quests)||s.daily.quests.length!==3||!Array.isArray(s.progress.stageInfo)||!Array.isArray(s.progress.usedCoupons)) throw new GameError("incomplete_snapshot");
  if(!Number.isFinite(s.progress.timeCounter)||s.progress.timeCounter<0) throw new GameError("malformed_snapshot",400,"progress.timeCounter");
  for(let i=0;i<4;i++){const c=s.characters[i];if(!object(c)||c.character!==i||!['top','glove','shoes','weapon'].every(k=>object(c[k])))throw new GameError("incomplete_snapshot",400,"characters");}
  // Credentials and unsafe JS keys have no place in a gameplay snapshot. Unknown gameplay fields survive ownership stamping.
  const visit=(v:any):void=>{if(typeof v==='number'&&!Number.isFinite(v))throw new GameError("malformed_snapshot");if(v&&typeof v==='object')for(const [key,value]of Object.entries(v)){if(/^(?:__proto__|prototype|constructor|PF_.*|GPGS_.*|EC1_BACKEND.*)$|password|sessionticket|accesstoken|refreshtoken|secret/i.test(key))throw new GameError("malformed_snapshot",400,"credential_fields_forbidden");visit(value);}};
  visit(s);
  return {json,playtime:s.progress.timeCounter,bytes};
}
async function revision(env:Env,id:string,n:number){return env.DB.prepare('SELECT * FROM classic_backup_revision WHERE player_id=? AND revision=?').bind(id,n).first<Row>();}
export function createBackupsApp(){
 const app=new Hono<AppEnv>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');if(c.env.EC1_MANUAL_BACKUPS_ENABLED!=='true')throw new GameError('manual_backups_disabled',503);if(c.get('player').scope!=='player')throw new GameError('insufficient_scope',403);await next();});
 app.get('/latest',async c=>{const id=c.get('player').playerId;const row=await c.env.DB.prepare('SELECT r.* FROM classic_backup_head h JOIN classic_backup_revision r ON r.player_id=h.player_id AND r.revision=h.revision WHERE h.player_id=?').bind(id).first<Row>();return c.json(row?await metadata(c.env,id,row):{playerId:id,exists:false,revision:0});});
 app.get('/revisions/:revision',async c=>{const n=Number(c.req.param('revision'));if(!Number.isSafeInteger(n)||n<1)throw new GameError('invalid_revision');const id=c.get('player').playerId,row=await revision(c.env,id,n);if(!row)throw new GameError('backup_not_found',404);const obj=await c.env.PLAYER_SAVES.get(row.r2_key);if(!obj)throw new GameError('backup_storage_unavailable',503);const json=await obj.text();if(await sha256(json)!==row.sha256||new TextEncoder().encode(json).length!==row.bytes)throw new GameError('backup_integrity_failure',503);return c.json({...await metadata(c.env,id,row),snapshotJson:json});});
 app.put('/latest',async c=>{
  let b:any;try{b=await c.req.json();}catch{throw new GameError('invalid_request');}
  if(!b||b.game!=='ec1'||b.schemaVersion!==1)throw new GameError('unsupported_save_schema');
  if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||typeof b.operationId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(b.operationId))throw new GameError('invalid_backup_envelope');
  const s=validateCanonicalSnapshot(b.snapshotJson),id=c.get('player').playerId;
  const requestHash=await sha256(stableJson({expectedRevision:b.expectedRevision,operationId:b.operationId,snapshotJson:s.json}));
  const replay=async()=>{const row=await c.env.DB.prepare('SELECT * FROM classic_backup_revision WHERE player_id=? AND operation_id=?').bind(id,b.operationId).first<Row>();if(row&&row.request_hash!==requestHash)throw new GameError('operation_id_reused',409);return row;};
  const prior=await replay();if(prior)return c.json(await metadata(c.env,id,prior));
  const prepared=await prepareOwnership(c.env,id,s.json),published=prepared.json,ownership=prepared.ownership;
  const head=await c.env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first<{revision:number}>();
  if((head?.revision??0)!==b.expectedRevision)throw new GameError('revision_conflict',409);
  const hash=await sha256(published),key=`ec1/manual/${encodeURIComponent(id)}/${crypto.randomUUID()}/${hash}.json`,n=b.expectedRevision+1,now=Date.now();
  await c.env.PLAYER_SAVES.put(key,published,{httpMetadata:{contentType:'application/json'}});
  const staged=await c.env.PLAYER_SAVES.get(key);if(!staged||await sha256(await staged.text())!==hash)throw new GameError('backup_stage_verification_failed',503);
  try{await c.env.DB.batch([
   c.env.DB.prepare('INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash,save_id) SELECT ?,?,?,?,?,1,?,?,?,?,? WHERE (NOT EXISTS(SELECT 1 FROM classic_save_owner WHERE save_id=?) OR EXISTS(SELECT 1 FROM classic_save_owner WHERE save_id=? AND player_id=?)) AND COALESCE((SELECT revision FROM classic_backup_head WHERE player_id=?),0)=?').bind(id,n,key,hash,new TextEncoder().encode(published).length,s.playtime,now,b.operationId,requestHash,ownership.saveId,ownership.saveId,ownership.saveId,id,id,b.expectedRevision),
   c.env.DB.prepare('INSERT OR IGNORE INTO classic_save_owner(save_id,player_id,claimed_at) SELECT save_id,player_id,created_at FROM classic_backup_revision WHERE player_id=? AND revision=? AND operation_id=? AND request_hash=?').bind(id,n,b.operationId,requestHash),
   c.env.DB.prepare('INSERT INTO classic_backup_head(player_id,revision) SELECT player_id,revision FROM classic_backup_revision WHERE player_id=? AND revision=? AND operation_id=? AND request_hash=? ON CONFLICT(player_id) DO UPDATE SET revision=excluded.revision WHERE classic_backup_head.revision=?').bind(id,n,b.operationId,requestHash,b.expectedRevision)
  ]);}catch{const committed=await replay();if(committed)return c.json(await metadata(c.env,id,committed));const current=await c.env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first<{revision:number}>();if((current?.revision??0)!==b.expectedRevision)throw new GameError('revision_conflict',409);throw new GameError('backup_publication_unavailable',503);}
  const committed=await replay();if(!committed){await checkOwnership(c.env,id,{...ownership,playerId:'',proof:''});throw new GameError('revision_conflict',409);}return c.json(await metadata(c.env,id,committed));
 });
 return app;
}
