export class GameError extends Error {
  constructor(public code: string, public status = 400, public reason?: string, public details?:Record<string,unknown>) { super(code); }
}
export interface Snapshot {
  game: 'ec1'; schemaVersion: 1; playtime: number; data: Record<string, string>;
  expectedSaveVersion: number; operationId: string; deviceId?: string; intent?: 'new_game';
}
const characters = ['alaster', 'edna', 'louisa', 'soul'];
export const legacyKeys = [
  ...characters.map(c => `${c}_attributes`), 'gamedata', 'inventory', 'consumable', 'LastReward', 'LastRewardTime',
  'selected', 'getOffer', 'achievements_new', 'task0_claimed', 'task1_claimed', 'task2_claimed', 'task_all_claimed',
  'dailyBoosterQuota', 'entry_treasure', 'entry_march', 'entry_chaos', 'lbId', 'lbName', 'louisaUnlock', 'soulUnlock',
  'premium', 'more_exp', 'double_loot', 'dualTaken', ...characters.flatMap(c => Array.from({length: 8}, (_, i) => `costume_${c}_${i+1}`)),
];
const strings = new Set([...characters.map(c => `${c}_attributes`), 'gamedata', 'inventory', 'consumable', 'LastRewardTime', 'selected', 'achievements_new', 'lbId', 'lbName']);
export const supplementalIntegers=['elysianTaken','stepUp1','stepUp2','stepUp3','stepUp4','stepUp5','task0','task1','task2','task0_progress','task1_progress','task2_progress','petCombat','marchWave','chaosWave','fortress','legendUnlock','gameclear','difficulty','tutorial_status','tutorial_inventory','tutorial_skill','tutorial_blacksmith','tutorial_merchant','tutorial_companion','dailyReset',...characters.map(c=>`costume_${c}`)];
export const supplementalStrings=['selectedPet','stageEpilog',...characters.map(c=>`transmog_${c}`)];
export const supplementalFloats=['buff_exp_end','buff_loot_end','playtime'];
export const nativeKeys=[...legacyKeys,...supplementalIntegers,...supplementalStrings,...supplementalFloats];
const secretKey = /^(?:PF_|GPGS_|EC1_BACKEND)|password|sessionticket|token|secret/i;
export function dictionary(value: unknown): value is Record<string,string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([k,v]) => !secretKey.test(k) && typeof v === 'string');
}
export function objectJson(value: string, name: string): Record<string, unknown> {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new GameError('invalid_save',400,`${name}:invalid_json`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GameError('invalid_save',400,`${name}:expected_object`);
  return parsed as Record<string, unknown>;
}
export function validateSnapshot(value: unknown, legacy = false): { snapshot: Snapshot; prefs: Record<string,string>; healthy: boolean; effectivePlaytime: number } {
  const s = value as Snapshot;
  if (!s || s.game !== 'ec1' || s.schemaVersion !== 1) throw new GameError('unsupported_save_schema');
  if (!Number.isFinite(s.playtime) || s.playtime < 0 || !Number.isSafeInteger(s.expectedSaveVersion) || s.expectedSaveVersion < 0 || typeof s.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(s.operationId)) throw new GameError('invalid_save_envelope');
  if (!dictionary(s.data) || typeof s.data.CLOUD_ALL_DATA !== 'string' || JSON.stringify(s.data).length > 2_000_000) throw new GameError('incomplete_save');
  const parsed = objectJson(s.data.CLOUD_ALL_DATA,'CLOUD_ALL_DATA');
  if (!dictionary(parsed)) throw new GameError('invalid_save',400,'preference_values_must_be_strings_without_credentials');
  const prefs = parsed;
  const missing = legacyKeys.filter(k => !(k in prefs));
  if (!legacy) missing.push(...nativeKeys.filter(k=>!(k in prefs)&&!missing.includes(k)));
  if (missing.length) throw new GameError('incomplete_save',400,`missing:${missing.join(',')}`);
  for (const k of legacyKeys) if (!strings.has(k) && !/^\d+$/.test(prefs[k])) throw new GameError('invalid_save',400,`${k}:integer_required`);
  for(const k of supplementalIntegers) if(k in prefs&&(!/^-?\d+$/.test(prefs[k])||!Number.isSafeInteger(Number(prefs[k]))||Number(prefs[k])<-2_147_483_648||Number(prefs[k])>2_147_483_647)) throw new GameError('invalid_save',400,`${k}:integer_required`);
  for(const k of supplementalFloats) if(k in prefs&&(!prefs[k]||!Number.isFinite(Number(prefs[k])))) throw new GameError('invalid_save',400,`${k}:finite_number_required`);
  const gd = objectJson(prefs.gamedata,'gamedata');
  for (const k of ['gold','ruby','stageProgress','tutorialProgress','timeCounter']) if (typeof gd[k] !== 'number' || !Number.isFinite(gd[k]) || Number(gd[k]) < 0) throw new GameError('invalid_save',400,`gamedata.${k}`);
  for(const k of ['gold','ruby','stageProgress','tutorialProgress'])if(!Number.isSafeInteger(gd[k])||Number(gd[k])>2_147_483_647)throw new GameError('invalid_save',400,`gamedata.${k}:int32_required`);
  if (!Array.isArray(gd.usedCoupons) || !gd.usedCoupons.every(v => typeof v === 'string') || !Array.isArray(gd.stageInfo)) throw new GameError('invalid_save',400,'gamedata.collections');
  let maxLevel = 0;
  for (const k of characters.map(c=>`${c}_attributes`)) {
    if (!prefs[k]) continue; // Locked characters can be uninitialized in real EC1 preferences.
    const a = objectJson(prefs[k],k);
    if (!Number.isSafeInteger(a.level) || Number(a.level) < 1 || !Number.isFinite(a.exp) || Number(a.exp)<0) throw new GameError('invalid_save',400,`${k}:level_exp`);
    maxLevel = Math.max(maxLevel, Number(a.level));
    for (const field of ['s_top','s_glove','s_shoes','s_weapon']) {
      if (typeof a[field] !== 'string') throw new GameError('invalid_save',400,`${k}:${field}`);
      if(a[field]) objectJson(a[field] as string,`${k}:${field}`);
    }
  }
  if (!prefs.alaster_attributes || !prefs.edna_attributes) throw new GameError('incomplete_save',400,'starting_character_missing');
  const groups = prefs.inventory.split('^');
  if (groups.length !== 3) throw new GameError('invalid_save',400,'inventory:three_groups_required');
  for (const group of groups) for (const item of group.split('|').filter(Boolean)) objectJson(item,'inventory.item');
  if (prefs.consumable) objectJson(prefs.consumable,'consumable');
  if (prefs.achievements_new && !/^[01](\|[01]){26}$/.test(prefs.achievements_new)) throw new GameError('invalid_save',400,'achievements_new:27_pipe_flags_required');
  const healthy = Number(gd.stageProgress)>0 || Number(gd.tutorialProgress)>0 || maxLevel>1 || groups.some(Boolean) || ['premium','louisaUnlock','soulUnlock','more_exp','double_loot',...legacyKeys.filter(k=>k.startsWith('costume_'))].some(k=>Number(prefs[k])>0);
  // The separate legacy Playtime value may survive a reset. Ranking uses time contained in validated gameplay data.
  const effectivePlaytime = Number(gd.timeCounter);
  return { snapshot: s, prefs, healthy, effectivePlaytime };
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
}
