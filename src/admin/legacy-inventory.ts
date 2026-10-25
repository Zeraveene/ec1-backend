import catalog from '../game/item-catalog.json';
export const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const savedText = (v: unknown): string | null => typeof v === 'string' && v.length <= 4096 ? v : null;
export const savedNumber = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
const options = ['None','ATK','DEF','CRIT','ASPD','HP','MP','HP regen','MP regen','STR','AGI','INT','VIT','Cooldown reduction','Stun resist','Flame resist','Ice resist','Poison resist','Burst','Conserve','Recharge','Frenzy','Focus','Temper','Life steal','Mana steal','Resistance'];
export function splitLegacy(value: string, delimiter: string) {
  const parts: string[] = []; let quoted = false, escaped = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === delimiter) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted) throw new Error('unfinished_string');
  parts.push(value.slice(start)); return parts;
}
export function projectEquipment(item: Record<string, any> | null, slot?: string) {
  const type = savedNumber(item?.type);
  const stats = ['mainOption1','mainOption2','subOption1','subOption2','subOption3','socket1','socket2'].flatMap(k => {
    const stat = item?.[k], option = savedNumber(stat?.option);
    if (!record(stat) || option === null || option === 0) return [];
    return [{ slot: k, label: options[option] ?? `Option ${option}`, value: savedNumber(stat.value) }];
  });
  const id = savedText(item?.id);
  return { slot: slot ?? (['Weapon','Armor','Gloves','Shoes'][type ?? -1] || 'Equipment'), id,
    name: savedText(item?.m_name) || id, description: savedText(item?.description), sellPrice: savedNumber(item?.sellPrice),
    enhancement: savedNumber(item?.enhanceLevel), rarity: savedNumber(item?.rarity), level: savedNumber(item?.levelReq), stats,
    sockets: ['socket1','socket2'].map(slot => ({ slot, state: !record(item?.[slot]) || savedNumber(item?.[slot]?.option) === null ? 'missing' : savedNumber(item?.[slot]?.option) === 0 ? 'empty' : 'filled' })) };
}
function projectItem(item: Record<string, any>) {
  const id = savedText(item.id), definition = id ? (catalog as Record<string, any>)[id]?.item : null;
  return { id, name: savedText(item.m_name) || savedText(definition?.m_name) || id, amount: savedNumber(item.amount),
    description: savedText(item.description) ?? savedText(definition?.description), type: savedNumber(item.type) ?? savedNumber(definition?.type),
    sellPrice: savedNumber(item.sellPrice) ?? savedNumber(definition?.sellPrice), stack: savedNumber(item.stack) ?? savedNumber(definition?.stack),
    value: savedNumber(item.value) ?? savedNumber(definition?.value), cooldown: savedNumber(item.cooldown) ?? savedNumber(definition?.cooldown),
    percentValue: typeof item.percentValue === 'boolean' ? item.percentValue : typeof definition?.percentValue === 'boolean' ? definition.percentValue : null };
}
export function inspectInventory(payload: unknown, warnings: string[]) {
  const empty = { equipment: null, materials: null, consumables: null };
  if (payload === undefined || payload === null || payload === '') return { state: 'missing', ...empty };
  function decodeItem(value: unknown, label: string) {
    try { for (let i = 0; i < 4 && typeof value === 'string'; i++) value = JSON.parse(value);
      if (record(value) && savedText(value.id)) return value;
    } catch { /* skip just the malformed entry, preserving healthy neighbours */ }
    warnings.push(`${label}: unreadable item`); return null;
  }
  function list(value: unknown, label: string): Record<string, any>[] | null {
    if (!Array.isArray(value)) { warnings.push(`Inventory ${label}: section not recorded or unreadable`); return null; }
    return value.flatMap((entry, index) => { const item = decodeItem(entry, `Inventory ${label} #${index + 1}`); return item ? [item] : []; });
  }
  try {
    // Legacy inventory uses equipment^materials^consumables, with | between items.
    for (let i = 0; i < 4 && typeof payload === 'string' && payload.trimStart().startsWith('"'); i++) payload = JSON.parse(payload);
    if (typeof payload === 'string') {
      const sections = splitLegacy(payload, '^');
      if (sections.length > 1) {
        if (sections.length !== 3) throw new Error('sections');
        payload = Object.fromEntries(['equipment','materials','consumables'].map((key, i) => [key, sections[i].trim() ? splitLegacy(sections[i], '|') : []]));
      } else for (let i = 0; i < 4 && typeof payload === 'string'; i++) payload = JSON.parse(payload);
    }
    if (!record(payload)) throw new Error('inventory');
    const count = warnings.length;
    const equipment = list(payload.equipment, 'equipment')?.map(item => projectEquipment(item)) ?? null;
    const materials = list(payload.materials, 'materials')?.map(projectItem) ?? null;
    const consumables = list(payload.consumables, 'consumables')?.map(projectItem) ?? null;
    return { state: warnings.length > count ? 'partial' : 'available', equipment, materials, consumables };
  } catch { warnings.push('Inventory: unreadable container'); return { state: 'unreadable', ...empty }; }
}
