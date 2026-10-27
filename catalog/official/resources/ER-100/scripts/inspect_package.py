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

    # Bounded read-only ZIP integrity inspection; signature trust and workflow semantics remain separate checks.
    import zipfile,unicodedata,stat
    original=source(data.get('packagePath'),maximum=67108864); names=set(); names_folded=set(); contents={}; totals=0; observations={}
    def safe_zip_name(name):
        relative(name)
        if unicodedata.normalize('NFC',name)!=name or any(re.search(r'~[0-9]+(?:\.|$)',part) for part in name.split('/')): fail('Ambiguous Unicode or short-name ZIP path.')
        folded=name.upper().lower()
        if folded in names_folded: fail('Duplicate or case-colliding ZIP path.')
        names_folded.add(folded); names.add(name)
        pieces=name.split('/'); basename=pieces[-1].lower()
        if any(part.lower() in ['tests','fixtures','node_modules','.git','.next','.turbo'] for part in pieces) or basename in ['package-lock.json','pnpm-lock.yaml','yarn.lock','requirements-verification.txt','.env','.env.local'] or 'verification.spec' in basename or re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?$',basename): fail('Development or secret-only file in production package.')
    with zipfile.ZipFile(original) as archive:
        entries=archive.infolist()
        if not entries or len(entries)>10000: fail('Invalid file count.')
        for entry in entries:
            # Python truncates NUL names internally; compare its preserved original before trusting the parsed name.
            if entry.orig_filename!=entry.filename or (not entry.flag_bits & 0x800 and not entry.filename.isascii()): fail('Non-UTF-8 or truncated ZIP name.')
            safe_zip_name(entry.filename)
            kind=stat.S_IFMT(entry.external_attr>>16)
            if entry.is_dir() or kind not in [0,stat.S_IFREG] or entry.flag_bits & 0x41 or entry.compress_type not in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]: fail('Unsupported encrypted, linked or special ZIP entry.')
            if entry.file_size>134217728 or entry.file_size/max(1,entry.compress_size)>100 or (entry.filename=='manifest.json' and entry.file_size>4194304): fail('Archive size or compression ratio limit.')
            digestor=hashlib.sha256(); size=0; small=[]
            with archive.open(entry) as stream:
                while True:
                    chunk=stream.read(1048576)
                    if not chunk: break
                    size+=len(chunk);totals+=len(chunk)
                    if size>134217728 or totals>536870912: fail('Actual decompression size limit.')
                    digestor.update(chunk)
                    if entry.filename=='manifest.json': small.append(chunk)
            if size!=entry.file_size: fail('Actual ZIP size mismatch.')
            observations[entry.filename]={'bytes':size,'sha256':digestor.hexdigest()}
            if small: contents['manifest.json']=b''.join(small)
    if 'manifest.json' not in contents: fail('Manifest missing.')
    manifest=json.loads(contents['manifest.json'].decode('utf-8-sig'),object_pairs_hook=pairs)
    if not isinstance(manifest,dict) or manifest.get('schemaVersion')!='1.0.0' or manifest.get('purpose')!='production' or manifest.get('packageKind') not in ['workflow','materials'] or manifest.get('targetHost') not in ['codex','claude-code','opencode'] or not isinstance(manifest.get('files'),list) or not manifest['files']: fail('Unsupported production manifest.')
    declared=set()
    for file in manifest['files']:
        if not isinstance(file,dict) or not integer(file.get('bytes'),0,134217728) or not valid_hash(file.get('sha256')): fail('Invalid file declaration.')
        name=relative(file.get('path'))
        if name in declared or name in ['manifest.json','manifest.sig']: fail('Duplicate or self-declared manifest entry.')
        declared.add(name)
        if name not in observations: fail('Declared file missing: '+name)
        if observations[name]!={'bytes':file['bytes'],'sha256':file['sha256']}: fail('File hash/size mismatch: '+name)
    if set(observations)-{'manifest.json','manifest.sig'}!=declared: fail('Unlisted file in package.')
    if manifest['packageKind']=='workflow' and (manifest.get('entrypoint')!='workflow.json' or 'workflow.json' not in declared): fail('Workflow entrypoint missing.')
    if manifest['packageKind']=='materials' and manifest.get('entrypoint') is not None: fail('Materials package cannot declare execution entrypoint.')
    return {'integrityValid':True,'packageKind':manifest['packageKind'],'targetHost':manifest['targetHost'],'fileCount':len(observations),'totalBytes':totals,'packageSha256':digest(original.read_bytes()),'signatureVerified':False,'signaturePresent':'manifest.sig' in observations,'permissionApproved':False,'workflowSemanticsValidated':False}

try:
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576: fail('Input exceeds 1 MiB.')
    data=json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=lambda value: fail('Nonfinite JSON number.'))
    if not isinstance(data,dict): fail('JSON object required.')
    sys.stdout.buffer.write(json_bytes(run(data)))
except Exception as error:
    sys.stderr.buffer.write(('Inspection failed: '+str(error)+'\n').encode('utf-8'))
    sys.exit(1)
