# Operational inspection only: no external calls, permission changes, retries, cancellation, or resume actions.
import sys,json,os,re,hashlib,math
from pathlib import Path
def fail(message): raise ValueError(message)
def text(value): return isinstance(value,str) and bool(value.strip())
def integer(value,minimum=0,maximum=1000000000): return isinstance(value,int) and not isinstance(value,bool) and minimum<=value<=maximum
def pairs(values):
    result={}
    for key,value in values:
        if key in result: fail('Duplicate JSON key.')
        result[key]=value
    return result
def json_bytes(value): return (json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':'))+'\n').encode('utf-8')
def digest(value): return hashlib.sha256(value).hexdigest()
def valid_hash(value): return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None
def source(value,maximum=33554432,directory=False):
    if not text(value) or not Path(value).is_absolute(): fail('Approved absolute path required.')
    candidate=Path(value)
    for part in [candidate,*candidate.parents]:
        if part.is_symlink() or (hasattr(part,'is_junction') and part.is_junction()): fail('Links and junctions unsupported.')
    result=candidate.resolve(strict=True)
    if directory:
        if not result.is_dir(): fail('Directory required.')
    elif not result.is_file() or result.stat().st_size>maximum: fail('File missing or exceeds limit.')
    return result
def relative(value):
    if not text(value) or '\\' in value or ':' in value or value.startswith('/') or any(v in ['', '.', '..'] or v.endswith(('.', ' ')) or re.search(r'[\x00-\x1f<>"|?*]',v) or re.match(r'^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',v,re.I) for v in value.split('/')): fail('Unsafe relative path.')
    return value
def read_below(root,name,maximum=33554432):
    value=source(str(root/relative(name)),maximum=maximum)
    if not value.is_relative_to(root): fail('Path escapes source root.')
    return value.read_bytes()
def pointer(value,location):
    if not isinstance(location,str) or (location!='' and not location.startswith('/')) or re.search(r'~(?:[^01]|$)',location): fail('Invalid JSON Pointer.')
    current=value
    if location=='': return True,current
    for part in location[1:].split('/'):
        key=part.replace('~1','/').replace('~0','~')
        if isinstance(current,dict) and key in current: current=current[key]
        elif isinstance(current,list) and re.fullmatch(r'0|[1-9]\d*',key) and int(key)<len(current): current=current[int(key)]
        else: return False,None
    return True,current
def run(data):

    # Inspect only descendants of the approved root; false and zero remain present values.
    root=source(data.get('rootDirectory'),directory=True); expected=data.get('expected'); result_file=relative(data.get('resultFile'))
    if not isinstance(expected,dict) or not isinstance(expected.get('files'),list) or any(not isinstance(v,list) or any(not isinstance(p,str) for p in v) for v in [expected.get('requiredFields'),expected.get('fileReferences')]): fail('Expected files, required fields and references required.')
    actual=[]
    for folder,dirs,files in os.walk(root,followlinks=False):
        for name in dirs: source(str(Path(folder)/name),directory=True)
        for name in files: file=source(str(Path(folder)/name));actual.append(file.relative_to(root).as_posix())
        if len(actual)>10000: fail('More than 10000 output files.')
    issues=[]; declared=[]
    for file in expected['files']:
        if not isinstance(file,dict) or not isinstance(file.get('required'),bool): fail('File contract requires path and required flag.')
        name=relative(file.get('path'))
        if name in declared: fail('Duplicate expected file.')
        declared.append(name)
        if name not in actual:
            if file['required']: issues.append({'kind':'missing-file','path':name})
        elif 'sha256' in file:
            if not valid_hash(file['sha256']): fail('Invalid declared hash.')
            if digest(read_below(root,name))!=file['sha256']: issues.append({'kind':'hash-mismatch','path':name})
    if result_file not in actual: issues.append({'kind':'missing-result-file','path':result_file}); result=None
    else: result=json.loads(read_below(root,result_file,1048576).decode('utf-8-sig'),object_pairs_hook=pairs)
    for location in expected['requiredFields']:
        present,value=pointer(result,location)
        if not present or value is None: issues.append({'kind':'missing-required-field','pointer':location})
    for location in expected['fileReferences']:
        present,value=pointer(result,location)
        if not present or not isinstance(value,str): issues.append({'kind':'missing-file-reference','pointer':location});continue
        relative(value)
        if value not in actual: issues.append({'kind':'broken-file-reference','pointer':location,'path':value})
    return {'complete':not issues,'issues':issues,'actualFiles':sorted(actual),'extraFiles':sorted(set(actual)-set(declared)),'contentQualityChecked':False}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
