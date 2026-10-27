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

    # Stream bounded chunks, verify all pieces, and compare the reassembled original hash.
    mode=data.get('mode'); limit=268435456
    if mode=='split':
        original=source(data.get('sourcePath'),maximum=limit); chunk_bytes=data.get('chunkBytes')
        if not isinstance(chunk_bytes,int) or isinstance(chunk_bytes,bool) or not 1<=chunk_bytes<=8388608 or (original.stat().st_size+chunk_bytes-1)//chunk_bytes>1024: fail('Chunk size or 1024-piece bound exceeded.')
        target=output_directory(data.get('outputDirectory')); whole=hashlib.sha256(); pieces=[]; size=0
        with original.open('rb') as stream:
            while True:
                chunk=stream.read(chunk_bytes)
                if not chunk: break
                size+=len(chunk)
                if size>limit or len(pieces)>=1024: fail('Input changed beyond size limits.')
                whole.update(chunk); name=f'part-{len(pieces)+1:06}.bin'; write_new(target/name,chunk); pieces.append({'file':name,'bytes':len(chunk),'sha256':digest(chunk)})
        manifest={'schemaVersion':'1.0.0','bytes':size,'sha256':whole.hexdigest(),'pieces':pieces}; write_new(target/'manifest.json',json_bytes(manifest)); return manifest
    if mode!='join': fail('Mode must be split or join.')
    original=source(data.get('sourceDirectory'),directory=True); manifest=json.loads(source(str(original/'manifest.json'),maximum=1048576).read_text(encoding='utf-8'),object_pairs_hook=pairs)
    pieces=manifest.get('pieces'); expected=manifest.get('sha256'); total=manifest.get('bytes')
    if manifest.get('schemaVersion')!='1.0.0' or not isinstance(pieces,list) or len(pieces)>1024 or not isinstance(total,int) or isinstance(total,bool) or not 0<=total<=limit or not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected): fail('Invalid manifest.')
    actual=0; prepared=[]
    for index,piece in enumerate(pieces,1):
        if not isinstance(piece,dict) or piece.get('file')!=f'part-{index:06}.bin' or not isinstance(piece.get('bytes'),int) or isinstance(piece['bytes'],bool) or not 1<=piece['bytes']<=8388608: fail('Invalid piece sequence or size.')
        file=source(str(original/piece['file']),maximum=8388608); content=file.read_bytes()
        if len(content)!=piece['bytes'] or digest(content)!=piece.get('sha256'): fail('Piece hash/size mismatch.')
        actual+=len(content); prepared.append((file,piece))
    if actual!=total: fail('Declared total size mismatch.')
    target=output_directory(data.get('outputDirectory')); whole=hashlib.sha256()
    with (target/'rejoined.bin').open('xb') as output:
        for file,piece in prepared:
            content=file.read_bytes()
            if digest(content)!=piece['sha256']: fail('Piece changed during join.')
            whole.update(content); output.write(content)
    if whole.hexdigest()!=expected: fail('Rejoined original hash mismatch.')
    return {'file':'rejoined.bin','bytes':actual,'sha256':whole.hexdigest(),'verified':True}

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
