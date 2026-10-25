import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
test('expired credential proofs are cleaned in bounded batches while live attempts survive', async () => {
  const built = await build({stdin:{resolveDir:process.cwd(),contents:"import {cleanupAuthState} from './src/auth/maintenance';export default {async fetch(req,env){await cleanupAuthState(env,2);return new Response('ok')}}"},bundle:true,write:false,format:'esm',platform:'browser'});
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-06',d1Databases:{DB:'proof-cleanup'}}));
  try {
    const db=await mf.getD1Database('DB');
    for(const file of ['001_auth.sql','027_classic_auth_proof.sql']) await db.exec((await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
    const now=Math.floor(Date.now()/1000);
    for(let i=0;i<6;i++) await db.prepare("INSERT INTO classic_auth_proof(id,player_id,provider,subject,password_hash,salt,expires_at,created_at) VALUES(?,?,'email',?,'synthetic-digest','synthetic-salt',?,?)").bind('proof-'+i,'player-'+i,'email-'+i,i<3?now-100+i:now+100,now-200).run();
    assert.equal((await mf.dispatchFetch('https://test/cleanup')).status,200);
    assert.equal((await db.prepare('SELECT count(*) n FROM classic_auth_proof WHERE expires_at<=?').bind(now).first()).n,1);
    assert.equal((await db.prepare('SELECT count(*) n FROM classic_auth_proof WHERE expires_at>?').bind(now).first()).n,3);
    await mf.dispatchFetch('https://test/cleanup');
    assert.equal((await db.prepare('SELECT count(*) n FROM classic_auth_proof').first()).n,3);
  } finally { await mf.dispose(); }
});
