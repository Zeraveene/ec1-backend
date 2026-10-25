import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { readPlayFab } from './playfab';
import { validateCanonicalSnapshot } from '../game/backups';
import { GameError, sha256, stableJson } from '../game/validation';

type Migration = {player_id:string;source_hash:string;archive_key:string;raw_save_hash:string;revision:number|null;completed_at:number|null};
async function record(env:Env,id:string){return env.DB.prepare('SELECT * FROM classic_migration WHERE player_id=?').bind(id).first<Migration>();}
async function source(env:Env,row:Migration){
 const object=await env.LEGACY_ARCHIVE.get(row.archive_key);
 if(!object)throw new GameError('legacy_archive_unavailable',503);
 const text=await object.text();
 if(await sha256(text)!==row.source_hash)throw new GameError('legacy_archive_integrity_failure',503);
 let archive:any;try{archive=JSON.parse(text);}catch{throw new GameError('legacy_archive_integrity_failure',503);}
 const raw=archive.userData?.Data?.CLOUD_ALL_DATA?.Value;
 if(await sha256(typeof raw==='string'?raw:'')!==row.raw_save_hash)throw new GameError('legacy_archive_integrity_failure',503);
 const data=archive.userData?.Data;
 if(data!==null&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===0)return {hasCloudSave:false as const,playerId:row.player_id,sourceHash:row.source_hash};
 if(typeof raw!=='string'||!raw.length)throw new GameError('legacy_cloud_save_missing',409);
 return {hasCloudSave:true as const,playerId:row.player_id,sourceHash:row.source_hash,rawSaveJson:raw,legacyPlaytime:archive.userData?.Data?.Playtime?.Value??null};
}
export async function classicMigrationSource(env:Env,id:string){
 let row=await record(env,id);if(row)return source(env,row);
 const userData=await readPlayFab(env,'Server/GetUserData',{PlayFabId:id});
 const raw=userData.Data?.CLOUD_ALL_DATA?.Value;
 const archive=stableJson({game:'ec1',playerId:id,userData}),hash=await sha256(archive),rawHash=await sha256(typeof raw==='string'?raw:'');
 const key=`ec1/classic-migration/${encodeURIComponent(id)}/${crypto.randomUUID()}/${hash}.json`;
 await env.LEGACY_ARCHIVE.put(key,archive,{httpMetadata:{contentType:'application/json'}});
 const staged=await env.LEGACY_ARCHIVE.get(key);
 if(!staged||await sha256(await staged.text())!==hash)throw new GameError('legacy_archive_verification_failed',503);
 await env.DB.prepare('INSERT OR IGNORE INTO classic_migration(player_id,source_hash,archive_key,raw_save_hash,created_at) VALUES(?,?,?,?,?)').bind(id,hash,key,rawHash,Date.now()).run();
 row=await record(env,id);if(!row)throw new GameError('legacy_archive_publication_failed',503);
 return source(env,row);
}
async function imported(env:Env,id:string){
 const row=await env.DB.prepare("SELECT r.* FROM classic_migration m JOIN classic_backup_revision r ON r.player_id=m.player_id AND r.revision=m.revision WHERE m.player_id=? AND r.source='playfab_migration'").bind(id).first<any>();
 if(!row)return null;
 return {playerId:id,exists:true,revision:row.revision,playtime:row.playtime,schemaVersion:row.schema_version,sha256:row.sha256,bytes:row.bytes,createdAt:row.created_at,operationId:row.operation_id};
}
export async function importClassicMigration(env:Env,id:string,b:any){
 const row=await record(env,id);if(!row)throw new GameError('migration_source_required',409);
 if(!b||b.sourceHash!==row.source_hash||b.expectedRevision!==0)throw new GameError('migration_source_mismatch',409);
 const original=await source(env,row); // Verify preserved original on every retry before publication.
 if(!original.hasCloudSave)throw new GameError('legacy_cloud_save_absent',409);
 const snapshot=validateCanonicalSnapshot(b.snapshotJson),hash=await sha256(snapshot.json);
 const prior=await imported(env,id);if(prior){if(prior.sha256!==hash)throw new GameError('migration_already_imported',409);return prior;}
 const existing=await env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first();if(existing)throw new GameError('revision_conflict',409);
 const operation='legacy-'+row.source_hash,key=`ec1/manual/${encodeURIComponent(id)}/${crypto.randomUUID()}/${hash}.json`,now=Date.now();
 await env.PLAYER_SAVES.put(key,snapshot.json,{httpMetadata:{contentType:'application/json'}});
 const staged=await env.PLAYER_SAVES.get(key);if(!staged||await sha256(await staged.text())!==hash)throw new GameError('backup_stage_verification_failed',503);
 try{await env.DB.batch([
 env.DB.prepare("INSERT INTO classic_backup_revision(player_id,revision,r2_key,sha256,bytes,schema_version,playtime,created_at,operation_id,request_hash,source) SELECT ?,1,?,?,?,1,?,?,?,?,'playfab_migration' WHERE NOT EXISTS(SELECT 1 FROM classic_backup_head WHERE player_id=?) AND EXISTS(SELECT 1 FROM classic_migration WHERE player_id=? AND source_hash=? AND revision IS NULL)").bind(id,key,hash,snapshot.bytes,snapshot.playtime,now,operation,row.source_hash,id,id,row.source_hash),
 env.DB.prepare('INSERT INTO classic_backup_head(player_id,revision) SELECT player_id,revision FROM classic_backup_revision WHERE player_id=? AND revision=1 AND operation_id=? ON CONFLICT(player_id) DO NOTHING').bind(id,operation),
 env.DB.prepare("UPDATE classic_migration SET revision=1 WHERE player_id=? AND source_hash=? AND revision IS NULL AND EXISTS(SELECT 1 FROM classic_backup_revision WHERE player_id=? AND revision=1 AND operation_id=? AND sha256=?)").bind(id,row.source_hash,id,operation,hash)
 ]);}catch{const winner=await imported(env,id);if(winner?.sha256===hash)return winner;const head=await env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first();if(head)throw new GameError('revision_conflict',409);throw new GameError('backup_publication_unavailable',503);}
 const committed=await imported(env,id);if(!committed||committed.sha256!==hash)throw new GameError('revision_conflict',409);return committed;
}
export async function verifyClassicMigrationImported(env:Env,id:string){
 const backup=await imported(env,id);if(!backup)throw new GameError('migration_not_imported',409);
 const original=await record(env,id);if(!original)throw new GameError('migration_source_required',409);if(!(await source(env,original)).hasCloudSave)throw new GameError('legacy_cloud_save_absent',409);
 const revision=await env.DB.prepare('SELECT r2_key FROM classic_backup_revision WHERE player_id=? AND revision=?').bind(id,backup.revision).first<{r2_key:string}>();
 const object=revision?await env.PLAYER_SAVES.get(revision.r2_key):null;if(!object)throw new GameError('backup_storage_unavailable',503);const json=await object.text();if(await sha256(json)!==backup.sha256||new TextEncoder().encode(json).length!==backup.bytes)throw new GameError('backup_integrity_failure',503);
 return backup;
}
// Empty legacy accounts may establish their native identity without fabricating a backup.
export async function verifyClassicMigrationForCutover(env:Env,id:string){
 const row=await record(env,id);if(!row)throw new GameError('migration_source_required',409);
 const original=await source(env,row);
 if(original.hasCloudSave)return {hasCloudSave:true as const,...await verifyClassicMigrationImported(env,id)};
 const head=await env.DB.prepare('SELECT revision FROM classic_backup_head WHERE player_id=?').bind(id).first();
 const revision=await env.DB.prepare('SELECT 1 FROM classic_backup_revision WHERE player_id=? LIMIT 1').bind(id).first();
 if(row.revision!==null||head||revision)throw new GameError('revision_conflict',409);
 return {hasCloudSave:false as const,playerId:id,sourceHash:row.source_hash};
}
// Auth finalize composes these statements into its identity-link transaction.
export function classicMigrationCompletionStatements(env:Env,id:string,revision:number):D1PreparedStatement[]{
 return [
 env.DB.prepare('UPDATE classic_migration SET completed_at=COALESCE(completed_at,?) WHERE player_id=? AND revision=?').bind(Date.now(),id,revision),
 env.DB.prepare("UPDATE player SET save_state='migrated',migrated_at=COALESCE(migrated_at,?),updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM classic_migration WHERE player_id=? AND completed_at IS NOT NULL)").bind(Math.floor(Date.now()/1000),Math.floor(Date.now()/1000),id,id),
 env.DB.prepare("UPDATE auth_session SET revoked_at=? WHERE player_id=? AND scope='migration' AND revoked_at IS NULL").bind(Math.floor(Date.now()/1000),id)
 ];
}
export function createClassicMigrationApp(){
 const app=new Hono<AppEnv>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.post('/source',async c=>{const p=c.get('player');if(p.scope!=='migration'&&!await record(c.env,p.playerId))throw new GameError('migration_proof_required',403);return c.json(await classicMigrationSource(c.env,p.playerId));});
 app.post('/import',async c=>{let b:any;try{b=await c.req.json();}catch{throw new GameError('invalid_request');}return c.json(await importClassicMigration(c.env,c.get('player').playerId,b));});
 app.post('/complete',async c=>{
 const p=c.get('player');if(p.scope!=='player')throw new GameError('native_authentication_required',403);
 const identity=await c.env.DB.prepare("SELECT 1 FROM auth_identity WHERE player_id=? AND provider<>'guest'").bind(p.playerId).first();if(!identity)throw new GameError('durable_identity_required',403);
 const backup=await verifyClassicMigrationImported(c.env,p.playerId);
 await c.env.DB.batch(classicMigrationCompletionStatements(c.env,p.playerId,backup.revision));return c.json({complete:true,playerId:p.playerId,revision:backup.revision});
 });return app;
}
