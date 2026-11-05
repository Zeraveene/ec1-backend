import schema from '../game/canonical-schema.json';
import keys from '../admin/legacy-keys.json';
import catalog from '../game/item-catalog.json';
import { validateCanonicalSnapshot } from '../game/backups';
import { AdminActionError } from '../admin/action-types';

// Server counterpart of Unity SaveMigration/SaveSectionCodec. Only archived cloud
// bytes enter this converter; neither local progress nor caller snapshots do.
type Obj = Record<string, any>;
const fields = schema as Record<string, Record<string, string>>;
const heroes = ['alaster', 'edna', 'louisa', 'soul'];
const tutorials = ['tutorial_blacksmith', 'tutorial_merchant', 'tutorial_companion', 'tutorial_inventory', 'tutorial_skill', 'tutorial_status'];
const preferences = ['usesound', 'usebgm', 'useSpeech', 'fixedpad', 'lowpower', 'autotarget', 'battlelog', 'overrideMovement', 'hideAura', 'hideCostume', 'difficulty'];
const optionKeys = ['mainOption1', 'mainOption2', 'subOption1', 'subOption2', 'subOption3', 'socket1', 'socket2'];
const isObject = (v: any): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => { throw new AdminActionError('legacy_save_invalid', 409); };
function object(v: any): Obj { if (typeof v === 'string') v = JSON.parse(v); return isObject(v) ? v : fail(); }
function split(value: string, delimiter: string) {
  const parts: string[] = []; let quoted = false, escaped = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === delimiter) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted) fail(); parts.push(value.slice(start)); return parts;
}
function defaults(kind: string): any {
  if (kind === 'string') return '';
  if (kind === 'bool') return false;
  if (kind.startsWith('List<')) return [];
  if (kind.startsWith('Dictionary<')) return {};
  if (kind === 'FortressSaveRecord' || kind === 'ItemRecord') return null;
  if (!fields[kind]) return 0;
  const value = Object.fromEntries(Object.entries(fields[kind]).map(([k, t]) => [k, defaults(t)]));
  if (kind === 'CharacterSaveRecord') { value.level = 1; value.skillA_lv = 1; }
  return value;
}
// Legacy sections may omit newer fields, but present values must never be coerced.
function hydrate(v: any, kind: string): any {
  if (v === null && ['FortressSaveRecord', 'ItemRecord'].includes(kind)) return null;
  if (kind === 'string' || kind === 'bool') return typeof v === (kind === 'bool' ? 'boolean' : 'string') ? v : fail();
  if (['int', 'Rarity', 'EquipmentType', 'ItemType'].includes(kind)) return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : fail();
  if (kind === 'float') return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3.4028234663852886e38 ? v : fail();
  const list = /^List<(.+)>$/.exec(kind), dict = /^Dictionary<string,\s*(.+)>$/.exec(kind);
  if (list) { if (!Array.isArray(v) || v.length > 10000) fail(); return v.map((x: any) => hydrate(x, list[1])); }
  const source = object(v);
  if (dict) return Object.fromEntries(Object.entries(source).map(([k, x]) => [k, hydrate(x, dict[1])]));
  if (!fields[kind]) fail();
  const result = defaults(kind) ?? Object.fromEntries(Object.entries(fields[kind]).map(([k, t]) => [k, defaults(t)]));
  for (const [k, t] of Object.entries(fields[kind])) {
    if (!(k in source)) continue;
    result[k] = source[k] === null && ['EquipmentRecord', 'ItemRecord'].includes(kind) && ['m_name', 'description'].includes(k) ? null : hydrate(source[k], t);
  }
  // Compact catalog records intentionally omit read-model metadata.
  if (source.definition === true) result.definition = true;
  return result;
}
function item(v: any, equipment: boolean) {
  const source = object(v);
  if (typeof source.id !== 'string' || !source.id.trim()) fail();
  if ('definition' in source && typeof source.definition !== 'boolean') fail();
  if (source.definition === true) {
    for (const key of equipment ? ['id', 'enhanceLevel', ...optionKeys] : ['id', 'amount']) if (source[key] == null) fail();
    if (!equipment && !(catalog as Record<string, any>)[source.id]?.item) fail();
  }
  const value = hydrate(source, equipment ? 'EquipmentRecord' : 'ItemRecord');
  if (equipment) {
    if (value.rarity < 0 || value.rarity > 2 || value.type < 0 || value.type > 3) fail();
    for (const key of optionKeys) if (value[key].option < 0 || value[key].option > 26) fail();
  } else if (value.type < 0 || value.type > 7) fail();
  return value;
}
function inventory(raw: string) {
  const sections = split(raw, '^');
  const source = sections.length === 1 ? object(raw) : sections.length === 3 ? Object.fromEntries(['equipment', 'materials', 'consumables'].map((key, i) => [key, sections[i].trim() ? split(sections[i], '|') : []])) : fail();
  return Object.fromEntries(['equipment', 'materials', 'consumables'].map(key => {
    if (!Array.isArray(source[key]) || source[key].length > 10000) fail();
    return [key, source[key].map((v: any) => item(v, key === 'equipment'))];
  }));
}
function valid(save: Obj) {
  validateCanonicalSnapshot(JSON.stringify(save));
  if (save.progress.gold < 0 || save.progress.ruby < 0 || save.profile.playtime < 0) fail();
  for (const c of save.characters) {
    if (c.level < 1 || c.exp < 0) fail();
    for (const k of ['top', 'glove', 'shoes', 'weapon']) item(c[k], true);
  }
  for (const [k, list] of Object.entries(save.inventory)) for (const v of list as any[]) item(v, k === 'equipment');
  for (const k of ['A', 'B']) {
    if (save.consumableSlots['amount' + k] < 0 || save.consumableSlots['slot' + k] === null && save.consumableSlots['amount' + k] !== 0) fail();
    if (save.consumableSlots['slot' + k]) item(save.consumableSlots['slot' + k], false);
  }
  for (const q of save.daily.quests) if (q.assignment < 0 || q.assignment > 12 || q.progress < 0 || ![0, 1].includes(q.claimed)) fail();
  for (const k of ['boosterQuota', 'treasureEntries', 'marchEntries', 'chaosEntries', 'lastReward', 'experienceBuffEnd', 'lootBuffEnd']) if (save.daily[k] < 0) fail();
  if (!heroes.includes(save.unlocks.selectedCharacter) || save.achievements.some((v: any) => ![0, 1].includes(v))) fail();
  if (Object.values(save.purchases).some(v => ![0, 1].includes(v as number))) fail();
  if (Object.values(save.unlocks.costumes).some(v => ![0, 1].includes(v as number)) || Object.values(save.unlocks.selectedCostumes).some(v => !Number.isInteger(v) || (v as number) < 0 || (v as number) > 8)) fail();
  if (!Array.isArray(save.appliedPurchaseGrants) || new Set(save.appliedPurchaseGrants).size !== save.appliedPurchaseGrants.length || save.appliedPurchaseGrants.some((s: any) => typeof s !== 'string' || !s || s.length > 240)) fail();
  return validateCanonicalSnapshot(JSON.stringify(save));
}
export function convertLegacyCloud(raw: string, companion?: string) {
  try {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2_000_000) fail();
    const parts = split(raw, '$');
    const root = parts.length === 1 && raw.trimStart().startsWith('{') ? object(raw) : null;
    if (root?.schemaVersion !== undefined) { if (root.appliedPurchaseGrants === undefined) root.appliedPurchaseGrants = []; return { ...valid(root), normalizations: [] as { field: string; from: number; to: number }[] }; }
    const values: Record<string, string> = root ?? (parts.length >= 3 && parts.length <= keys.length ? Object.fromEntries(parts.map((v, i) => [keys[i], v])) : fail());
    if (Object.values(values).some(v => typeof v !== 'string')) fail();
    const text = (k: string, fallback = '') => values[k] || fallback;
    const integer = (k: string, fallback = 0) => {
      const v = text(k).trim(); if (!v) return fallback;
      if (!/^[+-]?\d+$/.test(v)) fail(); return hydrate(Number(v), 'int');
    };
    const parseNumber = (v: string) => { if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())) fail(); return hydrate(Number(v), 'float'); };
    const number = (k: string) => { const v = text(k).trim(); return v ? parseNumber(v) : 0; };
    const save = defaults('GameSaveRecord'); save.schemaVersion = 1;
    const progress = object(text('gamedata')); if (progress.gold === undefined || progress.ruby === undefined) fail();
    save.progress = hydrate(progress, 'ProgressSaveRecord');
    save.characters = heroes.map((hero, i) => {
      const original = text(hero + '_attributes');
      if (!original) {
        const c = defaults('CharacterSaveRecord'); c.character = i;
        for (const [k, id, type] of [['top', 'aarmor', 1], ['glove', 'aglove', 2], ['shoes', 'ashoes', 3], ['weapon', 'aweapon', 0]] as const) c[k] = { ...defaults('EquipmentRecord'), id, type, levelReq: 1 };
        return c;
      }
      const c = object(original); if (c.level === undefined || c.exp === undefined) fail();
      for (const k of ['top', 'glove', 'shoes', 'weapon']) c[k] = item(c[k] ?? c['s_' + k], true);
      return { ...hydrate(c, 'CharacterSaveRecord'), character: i };
    });
    if (text('inventory')) save.inventory = inventory(text('inventory'));
    if (text('consumable')) {
      const slots = object(text('consumable'));
      if ('stringA' in slots || 'stringB' in slots) for (const k of ['A', 'B']) slots['slot' + k] = slots['string' + k] ? item(slots['string' + k], false) : null;
      save.consumableSlots = hydrate(slots, 'ConsumableSlotsSaveRecord');
      for (const k of ['A', 'B']) { if (save.consumableSlots['slot' + k]) save.consumableSlots['slot' + k] = item(save.consumableSlots['slot' + k], false); else save.consumableSlots['amount' + k] = 0; }
    }
    const dailyKeys: Record<string, string> = { lastReward: 'LastReward', dailyReset: 'dailyReset', allClaimed: 'task_all_claimed', treasureEntries: 'entry_treasure', marchEntries: 'entry_march', chaosEntries: 'entry_chaos' };
    for (const [k, pref] of Object.entries(dailyKeys)) save.daily[k] = integer(pref);
    // Historical counters can underflow after their allowances are exhausted.
    // Preserve exhaustion without granting new attempts. Only legacy preference
    // conversion repairs these counters; canonical snapshots remain strict.
    const quota = integer('dailyBoosterQuota', -1);
    save.daily.boosterQuota = quota;
    const normalizations: { field: string; from: number; to: number }[] = [];
    for (const field of ['boosterQuota', 'treasureEntries', 'marchEntries', 'chaosEntries']) {
      if (save.daily[field] < 0) {
        if (field !== 'boosterQuota' || text('dailyBoosterQuota').trim()) normalizations.push({ field, from: save.daily[field], to: 0 });
        save.daily[field] = 0;
      }
    }
    save.daily.lastRewardTime = text('LastRewardTime'); save.daily.timedRewardsTime = text('TimedRewardsTime');
    save.daily.questsAssigned = !!text('task0'); save.daily.boosterActivated = quota !== -1;
    save.daily.quests = [0, 1, 2].map(i => ({ assignment: integer('task' + i, i), progress: integer('task' + i + '_progress'), claimed: integer('task' + i + '_claimed') }));
    save.daily.experienceBuffEnd = number('buff_exp_end'); save.daily.lootBuffEnd = number('buff_loot_end');
    save.unlocks.selectedCharacter = text('selected', 'alaster'); save.unlocks.selectedPet = text('selectedPet');
    for (const k of ['louisaUnlock', 'soulUnlock', 'legendUnlock', 'gameclear', 'petCombat']) save.unlocks[k] = integer(k);
    for (const hero of heroes) {
      save.unlocks.selectedCostumes[hero] = integer('costume_' + hero); save.unlocks.transmogs[hero] = text('transmog_' + hero);
      for (let i = 1; i <= 8; i++) { const k = 'costume_' + hero + '_' + i; save.unlocks.costumes[k] = integer(k); }
    }
    if (progress.tutorials !== undefined && (!isObject(progress.tutorials) || Object.keys(progress.tutorials).length !== tutorials.length)) fail();
    for (const k of tutorials) { const v = progress.tutorials ? progress.tutorials[k] : integer(k); if (![0, 1].includes(v)) fail(); save.unlocks.tutorials[k] = v; }
    for (const k of Object.keys(fields.PurchaseSaveRecord)) save.purchases[k] = integer(k);
    save.achievements = text('achievements_new') ? text('achievements_new').split('|').map(v => /^[01]$/.test(v) ? Number(v) : fail()) : Array(27).fill(0);
    save.profile = { leaderboardId: text('lbId'), leaderboardName: text('lbName'), playtime: number('playtime') };
    if (companion !== undefined && companion !== null && companion !== '') {
      const fallback = parseNumber(companion); if (fallback < 0) fail();
      if (root && progress.timeCounter === undefined) save.progress.timeCounter = fallback;
      if (root && !('playtime' in values)) save.profile.playtime = fallback;
    }
    save.preferences.language = text('lang');
    for (const k of preferences) save.preferences.integers[k] = integer(k, ['usesound', 'usebgm', 'fixedpad', 'autotarget', 'overrideMovement'].includes(k) ? 1 : 0);
    if (text('ec1_applied_purchase_grants')) save.appliedPurchaseGrants = JSON.parse(text('ec1_applied_purchase_grants'));
    if (text('ec1_save_ownership')) save.ownership = object(text('ec1_save_ownership'));
    return { ...valid(save), normalizations };
  } catch { return fail(); }
}
