import { GameError, objectJson } from "./validation";
export type FortressRecord = { character: number; floor: number; cleartime: number };
const fields = ["fortress_alaster", "fortress_edna", "fortress_louisa", "fortress_zerav"];
export function betterFortressRecord(a: FortressRecord, b: FortressRecord): boolean {
  return a.floor > b.floor || (a.floor === b.floor && (a.cleartime < b.cleartime ||
    (a.cleartime === b.cleartime && a.character > b.character)));
}
/** Legacy save-linked API only; current online submissions are independent of backups. */
export function fortressRecord(data: Record<string, string>): FortressRecord {
  const prefs = objectJson(data.CLOUD_ALL_DATA, "CLOUD_ALL_DATA"), gd = objectJson(String(prefs.gamedata), "gamedata");
  let best: FortressRecord = { character: 0, floor: 0, cleartime: 0 };
  for (let character = 0; character < fields.length; character++) {
    const value = gd[fields[character]] as FortressRecord | null;
    if (value === null || value === undefined) continue;
    if (typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.floor) || value.floor < 0 || value.floor > 2147483647 ||
      !Number.isSafeInteger(value.cleartime) || value.cleartime < 0 || value.cleartime > 2147483647 ||
      !Number.isSafeInteger(value.character) || value.character < 0 || value.character > 3 ||
      (value.floor > 0 && value.character !== character))
      throw new GameError("invalid_save", 400, `${fields[character]}:invalid_record`);
    if (value.floor > 0 && betterFortressRecord(value, best)) best = { character, floor: value.floor, cleartime: value.cleartime };
  }
  return best;
}
