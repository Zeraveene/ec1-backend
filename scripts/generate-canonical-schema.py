"""Regenerate the schema-1 structural contract from sibling Unity public save fields.
Review generated diff alongside SaveMigration.Validate before accepting a Unity schema update.
"""
import json,re,pathlib
base=pathlib.Path(__file__).resolve().parents[2]/'Epic_Conquest/Assets/_Contents/Scripts/Persistence'
schema={}
for name in ['SaveRecords.cs','InventorySaveRecord.cs']:
 text=(base/name).read_text()
 for match in re.finditer(r'public sealed class (\w+)\s*\{',text):
  tail=text[match.end():];end=tail.find('    public static ')
  if end>=0:tail=tail[:end]
  else:tail=tail[:tail.find('\n}')]
  fields={}
  for field in re.finditer(r'^    public ([\w.]+(?:<[^>]+>)?) ([^;\n]+);',tail,re.M):
   kind,values=field.groups()
   for v in re.split(r',\s*(?![^()]*\))',values):
    key=v.split('=')[0].strip()
    if re.fullmatch(r'\w+',key): fields[key]=kind
  schema[match.group(1)]=fields
schema['Equipment.ItemOption']={'option':'int','value':'float'}
out=pathlib.Path(__file__).resolve().parents[1]/'src/game/canonical-schema.json'
out.write_text(json.dumps(schema,indent=2)+'\n')
