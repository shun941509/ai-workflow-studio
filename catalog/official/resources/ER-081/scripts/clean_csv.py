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

    # Preserve CSV record boundaries, including quoted newlines and empty physical records.
    import csv, io
    original=source(data.get('sourcePath')); raw=original.read_bytes(); decoded=raw.decode('utf-8-sig')
    rows=list(csv.reader(io.StringIO(decoded,newline=''),strict=True))
    if not rows: fail('CSV header required.')
    headers=rows[0]
    if not headers or any(not text(v) for v in headers) or len(set(headers))!=len(headers): fail('Unique nonempty headers required.')
    mapping=data.get('headerMap',{}); trim=data.get('trimColumns',[])
    if not isinstance(mapping,dict) or any(key not in headers or not text(value) for key,value in mapping.items()) or not isinstance(trim,list) or any(value not in headers for value in trim): fail('Unknown header mapping or trim column.')
    renamed=[mapping.get(h,h) for h in headers]
    if len(set(renamed))!=len(renamed): fail('Renamed headers collide.')
    cleaned=[]; changes=[]
    for index,row in enumerate(rows[1:],2):
        if not row: row=['']*len(headers); changes.append({'record':index,'rule':'preserve-blank-record'})
        if len(row)!=len(headers): fail('CSV column count mismatch at record '+str(index))
        current=list(row)
        for column,header in enumerate(headers):
            if header in trim and current[column]!=current[column].strip(): current[column]=current[column].strip(); changes.append({'record':index,'column':header,'rule':'trim-boundary-whitespace'})
        cleaned.append(current)
    output=io.StringIO(newline=''); writer=csv.writer(output,lineterminator='\n'); writer.writerow(renamed); writer.writerows(cleaned)
    report={'sourceSha256':digest(raw),'inputRecords':len(rows)-1,'outputRecords':len(cleaned),'headers':dict(zip(headers,renamed)),'changes':changes,'encoding':'utf-8','removedBom':raw.startswith(b'\xef\xbb\xbf')}
    target=output_directory(data.get('outputDirectory')); write_new(target/'cleaned.csv',output.getvalue().encode('utf-8')); write_new(target/'changes.json',json_bytes(report))
    return report

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
