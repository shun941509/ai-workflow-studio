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

    # This is an upper-bound arithmetic estimate, never a model invocation or billing measurement.
    steps=data.get('steps'); budgets=data.get('budgets')
    if not isinstance(steps,list) or not steps or not isinstance(budgets,dict) or not integer(budgets.get('calls')) or not integer(budgets.get('tokens')): fail('Steps and integer call/token budgets required.')
    records=[]; seen=set(); base_calls=0; maximum_calls=0; base_tokens=0; maximum_tokens=0
    for step in steps:
        if not isinstance(step,dict) or not text(step.get('id')) or step['id'] in seen or not text(step.get('inputBasis')) or any(not integer(step.get(k),1,100000) for k in ['calls','iterations','maxAttempts']) or any(not integer(step.get(k),0,100000000) for k in ['inputTokens','outputTokens']): fail('Complete bounded step estimates required.')
        seen.add(step['id']); calls=step['calls']*step['iterations']; maximum=calls*step['maxAttempts']; tokens=step['inputTokens']+step['outputTokens']; base_calls+=calls; maximum_calls+=maximum; base_tokens+=calls*tokens; maximum_tokens+=maximum*tokens
        records.append({'id':step['id'],'baseCalls':calls,'maximumCalls':maximum,'baseTokens':calls*tokens,'maximumTokens':maximum*tokens,'inputBasis':step['inputBasis']})
    return {'steps':records,'total':{'baseCalls':base_calls,'maximumCalls':maximum_calls,'baseTokens':base_tokens,'maximumTokens':maximum_tokens},'overBudget':{'calls':maximum_calls>budgets['calls'],'tokens':maximum_tokens>budgets['tokens']},'estimated':True,'actualUsage':None}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
