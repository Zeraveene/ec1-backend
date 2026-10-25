"""Regenerate the schema-1 structural contract from sibling Unity public save fields.
Review generated diff alongside SaveMigration.Validate before accepting a Unity schema update.
"""
import argparse,json,re,pathlib
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--unity-project',type=pathlib.Path,help='Unity project root containing Assets/')
parser.add_argument('--check',action='store_true',help='Check parity without rewriting the committed schema')
args=parser.parse_args()
workspace=pathlib.Path(__file__).resolve().parents[2]
candidates=[args.unity_project] if args.unity_project else [workspace/'Epic_Conquest',workspace/'Epic Conquest 1'/'Epic_Conquest']
projects=[path for path in candidates if (path/'Assets/_Contents/Scripts/Persistence/SaveRecords.cs').is_file()]
if len(projects)!=1:
 parser.error('Select the Unity checkout with --unity-project; expected exactly one matching project')
base=projects[0]/'Assets/_Contents/Scripts/Persistence'
schema={}
for name in ['SaveRecords.cs','InventorySaveRecord.cs']:
 text=(base/name).read_text(encoding='utf-8')
 for match in re.finditer(r'public sealed class (\w+)\s*\{',text):
  tail=text[match.end():];end=tail.find('    public static ')
  if end>=0:tail=tail[:end]
  else:tail=tail[:tail.find('\n}')]
  fields={}
  for field in re.finditer(r'^    public ([\w.]+(?:<[^>]+>)?) ([^;\n]+);',tail,re.M):
   kind,values=field.groups()
   for v in re.split(r',\s*(?![^()]*\))',values):
    key=v.split('=')[0].strip()
    # Ownership was introduced as optional schema-1 metadata. Its presence/proof
    # policy is validated separately, so legacy payloads keep the same required shape.
    if match.group(1)=='GameSaveRecord' and key=='ownership': continue
    if re.fullmatch(r'\w+',key): fields[key]=kind
  schema[match.group(1)]=fields
schema['Equipment.ItemOption']={'option':'int','value':'float'}
out=pathlib.Path(__file__).resolve().parents[1]/'src/game/canonical-schema.json'
if args.check:
 if json.loads(out.read_text(encoding='utf-8'))!=schema:
  raise SystemExit('Canonical schema differs from Unity fields; review before regenerating')
 print('Canonical schema matches Unity: '+str(len(schema))+' types, '+str(sum(len(fields) for fields in schema.values()))+' fields')
else:
 out.write_text(json.dumps(schema,indent=2)+'\n',encoding='utf-8')
