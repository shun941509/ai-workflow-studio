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

    # Line locations use one-based half-open intervals, including empty insertion/deletion spans.
    from difflib import SequenceMatcher
    before_file=source(data.get('beforePath'),maximum=1048576); after_file=source(data.get('afterPath'),maximum=1048576); before_raw=before_file.read_bytes(); after_raw=after_file.read_bytes()
    before=before_raw.decode('utf-8-sig').splitlines(keepends=True); after=after_raw.decode('utf-8-sig').splitlines(keepends=True)
    if len(before)>2000 or len(after)>2000: fail('Document exceeds 2000-line comparison bound.')
    hunks=[]
    for operation,i1,i2,j1,j2 in SequenceMatcher(None,before,after,autojunk=False).get_opcodes():
        if operation!='equal': hunks.append({'kind':operation,'beforeStartLine':i1+1,'beforeEndLineExclusive':i2+1,'afterStartLine':j1+1,'afterEndLineExclusive':j2+1,'before':before[i1:i2],'after':after[j1:j2]})
    return {'beforeSha256':digest(before_raw),'afterSha256':digest(after_raw),'changed':before_raw!=after_raw,'coordinateUnit':'one-based-half-open-lines','hunks':hunks,'semanticReviewRequired':True}

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
