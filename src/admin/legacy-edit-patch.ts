import keys from './legacy-keys.json';
import { splitLegacy, record } from './legacy-inventory';
import { AdminActionError } from './action-types';
export interface LegacyPatch {
 account?: { gold?: number; ruby?: number; stageProgress?: number };
 amounts?: { category: 'materials'|'consumables'; index: number; amount: number }[];
 removals?: { category: 'equipment'|'materials'|'consumables'; index: number }[];
}
const fail=()=>{throw new AdminActionError('invalid_save_edit');};
const int=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=2147483647;
const only=(v:unknown,fields:string[])=>record(v)&&Object.keys(v).every(k=>fields.includes(k));
export function validateLegacyPatch(value:unknown):LegacyPatch {
 if(!only(value,['account','amounts','removals']))fail();const p=value as LegacyPatch;
 if(p.account!==undefined&&(!only(p.account,['gold','ruby','stageProgress'])||!Object.values(p.account).every(int)))fail();
 for(const [key,fields] of [['amounts',['category','index','amount']],['removals',['category','index']]] as const){
  const rows=p[key];if(rows===undefined)continue;if(!Array.isArray(rows)||rows.length>2000)fail();
  for(const row of rows!){if(!only(row,[...fields])||!int(row.index)||!['materials','consumables',...(key==='removals'?['equipment']:[])].includes(row.category)||key==='amounts'&&!int((row as any).amount))fail();}
 }
 const seen=new Set<string>();for(const row of [...p.amounts??[],...p.removals??[]]){const key=row.category+':'+row.index;if(seen.has(key))fail();seen.add(key);}
 if(!Object.keys(p.account??{}).length&&!p.amounts?.length&&!p.removals?.length)fail();return p;
}
function unwrap(value:any){let depth=0;for(;depth<4&&typeof value==='string';depth++)value=JSON.parse(value);return {value,depth};}
function wrap(value:any,depth:number){for(let i=0;i<depth;i++)value=JSON.stringify(value);return value;}
/** Edits only the requested fields in the full source document, preserving unknown data. */
export function patchLegacyData(data:Record<string,string>,patch:LegacyPatch):Record<string,string>{
 try{
  const raw=data.CLOUD_ALL_DATA;let root:any,depth=0,positional:string[]|null=null;
  const fields=splitLegacy(raw,'$');
  if(fields.length>1){if(fields.length<3||fields.length>keys.length)fail();positional=fields;root=Object.fromEntries(fields.map((v,i)=>[keys[i],v]));}
  else {const parsed=unwrap(raw);root=parsed.value;depth=parsed.depth;}
  if(!record(root)||root.schemaVersion!==undefined&&root.schemaVersion!==1)fail();
  const modern=root.schemaVersion===1;
  if(patch.account&&Object.keys(patch.account).length){
   const key=modern?'progress':'gamedata',p=unwrap(root[key]);if(!record(p.value))fail();
   for(const [k,v]of Object.entries(patch.account)){if(typeof p.value[k]!=='number'||!int(p.value[k]))fail();p.value[k]=v;}
   root[key]=wrap(p.value,p.depth);
  }
  if(patch.amounts?.length||patch.removals?.length){
   let inv:any=root.inventory,invDepth=0,sections:string[]|null=null;
   for(;invDepth<4&&typeof inv==='string'&&inv.trimStart().startsWith('"');invDepth++)inv=JSON.parse(inv);
   if(typeof inv==='string'&&splitLegacy(inv,'^').length>1){sections=splitLegacy(inv,'^');if(sections.length!==3)fail();inv=Object.fromEntries(['equipment','materials','consumables'].map((k,i)=>[k,sections![i].trim()?splitLegacy(sections![i],'|'):[]]));}
   else {const parsed=unwrap(inv);inv=parsed.value;invDepth+=parsed.depth;}
   if(!record(inv))fail();
   for(const category of ['equipment','materials','consumables'] as const){
    const updates=(patch.amounts??[]).filter(e=>e.category===category),removals=(patch.removals??[]).filter(e=>e.category===category);
    if(!updates.length&&!removals.length)continue;
    const list=inv[category];if(!Array.isArray(list))fail();
    for(const row of [...updates,...removals])if(row.index>=list.length)fail();
    // Validate every entry so projected list indices are never shifted by a damaged entry.
    for(const item of list){const p=unwrap(item);if(!record(p.value)||typeof p.value.id!=='string'||!p.value.id)fail();}
    for(const row of updates){const p=unwrap(list[row.index]);if(!int(p.value.amount))fail();p.value.amount=row.amount;list[row.index]=wrap(p.value,p.depth);}
    for(const row of removals.sort((a,b)=>b.index-a.index))list.splice(row.index,1);
   }
   if(sections){const serialized=['equipment','materials','consumables'].map(k=>inv[k].map((v:any)=>typeof v==='string'?v:JSON.stringify(v)).join('|')).join('^');root.inventory=wrap(serialized,invDepth);}
   else root.inventory=wrap(inv,invDepth);
  }
  let edited:string;
  if(positional)edited=positional.map((_,i)=>root[keys[i]]).join('$');else edited=wrap(root,depth);
  if(typeof edited!=='string'||new TextEncoder().encode(edited).length>16*1024*1024)fail();
  return {...data,CLOUD_ALL_DATA:edited};
 }catch(error){if(error instanceof AdminActionError)throw error;throw new AdminActionError('source_not_editable',409);}
}
