import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let feature;
before(async () => {
  const result = await build({ entryPoints: ['src/liveops/story-test.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  feature = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});
const config = () => ({ STORY_TEST_ENABLED: 'true', STORY_TEST_PLAYERS: 'synthetic-developer', STORY_TEST_COUPON: 'DEV-STORY' });

test('diagnostic coupon is disabled unless explicitly configured and enabled', () => {
  assert.equal(feature.checkStoryTestCode({}, 'synthetic-developer', 'DEV-STORY'), null);
  assert.throws(() => feature.checkStoryTestCode({ ...config(), STORY_TEST_ENABLED: 'false' }, 'synthetic-developer', 'DEV-STORY'), e => e.message === 'coupon_unavailable');
});
test('unpublished code is not authorization for another account', () => {
  assert.throws(() => feature.startStoryTest(config(), 'synthetic-other', 'DEV-STORY'), e => e.message === 'coupon_unavailable');
  assert.throws(() => feature.startStoryTest({ ...config(), STORY_TEST_PLAYERS: '' }, 'synthetic-developer', 'DEV-STORY'));
});
test('normal coupons are not intercepted and checks create no run or reward grant', () => {
  assert.equal(feature.checkStoryTestCode(config(), 'synthetic-developer', 'NORMAL-REWARD'), null);
  const result = feature.checkStoryTestCode(config(), 'synthetic-developer', '  dev-story ');
  assert.deepEqual(result, { eligible: true, claimed: false, diagnostic: 'full-story', playerId: 'synthetic-developer' });
  assert.equal(result.runId, undefined); assert.equal(result.grant, undefined);
});
test('explicit starts are repeatable for the developer and get separate reports', () => {
  const a = feature.startStoryTest(config(), 'synthetic-developer', 'DEV-STORY');
  const b = feature.startStoryTest(config(), 'synthetic-developer', 'DEV-STORY');
  assert.notEqual(a.runId, b.runId); assert.equal(a.speed, 20); assert.equal(a.playerId, 'synthetic-developer');
  assert.throws(() => feature.startStoryTest(config(), 'synthetic-developer', 'UNKNOWN'));
});
test('reports are stored under authenticated identity without gameplay save writes', async () => {
  const writes = [];
  const env = { ...config(), AUDIT_BLOBS: { put: async (...args) => writes.push(args) } };
  const run = feature.startStoryTest(env, 'synthetic-developer', 'DEV-STORY');
  const result = await feature.storeStoryTestReport(env, 'synthetic-developer', { runId: run.runId, report: { passed: false, playerId: 'forged-path', errors: ['fixture'] } });
  assert.equal(result.saved, true); assert.equal(writes.length, 1);
  assert.equal(writes[0][0], `story-tests/synthetic-developer/${run.runId}/result.json`);
  assert.equal(JSON.parse(writes[0][1]).playerId, 'synthetic-developer');
  await assert.rejects(() => feature.storeStoryTestReport(env, 'synthetic-other', { runId: run.runId, report: {} }));
  assert.equal(writes.length, 1);
});
test('malformed, oversized and path-traversal reports are rejected', async () => {
  const env = { ...config(), AUDIT_BLOBS: { put: async () => { throw Error('must not write'); } } };
  const run = feature.startStoryTest(env, 'synthetic-developer', 'DEV-STORY');
  for (const body of [null, { runId: '../other', report: {} }, { runId: run.runId, report: [] }, { runId: run.runId, report: { errors: 'x'.repeat(270 * 1024) } }])
    await assert.rejects(() => feature.storeStoryTestReport(env, 'synthetic-developer', body));
});
