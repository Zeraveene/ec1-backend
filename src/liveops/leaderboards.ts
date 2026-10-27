import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { requirePlayer } from '../auth';
import { AuthError } from '../auth/providers';

const BOARD = 'infinity_fortress';
type Board = { id:string; season:number; version:number; paused:number; updated_at:number };
class InputError extends Error { constructor(public error:string, public status:400|404|409|413|503=400) { super(error); } }
const q = (env:Env, sql:string, ...values:unknown[]) => env.DB.prepare(sql).bind(...values);
const now = () => Math.floor(Date.now()/1000);
function integer(value:unknown, min:number, max:number):number {
 if(typeof value !== 'number' || !Number.isSafeInteger(value) || value<min || value>max) throw new InputError('invalid_integer');
 return value;
}
function text(value:unknown, max:number):string {
 if(typeof value !== 'string' || !value.length || value.length>max || /[\u0000-\u001f\u007f]/.test(value)) throw new InputError('invalid_text');
 return value;
}
function safeName(value:unknown):string { return typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f<>]/g,'').slice(0,48) : ''; }
async function board(env:Env, id:string):Promise<Board> {
 if(id!==BOARD) throw new InputError('leaderboard_not_found',404);
 const result=await q(env,'SELECT * FROM classic_leaderboard_board WHERE id=?',id).first<Board>();
 if(!result) throw new InputError('leaderboard_unavailable',503);
 return result;
}
async function playerEntry(env:Env,b:Board,season:number,playerId:string) {
 const row=await q(env,`WITH ranked AS (SELECT e.player_id AS playerId,p.display_name AS playerName,e.character,e.floor,e.cleartime,ROW_NUMBER() OVER (ORDER BY e.floor DESC,e.cleartime ASC,e.character DESC,e.player_id ASC) AS rank FROM classic_leaderboard_entry e JOIN player p ON p.id=e.player_id WHERE e.board_id=? AND e.season=? AND ${visible}) SELECT * FROM ranked WHERE playerId=?`,b.id,season,now(),playerId).first<Record<string,unknown>>();
 return row?{playerId:row.playerId,playerName:safeName(row.playerName),record:{character:row.character,floor:row.floor,cleartime:row.cleartime},rank:row.rank}:null;
}
const metadata=(b:Board)=>({board:b.id,season:b.season,version:b.version,submissionPaused:!!b.paused,updatedAt:b.updated_at});
function seasonNumber(value:unknown,b:Board):number { return value===undefined ? b.season : integer(typeof value==='string'?Number(value):value,1,b.season); }
const visible = `NOT EXISTS(SELECT 1 FROM player_ban b WHERE b.player_id=e.player_id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>?))`;
async function page(env:Env,b:Board,season:number,offset:number,limit:number) {
 const rows=await q(env,`SELECT e.player_id AS playerId,p.display_name AS playerName,e.character,e.floor,e.cleartime FROM classic_leaderboard_entry e JOIN player p ON p.id=e.player_id WHERE e.board_id=? AND e.season=? AND ${visible} ORDER BY e.floor DESC,e.cleartime ASC,e.character DESC,e.player_id ASC LIMIT ? OFFSET ?`,b.id,season,now(),limit,offset).all<Record<string,unknown>>();
 return rows.results.map((r,i)=>({playerId:r.playerId,playerName:safeName(r.playerName),record:{character:r.character,floor:r.floor,cleartime:r.cleartime},rank:offset+i+1}));
}
async function rank(env:Env,b:Board,season:number,playerId:string):Promise<number|null> {
 const result=await q(env,`WITH ranked AS (SELECT e.player_id,ROW_NUMBER() OVER (ORDER BY e.floor DESC,e.cleartime ASC,e.character DESC,e.player_id ASC) AS rank FROM classic_leaderboard_entry e JOIN player p ON p.id=e.player_id WHERE e.board_id=? AND e.season=? AND ${visible}) SELECT rank FROM ranked WHERE player_id=?`,b.id,season,now(),playerId).first<{rank:number}>();
 return result?.rank??null;
}
async function boundedJson(request:Request):Promise<Record<string,unknown>> {
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new InputError('json_required');
 const reader=request.body?.getReader(); if(!reader) throw new InputError('invalid_json');
 let size=0; const chunks:Uint8Array[]=[];
 while(true){const item=await reader.read(); if(item.done)break; size+=item.value.length; if(size>4096){await reader.cancel();throw new InputError('payload_too_large',413);}chunks.push(item.value);}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 try {const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new InputError('invalid_json');}
}
async function digest(value:string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join(''); }
export function createLeaderboardsApp() {
 const app=new Hono<AppEnv>();
 app.onError((error,c)=>{if(error instanceof InputError)return c.json({error:error.error},error.status);if(error instanceof AuthError)return c.json({error:error.message},error.status as 400|401|403|503);console.error('leaderboards request failed');return c.json({error:'leaderboard_unavailable'},503);});
 app.get('/boards',async c=>c.json({boards:[metadata(await board(c.env,BOARD))]}));
 app.get('/:board/top',async c=>{const b=await board(c.env,c.req.param('board'));const season=seasonNumber(c.req.query('season'),b);const offset=integer(Number(c.req.query('offset')??0),0,1000000);const limit=integer(Number(c.req.query('limit')??100),1,100);const entries=await page(c.env,b,season,offset,limit);return c.json({...metadata(b),season,entries,nextOffset:entries.length===limit?offset+limit:null});});
 app.get('/:board/players/:playerId',async c=>{const b=await board(c.env,c.req.param('board'));const season=seasonNumber(c.req.query('season'),b);const entry=await playerEntry(c.env,b,season,text(c.req.param('playerId'),128));return c.json({...metadata(b),season,entry});});
 app.get('/:board/around-me',requirePlayer,async c=>{const b=await board(c.env,c.req.param('board'));const season=seasonNumber(c.req.query('season'),b);const radius=integer(Number(c.req.query('radius')??5),0,25);const position=await rank(c.env,b,season,c.get('player').playerId);return c.json({...metadata(b),season,rank:position,entries:position===null?[]:await page(c.env,b,season,Math.max(0,position-1-radius),radius*2+1)});});
 app.post('/:board/submit',requirePlayer,async c=>{
  const b=await board(c.env,c.req.param('board')), body=await boundedJson(c.req.raw);
  if(Object.keys(body).some(k=>!['season','version','operationId','record'].includes(k)))throw new InputError('unknown_submission_field');
  const season=integer(body.season,1,2147483647),version=integer(body.version,1,2147483647),operationId=text(body.operationId,96);
  if(!/^[A-Za-z0-9_-]+$/.test(operationId))throw new InputError('invalid_operation_id');
  const r=body.record as Record<string,unknown>;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['character','floor','cleartime'].includes(k)))throw new InputError('invalid_record');
  const character=integer(r.character,0,3),floor=integer(r.floor,1,2147483647),cleartime=integer(r.cleartime,0,2147483647);
  const player=c.get('player').playerId,hash=await digest(JSON.stringify({version,character,floor,cleartime}));
  const receipt=()=>q(c.env,'SELECT payload_hash,character,floor,cleartime FROM classic_leaderboard_submission WHERE board_id=? AND season=? AND player_id=? AND operation_id=?',b.id,season,player,operationId).first<{payload_hash:string;character:number;floor:number;cleartime:number}>();
  let saved=await receipt();
  if(!saved){
   const limitedAt=Date.now();
   const limiter=await q(c.env,`INSERT INTO liveops_rate_limit(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at`,'leaderboard:'+player,limitedAt+60000,limitedAt,limitedAt).first<{count:number;expires_at:number}>();
   if(!limiter)throw new InputError('leaderboard_unavailable',503);
   if(limiter.count>30){const retryAfterSeconds=Math.max(1,Math.ceil((limiter.expires_at-limitedAt)/1000));c.header('Retry-After',String(retryAfterSeconds));return c.json({error:'rate_limited',retryAfterSeconds},429);}
   await c.env.DB.batch([
    q(c.env,`INSERT OR IGNORE INTO classic_leaderboard_submission SELECT id,season,?,?,?,?,?,?,? FROM classic_leaderboard_board WHERE id=? AND season=? AND version=? AND paused=0 AND NOT EXISTS(SELECT 1 FROM player_ban WHERE player_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))`,player,operationId,hash,character,floor,cleartime,now(),b.id,season,version,player,now()),
    q(c.env,`INSERT INTO classic_leaderboard_entry SELECT board_id,season,player_id,character,floor,cleartime,created_at FROM classic_leaderboard_submission WHERE board_id=? AND season=? AND player_id=? AND operation_id=? AND payload_hash=? ON CONFLICT(board_id,season,player_id) DO UPDATE SET character=excluded.character,floor=excluded.floor,cleartime=excluded.cleartime,updated_at=excluded.updated_at WHERE excluded.floor>classic_leaderboard_entry.floor OR (excluded.floor=classic_leaderboard_entry.floor AND (excluded.cleartime<classic_leaderboard_entry.cleartime OR (excluded.cleartime=classic_leaderboard_entry.cleartime AND excluded.character>classic_leaderboard_entry.character)))`,b.id,season,player,operationId,hash)
   ]);
   saved=await receipt();
  }
  if(!saved){const current=await board(c.env,b.id);throw new InputError(current.paused?'submissions_paused':'leaderboard_version_conflict',409);}
  if(saved.payload_hash!==hash)throw new InputError('operation_conflict',409);
  return c.json({board:b.id,season,operationId,acceptedRecord:{character:saved.character,floor:saved.floor,cleartime:saved.cleartime},entryRank:await rank(c.env,b,season,player)});
 });
 return app;
}

export async function dispatchLeaderboardAdmin(env:Env,actor:{id:string;name:string},role:'internal'|'manager'|'guest',operation:string,args:Record<string,unknown>):Promise<{status:number;body:unknown}> {
 try {
  if(!['internal','manager','guest'].includes(role))return {status:403,body:{error:'forbidden'}};
  if(!operation.startsWith('leaderboards.'))return {status:404,body:{error:'unknown_operation'}};
  const b=await board(env,typeof args.board==='string'?args.board:BOARD);
  if(operation==='leaderboards.status'){const count=await q(env,'SELECT COUNT(*) AS n FROM classic_leaderboard_entry WHERE board_id=? AND season=?',b.id,b.season).first<{n:number}>();return {status:200,body:{...metadata(b),entryCount:count?.n??0}};}
  if(operation==='leaderboards.top'){const season=seasonNumber(args.season,b),offset=integer(args.offset??0,0,1000000),limit=integer(args.limit??50,1,100);const entries=await page(env,b,season,offset,limit);return {status:200,body:{...metadata(b),season,entries,nextOffset:entries.length===limit?offset+limit:null}};}
  if(operation==='leaderboards.history'){const offset=integer(args.offset??0,0,1000000),limit=integer(args.limit??50,1,100);return {status:200,body:{history:(await q(env,'SELECT id,board_id,operation,season,version,paused,actor_id,actor_name,created_at FROM classic_leaderboard_history WHERE board_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',b.id,limit,offset).all()).results}};}
  if(!['leaderboards.pause','leaderboards.reset','leaderboards.season'].includes(operation))return {status:404,body:{error:'unknown_operation'}};
  if(role!=='internal'&&role!=='manager')return {status:403,body:{error:'forbidden'}};
  const expected=integer(args.expectedVersion,1,2147483646);
  const operationId=text(args.operationId,96);if(!/^[A-Za-z0-9_-]+$/.test(operationId))throw new InputError('invalid_operation_id');
  const id=b.id+':'+operationId;
  const hash=await digest(JSON.stringify({operation,actor:actor.id,expected,paused:args.paused??null,season:args.season??null}));
  const previous=await q(env,'SELECT * FROM classic_leaderboard_history WHERE id=?',id).first<Record<string,unknown>>();
  if(previous)return previous.payload_hash===hash?{status:200,body:{board:b.id,season:previous.season,version:previous.version,submissionPaused:!!previous.paused,updatedAt:previous.created_at}}:{status:409,body:{error:'operation_conflict'}};
  if(expected!==b.version)throw new InputError('leaderboard_version_conflict',409);
  const paused=operation==='leaderboards.pause'?(typeof args.paused==='boolean'?Number(args.paused):(()=>{throw new InputError('paused_required');})()):1;
  const season=operation==='leaderboards.pause'?b.season:b.season+1;
  if(args.season!==undefined && args.season!==season)throw new InputError('next_season_required');
  const timestamp=now();
  const results=await env.DB.batch([
   q(env,'UPDATE classic_leaderboard_board SET season=?,version=version+1,paused=?,updated_at=?,last_operation=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM classic_leaderboard_history WHERE id=?)',season,paused,timestamp,id,b.id,expected,id),
   q(env,'INSERT OR IGNORE INTO classic_leaderboard_history SELECT ?,id,?,?,season,version,paused,?,?,? FROM classic_leaderboard_board WHERE id=? AND last_operation=?',id,operation,hash,actor.id,safeName(actor.name),timestamp,b.id,id),
   q(env,`INSERT OR IGNORE INTO admin_audit(id,actor_id,actor_name,action,player_id,detail_json,created_at) SELECT ?,?,?,?,NULL,?,? FROM classic_leaderboard_history WHERE id=? AND payload_hash=?`,id,actor.id,safeName(actor.name),operation,JSON.stringify({board:b.id,expectedVersion:expected}),timestamp*1000,id,hash)
  ]);
  if(!results[0].meta.changes){const replay=await q(env,'SELECT * FROM classic_leaderboard_history WHERE id=?',id).first<Record<string,unknown>>();return replay?.payload_hash===hash?{status:200,body:{board:b.id,season:replay.season,version:replay.version,submissionPaused:!!replay.paused,updatedAt:replay.created_at}}:{status:409,body:{error:replay?'operation_conflict':'leaderboard_version_conflict'}};}
  return {status:200,body:{board:b.id,season,version:expected+1,submissionPaused:!!paused,updatedAt:timestamp}};
 }catch(error){if(error instanceof InputError)return {status:error.status,body:{error:error.error}};throw error;}
}
