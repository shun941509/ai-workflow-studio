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

    # Inspect presence and metadata only; never echo secrets, launch requested executables, or authenticate remotely.
    import shutil,importlib.metadata
    executables=data.get('executables'); packages=data.get('pythonPackages'); credentials=data.get('credentialNames'); modes=data.get('requiredModes')
    if any(not isinstance(v,list) for v in [executables,packages,credentials,modes]) or any(not isinstance(v,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',v) for v in executables) or any(not isinstance(v,str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}',v) for v in credentials) or any(not text(v) for v in modes): fail('Safe executable, credential names and mode lists required.')
    tool_results=[{'name':name,'state':'present-version-unchecked' if shutil.which(name) else 'missing'} for name in executables]; package_results=[]
    for package in packages:
        if not isinstance(package,dict) or not text(package.get('name')) or not text(package.get('version')): fail('Package name and exact version required.')
        try: installed=importlib.metadata.version(package['name']); package_results.append({'name':package['name'],'requiredVersion':package['version'],'installedVersion':installed,'state':'matched' if installed==package['version'] else 'version-mismatch'})
        except importlib.metadata.PackageNotFoundError: package_results.append({'name':package['name'],'requiredVersion':package['version'],'installedVersion':None,'state':'missing'})
    credential_results=[{'name':name,'state':'configured-unverified' if os.environ.get(name,'').strip() else 'missing'} for name in credentials]
    mode_results=[{'name':name,'state':'supported-locally' if name in ['local-files','json-inspection'] else 'unavailable'} for name in modes]
    missing=any(v['state']=='missing' for v in tool_results+credential_results) or any(v['state']!='matched' for v in package_results) or any(v['state']=='unavailable' for v in mode_results)
    return {'state':'needs-setup' if missing else 'connections-unverified' if credentials else 'local-prerequisites-present','executables':tool_results,'pythonPackages':package_results,'credentials':credential_results,'modes':mode_results,'authenticationTested':False,'permissionsGranted':False,'pythonVersion':sys.version.split()[0]}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
