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

    # All caller values become escaped text; no executable caller markup enters the document.
    import html
    title=data.get('title'); summary=data.get('summary'); headers=data.get('headers'); rows=data.get('rows')
    scalar=lambda value: value is None or isinstance(value,(str,int,float,bool))
    if not text(title) or not isinstance(summary,str) or not isinstance(headers,list) or not headers or any(not text(v) for v in headers) or not isinstance(rows,list) or any(not isinstance(row,list) or len(row)!=len(headers) or any(not scalar(v) for v in row) for row in rows): fail('Valid title, headers and rectangular scalar rows required.')
    def escape(value): return html.escape('미정' if value is None else str(value),quote=True)
    css=Path(__file__).parent.parent.joinpath('assets/report.css').read_text(encoding='utf-8')
    output='<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>'+escape(title)+'</title><style>'+css+'</style></head><body><main><h1>'+escape(title)+'</h1><p>'+escape(summary)+'</p><div class="table-scroll"><table><caption>입력 자료의 행 '+str(len(rows))+'개</caption><thead><tr>'+''.join('<th scope="col">'+escape(v)+'</th>' for v in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+escape(v)+'</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table></div></main></body></html>\n'
    target=output_directory(data.get('outputDirectory')); write_new(target/'report.html',output.encode('utf-8'))
    return {'file':'report.html','rows':len(rows),'inputSha256':digest(json_bytes({k:v for k,v in data.items() if k!='outputDirectory'}))}

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
