import { GameError, objectJson } from './validation';
const fields=['fortress_alaster','fortress_edna','fortress_louisa','fortress_zerav'];
/** Matches FortressRecord.Score: floor * 1,000,000 - cleartime * 10 + Character enum. */
export function fortressScore(data: Record<string,string>): number {
  const prefs=objectJson(data.CLOUD_ALL_DATA,'CLOUD_ALL_DATA'),gd=objectJson(String(prefs.gamedata),'gamedata');
  let score=0;
  for(let character=0;character<fields.length;character++) {
    const record=gd[fields[character]] as {character?:unknown;floor?:unknown;cleartime?:unknown}|null;
    if(record===null||record===undefined)continue;
    if(typeof record!=='object'||Array.isArray(record)||!Number.isSafeInteger(record.floor)||!Number.isSafeInteger(record.cleartime)||Number(record.floor)<0||Number(record.floor)>2147||Number(record.cleartime)<0||Number(record.cleartime)>99999||!Number.isSafeInteger(record.character)||Number(record.character)<0||Number(record.character)>3||Number(record.floor)>0&&record.character!==character)throw new GameError('invalid_save',400,`${fields[character]}:invalid_record`);
    if(!record.floor)continue;
    const value=Number(record.floor)*1_000_000-Number(record.cleartime)*10+character;
    if(value<1||value>2_147_483_647)throw new GameError('invalid_save',400,'fortress_score_out_of_bounds');
    score=Math.max(score,value);
  }
  return score;
}
