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

    # A deliberately closed structural profile: unsupported JSON Schema features fail before value inspection.
    allowed={'$schema','$comment','title','description','type','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','minimum','maximum','enum','const'}
    if 'value' not in data: fail('Actual value is required, including explicit null when applicable.')
    schema=data.get('schema'); value=data['value']; visited=0; issues=[]
    def equivalence(value):
        # JSON Schema treats numeric 1 and 1.0 as equal, while booleans remain distinct.
        if isinstance(value,float) and value.is_integer(): return int(value)
        if isinstance(value,list): return [equivalence(v) for v in value]
        if isinstance(value,dict): return {k:equivalence(v) for k,v in value.items()}
        return value
    def identity(value): return json_bytes(equivalence(value))
    # JSON numbers with zero fractional component satisfy integer, including the lexical form 1.0.
    types={'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),'string':lambda v:isinstance(v,str),'integer':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and int(v)==v,'number':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v),'boolean':lambda v:isinstance(v,bool),'null':lambda v:v is None}
    def contract(rule,depth=0):
        nonlocal visited
        visited+=1
        if visited>1000 or depth>20 or not isinstance(rule,dict) or set(rule)-allowed: fail('Unsupported contract shape, keyword or depth.')
        names=rule.get('type'); names=[names] if isinstance(names,str) else names
        if not isinstance(names,list) or not names or any(name not in types for name in names): fail('Explicit supported schema types required.')
        if '$schema' in rule and rule['$schema']!='https://json-schema.org/draft/2020-12/schema': fail('Unsupported schema dialect.')
        for key in ['minItems','maxItems','minLength','maxLength']:
            if key in rule and not integer(rule[key]): fail('Invalid length constraint.')
        for key in ['minimum','maximum']:
            if key in rule and not types['number'](rule[key]): fail('Invalid numeric bound.')
        if 'uniqueItems' in rule and not isinstance(rule['uniqueItems'],bool): fail('uniqueItems must be boolean.')
        if 'additionalProperties' in rule and not isinstance(rule['additionalProperties'],bool): fail('Only boolean additionalProperties is supported.')
        if 'enum' in rule and (not isinstance(rule['enum'],list) or not rule['enum']): fail('Nonempty enum required.')
        if 'required' in rule and (not isinstance(rule['required'],list) or any(not text(key) for key in rule['required']) or len(set(rule['required']))!=len(rule['required'])): fail('Invalid required names.')
        properties=rule.get('properties',{})
        if not isinstance(properties,dict): fail('properties object required.')
        for child in properties.values(): contract(child,depth+1)
        if 'items' in rule: contract(rule['items'],depth+1)
    def add(location,keyword):
        if len(issues)>=200: fail('More than 200 contract errors.')
        issues.append({'pointer':location,'keyword':keyword})
    def inspect(rule,current,location):
        names=rule['type']; names=[names] if isinstance(names,str) else names
        if not any(types[name](current) for name in names): add(location,'type'); return
        if 'enum' in rule and not any(identity(v)==identity(current) for v in rule['enum']): add(location,'enum')
        if 'const' in rule and identity(rule['const'])!=identity(current): add(location,'const')
        if isinstance(current,dict):
            for key in rule.get('required',[]):
                if key not in current: add(location+'/'+key.replace('~','~0').replace('/','~1'),'required')
            for key,child in current.items():
                at=location+'/'+key.replace('~','~0').replace('/','~1')
                if key in rule.get('properties',{}): inspect(rule['properties'][key],child,at)
                elif rule.get('additionalProperties') is False: add(at,'additionalProperties')
        if isinstance(current,list):
            if len(current)<rule.get('minItems',0): add(location,'minItems')
            if len(current)>rule.get('maxItems',1000000000): add(location,'maxItems')
            if rule.get('uniqueItems') and len({identity(v) for v in current})!=len(current): add(location,'uniqueItems')
            if 'items' in rule:
                for index,child in enumerate(current): inspect(rule['items'],child,location+'/'+str(index))
        if isinstance(current,str):
            if len(current)<rule.get('minLength',0): add(location,'minLength')
            if len(current)>rule.get('maxLength',1000000000): add(location,'maxLength')
        if types['number'](current):
            if 'minimum' in rule and current<rule['minimum']: add(location,'minimum')
            if 'maximum' in rule and current>rule['maximum']: add(location,'maximum')
    contract(schema); inspect(schema,value,''); return {'valid':not issues,'issues':issues,'profile':'studio-structural-subset-v1','semanticReviewRequired':True}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
