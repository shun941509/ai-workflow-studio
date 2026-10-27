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

    # The only OCR source is the actual Windows engine; no supplied text or answer-key fallback exists.
    import subprocess
    from datetime import date
    if os.name!='nt': fail('Windows WinRT OCR is required; OCR has not run.')
    image=source(data.get('imagePath')); fields=data.get('fields'); language=data.get('language')
    if not text(language) or not re.fullmatch(r'[A-Za-z0-9-]{2,35}',language) or not isinstance(fields,list) or not fields: fail('OCR language and field regions required.')
    seen=set()
    for field in fields:
        if not isinstance(field,dict) or not text(field.get('name')) or field['name'] in seen or field.get('type') not in ['string','integer','date'] or not isinstance(field.get('required'),bool): fail('Unique typed fields required.')
        seen.add(field['name']); rect=field.get('rect')
        if not isinstance(rect,list) or len(rect)!=4 or any(not isinstance(v,int) or isinstance(v,bool) or v<0 for v in rect) or rect[2]==0 or rect[3]==0: fail('Pixel regions require x,y,width,height.')
    script=Path(__file__).with_name('windows_ocr.ps1')
    engine=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(script)],input=json_bytes({'imagePath':str(image),'language':language}),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if engine.returncode!=0: fail('Windows OCR unavailable or failed: '+engine.stderr.decode('utf-8',errors='replace')[:500])
    observation=json.loads(engine.stdout.decode('utf-8-sig')); results=[]
    for field in fields:
        x,y,w,h=field['rect']
        if x+w>observation['width'] or y+h>observation['height']: fail('Field region outside actual image.')
        words=[word for word in observation['words'] if x<=word['x']+word['width']/2<x+w and y<=word['y']+word['height']/2<y+h]
        words.sort(key=lambda word:(word['line'],word['x'])); raw=' '.join(word['text'] for word in words).strip(); value=raw or None; status='needs-review' if raw else ('missing' if field['required'] else 'empty')
        if raw and field['type']=='integer':
            if re.fullmatch(r'-?\d+',raw): value=int(raw)
            else: value=None; status='uncertain'
        if raw and field['type']=='date':
            try: value=date.fromisoformat(raw).isoformat()
            except ValueError: value=None; status='uncertain'
        results.append({'name':field['name'],'raw':raw,'value':value,'status':status,'confidence':None,'words':words})
    return {'engine':'Windows.Media.Ocr','language':observation['language'],'sourceSha256':digest(image.read_bytes()),'fields':results,'manualReviewRequired':True}

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
