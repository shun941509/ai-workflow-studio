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

    # Compare original bytes to pinned checkpoint identities; never rewrite hashes or start execution.
    root=source(data.get('rootDirectory'),directory=True); checkpoint=data.get('checkpoint'); issues=[]; verified=[]
    if not isinstance(checkpoint,dict) or not isinstance(checkpoint.get('workflow'),dict) or not isinstance(checkpoint.get('artifacts'),list) or not isinstance(checkpoint.get('resources'),list) or not isinstance(checkpoint.get('unresolvedOperations'),list) or any(not text(v) for v in checkpoint['unresolvedOperations']): fail('Complete checkpoint contract required.')
    records=[dict(checkpoint['workflow'],kind='workflow')]+[dict(v,kind='artifact') for v in checkpoint['artifacts']]+[dict(v,kind='resource') for v in checkpoint['resources']]; seen=set()
    for record in records:
        name=relative(record.get('path'))
        if name in seen or not valid_hash(record.get('sha256')) or ('bytes' in record and not integer(record['bytes'])): fail('Unique paths and fixed hashes required.')
        seen.add(name)
        try: content=read_below(root,name)
        except FileNotFoundError: issues.append({'path':name,'reason':'missing'});continue
        if digest(content)!=record['sha256'] or ('bytes' in record and len(content)!=record['bytes']): issues.append({'path':name,'reason':'hash-or-size-mismatch'})
        else: verified.append({'path':name,'kind':record['kind']})
    for operation in checkpoint['unresolvedOperations']: issues.append({'operationId':operation,'reason':'external-outcome-unresolved'})
    return {'readyForReview':not issues,'issues':issues,'verifiedFiles':verified,'resumeStarted':False,'approvalValidityChecked':False,'environmentCompatibilityChecked':False}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
