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

    # Extract actual page/table cells; ambiguous merged or empty cells remain explicit.
    import csv, io, pdfplumber
    original=source(data.get('sourcePath')); selected=data.get('pages'); tables=[]; csv_files={}
    if not isinstance(selected,list) or not selected or len(set(selected))!=len(selected) or any(not isinstance(p,int) or isinstance(p,bool) or p<1 for p in selected): fail('Unique positive page numbers required.')
    with pdfplumber.open(original) as document:
        if len(document.pages)>100 or any(p>len(document.pages) for p in selected): fail('Page range or 100-page limit exceeded.')
        for page_number in selected:
            page=document.pages[page_number-1]
            if not page.extract_text(): fail('Image-only PDF requires OCR; no table extracted.')
            found=page.find_tables(table_settings={'vertical_strategy':'lines','horizontal_strategy':'lines'})
            if not found: fail('No supported ruled table on page '+str(page_number))
            for table_number,table in enumerate(found,1):
                rows=table.extract(); cell_count=sum(len(row) for row in rows)
                if not rows or not rows[0] or cell_count>10000 or any(len(row)!=len(rows[0]) for row in rows): fail('Unsupported or excessive table shape.')
                stream=io.StringIO(newline=''); writer=csv.writer(stream,lineterminator='\n'); writer.writerows([[cell if cell is not None else '' for cell in row] for row in rows]); name=f'page-{page_number:03}-table-{table_number:03}.csv'; csv_files[name]=stream.getvalue().encode('utf-8')
                tables.append({'page':page_number,'table':table_number,'file':name,'bbox':list(table.bbox),'coordinateUnit':'points-top-left','rows':rows,'emptyOrMergedCells':[{'row':r,'column':c} for r,row in enumerate(rows) for c,cell in enumerate(row) if cell is None or cell=='']})
    report={'sourceSha256':digest(original.read_bytes()),'tables':tables,'manualMergedCellReviewRequired':True}
    target=output_directory(data.get('outputDirectory'))
    for name,content in csv_files.items(): write_new(target/name,content)
    write_new(target/'tables.json',json_bytes(report)); return report

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
