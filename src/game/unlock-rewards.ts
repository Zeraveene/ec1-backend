/** Permanent ownership rewards, never inventory entries or store purchase proofs. */
export const unlockRewards: Record<string, { name: string; flags: string[] }> = {
  louisaUnlock: { name: 'Louisa Unlock', flags: ['louisaUnlock'] },
  soulUnlock: { name: 'Soul Unlock', flags: ['soulUnlock'] },
  premium: { name: 'Premium Service', flags: ['premium'] },
  more_exp: { name: 'EXP Boost', flags: ['more_exp'] },
  double_loot: { name: 'Drop Boost', flags: ['double_loot'] },
  booster_pack: { name: 'Dual Boost', flags: ['more_exp', 'double_loot', 'dualTaken'] },
};
export function unlockReward(id: string) {
  return Object.hasOwn(unlockRewards, id) ? unlockRewards[id] : undefined;
}
