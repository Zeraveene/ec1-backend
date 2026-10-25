import { projectEquipment, inspectInventory } from './legacy-inventory';
import legacyKeys from './legacy-keys.json';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === 'string' && v.length <= 512 ? v : null;
const number = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
const heroes = ['alaster', 'edna', 'louisa', 'soul'];
const names = ['Alaster', 'Edna', 'Louisa', 'Zerav'];
// HeroReference assets (tier1..4, p1..4) and HeroCostumeNames.cs in the Classic client.
const abilities = [
  ['Counter Guard','Savage Rend','Shield Rush','Earth Break','Sword Mastery','Agility Training',"Guardian's Will",'Last Stand'],
  ['Flame Strike','Pyro Wave','Flame Pillar','Burning Field','Pyromastery','Energy Leech','Efficient Mana Flow','Eternal Flame'],
  ['ArcShot','Rapid Shooting','Arrow Rain','Unsteady Assassination','Bow Mastery',"Sharpshooter's Precision",'Enhanced Power Shot','Composure'],
  ['Soul Snatch','Violent Reap','Dread Chasm','Soul Oblivion','Scythe Mastery','Soul Mastery','Curse Craft','Soul Keeper'],
];
const costumes = ['Default','Christmas','Brave Knight','LNY','Casual Wear','Tropical Beach','Wyvern Master (Flame)','Wyvern Master (Void)','Elysian Knight'];
function costumeName(hero: number, id: number | null) {
  if (id === null) return null;
  if (id === 1) return ['Rudolph Alaster','Christmas Cat Edna','Christmas Bunny Louisa','Christmas Wolf Zerav'][hero];
  return costumes[id] ?? `Costume ${id}`;
}


/** Projection only: never runs migration validation or changes/publishes a save. */
export function inspectLegacySave(payload: unknown, capturedPlaytime: unknown) {
  const warnings: string[] = [];
  function decode(v: unknown, label: string): Record<string, any> | null {
    if (v === undefined || v === null || v === '') return null;
    try {
      for (let i = 0; i < 4 && typeof v === 'string'; i++) v = JSON.parse(v);
      if (object(v)) return v;
    } catch { /* keep the rest of the save visible */ }
    warnings.push(`${label}: unreadable JSON`); return null;
  }
  let root: Record<string, any> | null = null;
  if (typeof payload === 'string' && payload.length > 16 * 1024 * 1024) warnings.push('Save exceeds the viewer size limit');
  else if (typeof payload === 'string' && payload.includes('$')) {
    const fields: string[] = []; let quoted = false, escaped = false, start = 0;
    for (let i = 0; i < payload.length; i++) {
      const c = payload[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '$') { fields.push(payload.slice(start, i)); start = i + 1; }
    }
    fields.push(payload.slice(start));
    if (fields.length === 1) root = decode(payload, 'CLOUD_ALL_DATA');
    else if (fields.length < 3 || fields.length > legacyKeys.length) warnings.push('Unsupported historical save field count');
    else root = Object.fromEntries(fields.map((v, i) => [legacyKeys[i], v]));
  } else root = decode(payload, 'CLOUD_ALL_DATA');
  const modern = root?.schemaVersion === 1;
  if (root?.schemaVersion !== undefined && !modern) { warnings.push('Unsupported save schema'); root = null; }
  const progress = decode(modern ? root?.progress : root?.gamedata, 'Game data');
  if (root && !progress) warnings.push('Game data is not recorded');
  const profile = modern && object(root?.profile) ? root.profile : {};
  const unlocks = modern && object(root?.unlocks) ? root.unlocks : {};
  const savedHeroes = heroes.flatMap((key, index) => {
    const value = modern ? (Array.isArray(root?.characters) ? root.characters.find((v: any) => object(v) && v.character === index) : undefined) : root?.[`${key}_attributes`];
    const hero = decode(value, names[index]);
    if (!hero) return [];
    const equipment = (['weapon', 'top', 'glove', 'shoes'] as const).map((slot, i) => {
      const item = decode(modern ? hero[slot] : hero[`s_${slot}`], `${names[index]} ${slot}`);
      return projectEquipment(item, ['Weapon','Armor','Gloves','Shoes'][i]);
    });
    return [{ key, name: names[index], level: number(hero.level), exp: number(hero.exp), attributes: { STR: number(hero.Str), INT: number(hero.Int), AGI: number(hero.Agi), VIT: number(hero.Vit) },
      skills: ['A','B','C','D'].map((k, i) => ({ slot: k, name: abilities[index][i], level: number(hero[`skill${k}_lv`]), exp: number(hero[`skill${k}_exp`]) })),
      masteries: ['A','B','C','D'].map((k, i) => ({ slot: k, name: abilities[index][i + 4], level: number(hero[`passive${k}`]) })), equipment,
      costumeName: costumeName(index, number(modern ? unlocks.selectedCostumes?.[key] : root?.[`costume_${key}`])),
      costume: number(modern ? unlocks.selectedCostumes?.[key] : root?.[`costume_${key}`]), transmog: text(modern ? unlocks.transmogs?.[key] : root?.[`transmog_${key}`]) }];
  });
  const inventory = inspectInventory(root?.inventory, warnings);
  return { inventory, state: payload === undefined || payload === null || payload === '' ? 'missing' : root ? 'available' : 'unreadable', warnings,
    account: { gold: number(progress?.gold), ruby: number(progress?.ruby), playtime: number(capturedPlaytime) ?? number(modern ? profile.playtime : root?.playtime) ?? number(progress?.timeCounter), leaderboardName: text(modern ? profile.leaderboardName : root?.lbName), stageProgress: number(progress?.stageProgress) }, heroes: savedHeroes };
}
