# Operational file helper. Original inputs are read-only; results use a new directory.
import sys, json, os, re, hashlib
from pathlib import Path
def fail(message): raise ValueError(message)
def pairs(values):
    result={}
    for key,value in values:
        if key in result: fail('Duplicate JSON key.')
        result[key]=value
    return result
def text(value): return isinstance(value,str) and bool(value.strip())
def digest(data): return hashlib.sha256(data).hexdigest()
def source(value, maximum=33554432, directory=False):
    if not text(value) or not Path(value).is_absolute(): fail('Approved absolute input path required.')
    candidate=Path(value)
    for part in [candidate,*candidate.parents]:
        if part.is_symlink() or (hasattr(part,'is_junction') and part.is_junction()): fail('Links and junctions are not supported.')
    result=candidate.resolve(strict=True)
    if directory:
        if not result.is_dir(): fail('Input directory required.')
    elif not result.is_file() or result.stat().st_size>maximum: fail('Input file missing or exceeds supported size.')
    return result
def output_directory(value):
    if not text(value) or not Path(value).is_absolute(): fail('New absolute output directory required.')
    candidate=Path(value); source(str(candidate.parent),directory=True)
    try: candidate.mkdir(exist_ok=False)
    except FileExistsError: fail('Output directory already exists.')
    return candidate
def safe_name(value):
    if not text(value) or len(value)>150 or value in ['.','..'] or re.search(r'[<>:"/\\|?*\x00-\x1f]',value) or value.endswith(('.', ' ')) or re.match(r'^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',value,re.I): fail('Unsafe file name.')
    return value
def write_new(path,data):
    with path.open('xb') as target: target.write(data)
def json_bytes(value): return (json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode('utf-8')
def run(data):

    # Validate every name and collision before creating a new output directory.
    import shutil
    original=source(data.get('sourceDirectory'),directory=True); mapping=data.get('renames')
    if not isinstance(mapping,list) or not mapping or len(mapping)>200: fail('One to 200 rename pairs required.')
    prepared=[]; old_names=set(); new_names=set()
    for pair in mapping:
        if not isinstance(pair,dict): fail('Rename pair required.')
        old=safe_name(pair.get('from')); new=safe_name(pair.get('to'))
        if old.casefold() in old_names or new.casefold() in new_names or new.casefold()=='mapping.json': fail('Duplicate or reserved source/destination name.')
        old_names.add(old.casefold()); new_names.add(new.casefold()); file=source(str(original/old)); prepared.append((file,old,new))
    target=output_directory(data.get('outputDirectory')); records=[]
    for file,old,new in prepared:
        before=digest(file.read_bytes())
        with file.open('rb') as src,(target/new).open('xb') as dst: shutil.copyfileobj(src,dst,1048576)
        after=digest((target/new).read_bytes())
        if before!=after: fail('Source changed during copy.')
        records.append({'from':old,'to':new,'bytes':file.stat().st_size,'sha256':after})
    write_new(target/'mapping.json',json_bytes({'files':records})); return {'files':records,'originalsPreserved':True}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    result=run(data)
    sys.stdout.buffer.write(json_bytes(result))
except Exception as error:
    sys.stderr.buffer.write(('Operation failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
