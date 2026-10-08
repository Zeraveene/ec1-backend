import { GameError, objectJson } from './validation';
import exportedCatalog from './item-catalog.json';
interface CatalogItem {category:1|2;item:{id:string;m_name:string;amount:number;stack:number;[key:string]:unknown}}
export const itemCatalog=exportedCatalog as Record<string,CatalogItem>;
const entitlementKey=/^(premium|more_exp|double_loot|dualTaken|elysianTaken|louisaUnlock|soulUnlock|stepUp[1-5]|getOffer|costume_(alaster|edna|louisa|soul)_[1-8])$/;
export function applyRewardFlags(data:Record<string,string>,flags:Record<string,string>):Record<string,string> {
  const prefs=objectJson(data.CLOUD_ALL_DATA,'CLOUD_ALL_DATA');
  for(const [key,value] of Object.entries(flags)) {
    if(!entitlementKey.test(key)||value!=='1')throw new GameError('reward_flag_unsupported',422,key);
    prefs[key]=value;
  }
  return {...data,CLOUD_ALL_DATA:JSON.stringify(prefs)};
}
export interface Reward { id: string; amount: number; name?: string; itemCategory?: number|string }
export function validateRewards(value: unknown): Reward[] {
  if (!Array.isArray(value) || !value.length || value.length>100) throw new GameError('invalid_rewards');
  return value.map(r=>{
    if (!r || typeof r.id!=='string' || !Number.isSafeInteger(r.amount) || r.amount<=0 || r.amount>2_147_483_647) throw new GameError('invalid_rewards');
    const item=Object.hasOwn(itemCatalog,r.id)?itemCatalog[r.id]:undefined;
    if (r.id!=='gold' && r.id!=='ruby' && !/^costume_(alaster|edna|louisa|soul)_[1-8]$/.test(r.id)&&!item) throw new GameError('reward_unsupported',422,r.id);
    if(item) {
      const category=typeof r.itemCategory==='string'?({material:1,consume:2} as Record<string,number>)[r.itemCategory]:r.itemCategory;
      if(r.itemCategory!==undefined&&category!==item.category)throw new GameError('reward_category_mismatch');
      if(r.amount>item.item.stack)throw new GameError('reward_stack_overflow',409,r.id);
    }
    if (r.id.startsWith('costume_') && r.amount!==1) throw new GameError('invalid_rewards');
    return {id:r.id,amount:r.amount,...(typeof r.name==='string'?{name:r.name}:item?{name:item.item.m_name}:{}),...(item?{itemCategory:item.category}:{})};
  });
}
export function applyRewards(data: Record<string,string>, rewards: unknown): Record<string,string> {
  const accepted = validateRewards(rewards), prefs=objectJson(data.CLOUD_ALL_DATA,'CLOUD_ALL_DATA') as Record<string,string>;
  const gd=objectJson(prefs.gamedata,'gamedata');
  for (const reward of accepted) {
    if (reward.id.startsWith('costume_')) prefs[reward.id]='1';
    else if(reward.id==='gold'||reward.id==='ruby') {
      const next=Number(gd[reward.id])+reward.amount;
      if (!Number.isSafeInteger(next) || next>2_147_483_647) throw new GameError('reward_balance_overflow',409);
      gd[reward.id]=next;
      // These fields are EC1 GameDataManager's cumulative earned statistics.
      const stat=`stat_${reward.id}Earned`;
      if (typeof gd[stat]==='number') {
        const earned=Number(gd[stat])+reward.amount;
        if (!Number.isSafeInteger(earned)||earned>2_147_483_647) throw new GameError('reward_balance_overflow',409);
        gd[stat]=earned;
      }
    } else {
      const canonical=itemCatalog[reward.id],groups=prefs.inventory.split('^');
      if(groups.length!==3)throw new GameError('invalid_save',400,'inventory:three_groups_required');
      const entries=groups[canonical.category].split('|').filter(Boolean);
      let found=-1,amount=0;
      for(let group=0;group<groups.length;group++)for(const [index,raw] of groups[group].split('|').filter(Boolean).entries()) {
        const item=objectJson(raw,'inventory.item');
        if(item.id!==reward.id)continue;
        if(group!==canonical.category||found!==-1)throw new GameError('invalid_save',400,'inventory_duplicate_or_wrong_category');
        if(!Number.isSafeInteger(item.amount)||Number(item.amount)<0)throw new GameError('invalid_save',400,'inventory_amount_invalid');
        found=index;amount=Number(item.amount);
      }
      const next=amount+reward.amount;
      if(!Number.isSafeInteger(next)||next>canonical.item.stack)throw new GameError('reward_stack_overflow',409,reward.id);
      // Item asset defaults may contain sample quantities. Only the player's existing quantity and the grant count.
      const savedItem={...(found>=0?objectJson(entries[found],'inventory.item'):{}),...canonical.item,amount:next};
      if(found>=0)entries[found]=JSON.stringify(savedItem);else entries.push(JSON.stringify(savedItem));
      groups[canonical.category]=entries.join('|');prefs.inventory=groups.join('^');
    }
  }
  prefs.gamedata=JSON.stringify(gd);
  return {...data,CLOUD_ALL_DATA:JSON.stringify(prefs)};
}
