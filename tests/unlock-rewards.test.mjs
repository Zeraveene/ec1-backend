import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/game/rewards.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { applyRewards } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('legacy reward projection preserves ownership and applies dual boost as both benefits', () => {
  const data = { CLOUD_ALL_DATA: JSON.stringify({ gamedata: JSON.stringify({ gold: 10, ruby: 20, stat_rubyEarned: 30 }), inventory: '^^', unrelated: 'keep' }) };
  const result = applyRewards(data, [{ id: 'booster_pack', amount: 1 }, { id: 'premium', amount: 1 }, { id: 'louisaUnlock', amount: 1 }, { id: 'soulUnlock', amount: 1 }, { id: 'costume_soul_8', amount: 1 }, { id: 'ruby', amount: 5 }]);
  const prefs = JSON.parse(result.CLOUD_ALL_DATA);
  for (const key of ['more_exp', 'double_loot', 'dualTaken', 'premium', 'louisaUnlock', 'soulUnlock', 'costume_soul_8']) assert.equal(prefs[key], '1');
  assert.equal(prefs.inventory, '^^');
  assert.equal(prefs.unrelated, 'keep');
  assert.equal(JSON.parse(prefs.gamedata).ruby, 25);
  assert.equal(JSON.parse(prefs.gamedata).stat_rubyEarned, 35);
  assert.equal(JSON.parse(data.CLOUD_ALL_DATA).premium, undefined);
  assert.equal(applyRewards(result, [{ id: 'booster_pack', amount: 1 }]).CLOUD_ALL_DATA, result.CLOUD_ALL_DATA);
});
