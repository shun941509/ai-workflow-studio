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

    # Decimal arithmetic and explicit UTC offsets make conversion and rounding reproducible.
    from decimal import Decimal, localcontext, ROUND_HALF_UP
    from datetime import datetime, timezone, timedelta
    offset=data.get('targetOffset'); factors=data.get('unitFactors'); unit=data.get('targetUnit'); digits=data.get('digits'); records=data.get('records')
    if not isinstance(offset,str) or not re.fullmatch(r'[+-](?:0\d|1[0-4]):[0-5]\d',offset) or (offset[1:3]=='14' and offset[4:]!='00'): fail('Explicit target offset within 14 hours required.')
    if not isinstance(digits,int) or isinstance(digits,bool) or not 0<=digits<=12 or not isinstance(factors,dict) or unit not in factors or not isinstance(records,list): fail('Valid factors, target unit, digits and records required.')
    def decimal(value):
        if not isinstance(value,str) or not re.fullmatch(r'-?\d{1,18}(?:\.\d{1,18})?',value): fail('Bounded decimal string required.')
        return Decimal(value)
    parsed={key:decimal(value) for key,value in factors.items()}
    if any(value<=0 for value in parsed.values()): fail('Unit factors must be positive.')
    minutes=(int(offset[1:3])*60+int(offset[4:]))*(1 if offset[0]=='+' else -1); target_tz=timezone(timedelta(minutes=minutes)); result=[]; seen=set()
    with localcontext() as context:
        context.prec=80
        for record in records:
            if not isinstance(record,dict) or not text(record.get('id')) or record['id'] in seen or record.get('unit') not in parsed: fail('Unique IDs and known source units required.')
            seen.add(record['id']); timestamp=record.get('datetime')
            if not isinstance(timestamp,str) or not re.search(r'(?:Z|[+-]\d{2}:\d{2})$',timestamp): fail('Source datetime requires explicit timezone.')
            instant=datetime.fromisoformat(timestamp)
            if instant.tzinfo is None: fail('Naive datetime is unsupported.')
            original=decimal(record.get('value')); converted=original*parsed[record['unit']]/parsed[unit]; rounded=converted.quantize(Decimal(1).scaleb(-digits),rounding=ROUND_HALF_UP)
            result.append({'id':record['id'],'original':record,'datetime':instant.astimezone(target_tz).isoformat(),'value':format(rounded,'f'),'unit':unit,'unroundedValue':format(converted,'f'),'roundingDifference':format(rounded-converted,'f')})
    return {'records':result,'rounding':'ROUND_HALF_UP','targetOffset':offset,'unitFactors':factors}

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
