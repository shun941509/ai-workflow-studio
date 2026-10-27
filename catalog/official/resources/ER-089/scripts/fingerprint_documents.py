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

    # Candidate detection only: normalization is explicit and no file is moved or deleted.
    import unicodedata
    paths=data.get('paths'); normalize=data.get('normalizeText',False)
    if not isinstance(paths,list) or not paths or len(paths)>200 or not isinstance(normalize,bool): fail('One to 200 paths and boolean normalizeText required.')
    records=[]; byte_groups={}; text_groups={}; total=0; seen=set()
    for value in paths:
        file=source(value)
        if str(file).casefold() in seen: fail('Duplicate input path.')
        seen.add(str(file).casefold()); raw=file.read_bytes(); total+=len(raw)
        if total>268435456: fail('Total input size exceeds 256 MiB.')
        sha=digest(raw); record={'path':str(file),'bytes':len(raw),'sha256':sha}; byte_groups.setdefault(sha,[]).append(str(file))
        if normalize:
            try: normalized=' '.join(unicodedata.normalize('NFC',raw.decode('utf-8-sig')).split()); fingerprint=digest(normalized.encode('utf-8')); record['normalizedSha256']=fingerprint; text_groups.setdefault(fingerprint,[]).append(str(file))
            except UnicodeDecodeError: record['textExcludedReason']='not-utf8'
        records.append(record)
    return {'files':records,'byteIdenticalGroups':[v for v in byte_groups.values() if len(v)>1],'normalizedCandidateGroups':[v for v in text_groups.values() if len(v)>1],'normalization':'NFC-and-whitespace' if normalize else None,'filesDeleted':0}

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
