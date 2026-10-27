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

    # Required data loss and source changes stay separate from allowed text edits or metric tolerance.
    before=data.get('before'); after=data.get('after'); required=data.get('requiredPointers'); allowed=data.get('allowedPointers'); tolerances=data.get('metricTolerance')
    if not isinstance(required,list) or not isinstance(allowed,list) or not isinstance(tolerances,dict) or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) or v<0 for v in tolerances.values()): fail('Pointer lists and nonnegative finite tolerances required.')
    for location in required+allowed: pointer({},location)
    for result in [before,after]:
        if not isinstance(result,dict) or 'output' not in result or not isinstance(result.get('metrics'),dict) or not isinstance(result.get('sources'),list) or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in result['metrics'].values()): fail('Complete real result structures required.')
        if any(not isinstance(s,dict) or not text(s.get('id')) or not integer(s.get('revision'),1) or not valid_hash(s.get('sha256')) for s in result['sources']) or len({s['id'] for s in result['sources']})!=len(result['sources']): fail('Unique fixed source identities required.')
    changes=[]
    def walk(old,new,location,depth=0):
        if depth>30: fail('Result nesting exceeds comparison limit.')
        if json_bytes(old)==json_bytes(new): return
        if isinstance(old,dict) and isinstance(new,dict):
            for key in sorted(set(old)|set(new)):
                at=location+'/'+key.replace('~','~0').replace('/','~1')
                if key not in old: changes.append({'pointer':at,'kind':'added','after':new[key],'allowed':at in allowed})
                elif key not in new: changes.append({'pointer':at,'kind':'removed','before':old[key],'allowed':at in allowed})
                else: walk(old[key],new[key],at,depth+1)
        else: changes.append({'pointer':location,'kind':'changed','before':old,'after':new,'allowed':location in allowed})
    walk(before['output'],after['output'],''); missing=[]
    for location in required:
        present,value=pointer(after['output'],location)
        if not present or value is None: missing.append(location)
    metrics=[]
    for name in sorted(set(before['metrics'])|set(after['metrics'])):
        if name not in before['metrics'] or name not in after['metrics']: metrics.append({'name':name,'state':'missing-before-or-after','withinTolerance':False});continue
        difference=after['metrics'][name]-before['metrics'][name]; tolerance=tolerances.get(name,0)
        metrics.append({'name':name,'difference':difference,'tolerance':tolerance,'withinTolerance':abs(difference)<=tolerance})
    sources_changed=json_bytes(sorted(before['sources'],key=lambda s:s['id']))!=json_bytes(sorted(after['sources'],key=lambda s:s['id']))
    return {'changes':changes,'missingRequired':missing,'metrics':metrics,'sourcesChanged':sources_changed,'reviewRequired':bool(missing) or sources_changed or any(not c['allowed'] for c in changes) or any(not m['withinTolerance'] for m in metrics)}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
