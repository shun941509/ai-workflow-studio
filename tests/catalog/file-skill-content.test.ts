import { afterEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, readSkillMetadata, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';
import { checkCatalog } from '../../tooling/catalog/check.js';

const root=process.cwd();
const python=process.env.STUDIO_CATALOG_PYTHON??(process.platform==='win32'?'python':'python3');
const catalog=JSON.parse(await readFile(path.join(root,'catalog/official/catalog.json'),'utf8')) as OfficialCatalog;
const ids=Array.from({length:10},(_,index)=>`ER-${String(index+81).padStart(3,'0')}`);
const directory=(id:string)=>path.join(root,'catalog/official/resources',id);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const sample=async(id:string):Promise<Record<string,unknown>>=>JSON.parse(await readFile(path.join(directory(id),'references/example-input.json'),'utf8')) as Record<string,unknown>;
const temporaryRoots:string[]=[];
async function temporary(){const value=await mkdtemp(path.join(tmpdir(),'studio-file-skills-'));temporaryRoots.push(value);return value;}
afterEach(async()=>{
  // Only our verified temporary roots are removed; operational resources and user files are never cleanup targets.
  for(const value of temporaryRoots.splice(0)){const resolved=path.resolve(value);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep+'studio-file-skills-'))throw new Error('Unsafe cleanup path.');await rm(resolved,{recursive:true,force:true});}
});
function invoke(id:string,helper:string,input:unknown){return spawnSync(python,[path.join(directory(id),'scripts',helper)],{input:JSON.stringify(input),encoding:'utf8',timeout:65000,maxBuffer:3*1024*1024,windowsHide:true});}
function run(id:string,helper:string,input:unknown):Record<string,unknown>{const child=invoke(id,helper,input);expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);return JSON.parse(child.stdout) as Record<string,unknown>;}
function reject(id:string,helper:string,input:unknown,reason:string){const child=invoke(id,helper,input);expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain(reason);}

describe('file Skill payloads and host packaging',()=>{
 test.each(ids)('%s contains operational code, concrete input, original rights and exact native host copies',async(id)=>{
  const entry=catalog.entries.find(e=>e.id===id)!;expect(entry.state).toBe('implemented');expect(entry.verificationRecords).toEqual([]);expect(entry.review).toBeUndefined();
  const descriptorBytes=new Uint8Array(await readFile(path.join(directory(id),'resource.json'))),descriptor=JSON.parse(decode(descriptorBytes)) as ResourceDescriptor;
  const reference:ResourceRef={id,kind:'skill',revision:1,sha256:hash(descriptorBytes)};const files=new Map<string,Uint8Array>([[`resources/${id}/resource.json`,descriptorBytes]]);
  for(const file of descriptor.files){const bytes=new Uint8Array(await readFile(path.join(directory(id),file.path)));expect(hash(bytes)).toBe(file.sha256);expect(bytes.length).toBe(file.bytes);files.set(`resources/${id}/${file.path}`,bytes);}
  expect(verifyResources({[id]:reference},files).get(id)?.id).toBe(id);const skill=files.get(`resources/${id}/SKILL.md`)!;const metadata=readSkillMetadata(skill);
  expect(decode(skill)).toContain(entry.definition.purpose);expect(decode(skill)).toContain(entry.definition.acceptanceCriteria);expect(decode(skill).match(/^\d+\. /gm)).toHaveLength(5);expect((await sample(id)).fictional).toBe(true);
  for(const bytes of files.values())expect(decode(bytes)).not.toContain('C:/Users/ght11111');
  for(const host of ['codex','claude-code','opencode'] as const){const built=await buildMaterialsPackage({host,refs:{[id]:reference},resources:Object.fromEntries(files),name:entry.name});const inspected=await inspectPackage(built.bytes);expect(inspected.manifest.purpose).toBe('production');expect(inspected.manifest.compatibility.host.verification).toBe('unverified');const archive=unzipSync(built.bytes),native=host==='codex'?'.agents/skills':host==='claude-code'?'.claude/skills':'.opencode/skills';for(const file of descriptor.files){expect(hash(archive[`${native}/${metadata.name}/${file.path}`]!)).toBe(file.sha256);expect(hash(archive[`resources/${id}/${file.path}`]!)).toBe(file.sha256);}expect(Object.keys(archive).some(name=>/(?:^|\/)(?:fixtures|tests|node_modules)(?:\/|$)|requirements-verification|verification\.spec/.test(name))).toBe(false);}
 });
 test('file authoring refuses regeneration and actual-use release counters remain zero',async()=>{
  const child=spawnSync(process.execPath,['--import','tsx','tooling/catalog/materialize-file-skills.ts'],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true});expect(child.status).toBe(1);expect(child.stderr).toContain('refusing to overwrite');
  const report=await checkCatalog(catalog,{root});expect(report.issues).toEqual([]);expect(report.counts.usableResources).toBe(0);expect(report.counts.publishedResources).toBe(0);expect(report.releaseReady).toBe(false);
 });
});

describe('real file processing and failure behavior',()=>{
 test('ER-081 preserves CSV rows, quoted newlines and originals; detects collisions and wrong columns',async()=>{
  const temp=await temporary(),sourcePath=path.join(directory('ER-081'),'references/source.csv'),before=hash(await readFile(sourcePath));const input={...await sample('ER-081'),sourcePath,outputDirectory:path.join(temp,'clean')};
  expect(run('ER-081','clean_csv.py',input)).toMatchObject({inputRecords:3,outputRecords:3,changes:[{record:2,column:'이름',rule:'trim-boundary-whitespace'}]});
  expect(await readFile(path.join(temp,'clean/cleaned.csv'),'utf8')).toBe('name,note\n가상A,"쉼표, 포함"\n가상B,"두 줄\n메모"\n,\n');expect(hash(await readFile(sourcePath))).toBe(before);
  reject('ER-081','clean_csv.py',input,'exists');reject('ER-081','clean_csv.py',{...input,headerMap:{이름:'same',메모:'same'},outputDirectory:path.join(temp,'collision')},'collide');
  const broken=path.join(temp,'broken.csv');await writeFile(broken,'a,b\n1,2,3\n');reject('ER-081','clean_csv.py',{...input,sourcePath:broken,headerMap:{},trimColumns:[]},'column count mismatch');
 });
 test('ER-082 converts the same instant and decimal units with explicit rounding; rejects naive dates and unknown units',async()=>{
  const input=await sample('ER-082');const result=run('ER-082','normalize_records.py',input);
  expect(result.records).toMatchObject([{id:'A',datetime:'2026-10-02T08:30:00+09:00',value:'1.235',unit:'m',unroundedValue:'1.2345',roundingDifference:'0.0005'},{id:'B',datetime:'2026-10-02T08:30:00+09:00',value:'2.500',unit:'m'}]);
  reject('ER-082','normalize_records.py',{...input,records:[{id:'X',datetime:'2026-10-01T12:00:00',value:'1',unit:'m'}]},'explicit timezone');
  reject('ER-082','normalize_records.py',{...input,records:[{id:'X',datetime:'2026-10-01T12:00:00Z',value:'1',unit:'unknown'}]},'known source units');
 });
 test('ER-083 uses actual installed OCR or explicitly reports unavailable prerequisites without returning text',async()=>{
  const input={...await sample('ER-083'),imagePath:path.join(directory('ER-083'),'references/scan.jpg')};
  const child=invoke('ER-083','extract_ocr_fields.py',input);
  if(child.status!==0){expect(child.stdout).toBe('');expect(child.stderr).toMatch(/Windows WinRT OCR is required|Windows OCR unavailable|language is not installed|running scripts is disabled/i);return;}
  // This branch is exercised only by a real installed engine. Incorrect OCR stays uncorrected and review-required.
  const result=JSON.parse(child.stdout) as {engine:string;sourceSha256:string;fields:Array<{name:string;raw:string;value:unknown;status:string;confidence:null;words:unknown[]}>;manualReviewRequired:boolean};
  expect(result.engine).toBe('Windows.Media.Ocr');expect(result.sourceSha256).toBe(hash(await readFile(input.imagePath)));
  expect(result.fields.find(field=>field.name==='quantity')).toMatchObject({raw:'2',value:2,status:'needs-review',confidence:null});expect(result.fields.find(field=>field.name==='needed_by')).toMatchObject({raw:'',value:null,status:'missing',words:[]});expect(result.fields.find(field=>field.name==='request_id')?.status).toBe('needs-review');expect(result.manualReviewRequired).toBe(true);
  reject('ER-083','extract_ocr_fields.py',{...input,language:'zz-ZZ'},'Windows OCR unavailable');
  expect(run('ER-083','extract_ocr_fields.py',{...input,fields:[{name:'bad-date',type:'date',required:true,rect:[470,338,640,77]}]}).fields).toMatchObject([{name:'bad-date',value:null,status:'uncertain'}]);
 },70000);
 test('ER-084 extracts actual PDF table cells and rejects image-only inputs',async()=>{
  const temp=await temporary(),outputDirectory=path.join(temp,'tables');const result=run('ER-084','extract_pdf_tables.py',{...await sample('ER-084'),sourcePath:path.join(directory('ER-084'),'references/report.pdf'),outputDirectory});
  const tables=result.tables as Array<{page:number;rows:string[][];file:string}>;expect(tables).toHaveLength(2);expect(tables.flatMap(table=>table.rows.flat())).toHaveLength(48);expect(tables[0]!.rows.at(-1)).toEqual(['Total','28','23','5']);expect(tables[1]!.rows.at(-1)).toEqual(['Total','36','31','5']);
  expect(await readFile(path.join(outputDirectory,tables[0]!.file),'utf8')).toContain('Alpha,8,6,2');
  reject('ER-084','extract_pdf_tables.py',{sourcePath:path.join(root,'catalog/official/resources/ER-052/scans.pdf'),outputDirectory:path.join(temp,'bad'),pages:[1]},'requires OCR');
 });
 test('ER-085 creates a real DOCX that reopens with all required sections and exact table cells',async()=>{
  const temp=await temporary(),input={...await sample('ER-085'),outputDirectory:path.join(temp,'word')};expect(run('ER-085','generate_docx.py',input)).toMatchObject({reopened:true,sections:['progress','next'],tables:1});
  const zip=unzipSync(await readFile(path.join(temp,'word/report.docx')));expect(zip['[Content_Types].xml']).toBeDefined();const xml=decode(zip['word/document.xml']!);for(const value of ['가상 한빛팀 주간 보고','진행 현황','다음 행동','FAQ 검토','검토 중'])expect(xml).toContain(value);expect(Object.values(zip).map(decode).join('')).not.toContain('TargetMode="External"');
  const observed=spawnSync(python,['-c','from docx import Document; import sys,json; d=Document(sys.argv[1]); print(json.dumps({"tables":[[[c.text for c in r.cells] for r in t.rows] for t in d.tables]},ensure_ascii=True))',path.join(temp,'word/report.docx')],{encoding:'utf8',windowsHide:true});expect(observed.status,observed.stderr).toBe(0);expect(JSON.parse(observed.stdout).tables).toEqual([[['업무','상태'],['안내문 정리','완료'],['FAQ 검토','검토 중']]]);
  reject('ER-085','generate_docx.py',{...input,requiredSections:['missing']},'Missing or duplicate');
 });
 test('ER-086 opens in Chromium with exact text and no input scripts, images or dialogs',async()=>{
  const temp=await temporary(),input={...await sample('ER-086'),outputDirectory:path.join(temp,'html')};run('ER-086','generate_html.py',input);
  const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});await page.goto(pathToFileURL(path.join(temp,'html/report.html')).href);expect(await page.title()).toBe('가상 처리 현황');expect(await page.locator('script,img').count()).toBe(0);expect(await page.locator('td').allTextContents()).toEqual(['완료','8','확인됨','대기','2','담당 미정','검토','미정','<img src=x onerror=alert(1)>']);expect(dialogs).toBe(0);}finally{await browser.close();}
  reject('ER-086','generate_html.py',{...input,rows:[['wrong']]},'rectangular scalar');
 });
 test('ER-087 copies verified bytes and refuses traversal, Windows names, case collisions and overwrite',async()=>{
  const temp=await temporary(),sourceDirectory=path.join(directory('ER-087'),'references/files'),input={...await sample('ER-087'),sourceDirectory,outputDirectory:path.join(temp,'copies')};
  expect(run('ER-087','copy_names.py',input)).toMatchObject({originalsPreserved:true});expect(await readFile(path.join(temp,'copies/hanbit-summary.txt'))).toEqual(await readFile(path.join(sourceDirectory,'draft-a.txt')));
  for(const target of ['../escape.txt','NUL.txt','mapping.json'])reject('ER-087','copy_names.py',{...input,renames:[{from:'draft-a.txt',to:target}]},target==='mapping.json'?'reserved':'Unsafe');
  reject('ER-087','copy_names.py',{...input,renames:[{from:'draft-a.txt',to:'same.txt'},{from:'draft-b.txt',to:'SAME.txt'}]},'Duplicate');reject('ER-087','copy_names.py',input,'exists');
 });
 test('ER-088 streams, reassembles exact original bytes and rejects tampered or escaped chunks',async()=>{
  const temp=await temporary(),sourcePath=path.join(directory('ER-088'),'references/source.txt'),split=path.join(temp,'split');const manifest=run('ER-088','split_join.py',{...await sample('ER-088'),sourcePath,outputDirectory:split});
  expect(manifest.sha256).toBe(hash(await readFile(sourcePath)));const joined=path.join(temp,'joined');expect(run('ER-088','split_join.py',{mode:'join',sourceDirectory:split,outputDirectory:joined})).toMatchObject({verified:true,sha256:manifest.sha256});expect(await readFile(path.join(joined,'rejoined.bin'))).toEqual(await readFile(sourcePath));
  await writeFile(path.join(split,'part-000001.bin'),'tampered');reject('ER-088','split_join.py',{mode:'join',sourceDirectory:split,outputDirectory:path.join(temp,'bad')},'hash/size mismatch');
  const malicious={...manifest,pieces:[{file:'../escape.bin',bytes:1,sha256:'a'.repeat(64)}]};await writeFile(path.join(split,'manifest.json'),JSON.stringify(malicious));reject('ER-088','split_join.py',{mode:'join',sourceDirectory:split,outputDirectory:path.join(temp,'escape')},'Invalid piece sequence');
  await writeFile(path.join(split,'manifest.json'),JSON.stringify({...manifest,pieces:[{file:'part-000001.bin',bytes:true,sha256:'a'.repeat(64)}]}));reject('ER-088','split_join.py',{mode:'join',sourceDirectory:split,outputDirectory:path.join(temp,'boolean-size')},'Invalid piece sequence');
 });
 test('ER-089 distinguishes exact and normalized candidates and never deletes originals',async()=>{
  const paths=['a.txt','b.txt','c.txt'].map(name=>path.join(directory('ER-089'),'references',name)),before=await Promise.all(paths.map(async value=>hash(await readFile(value))));const result=run('ER-089','fingerprint_documents.py',{paths,normalizeText:true});
  expect(result.byteIdenticalGroups).toEqual([[paths[0],paths[1]]]);expect(result.normalizedCandidateGroups).toEqual([paths]);expect(result.filesDeleted).toBe(0);expect(await Promise.all(paths.map(async value=>hash(await readFile(value))))).toEqual(before);reject('ER-089','fingerprint_documents.py',{paths:[paths[0],paths[0]]},'Duplicate input');
 });
 test('ER-090 reports real old/new locations and contents, and rejects an unavailable original',async()=>{
  const beforePath=path.join(directory('ER-090'),'references/before.md'),afterPath=path.join(directory('ER-090'),'references/after.md');const result=run('ER-090','compare_documents.py',{beforePath,afterPath});
  expect(result.hunks).toEqual([{kind:'replace',beforeStartLine:2,beforeEndLineExclusive:3,afterStartLine:2,afterEndLineExclusive:3,before:['접수 마감: 10월 10일\n'],after:['접수 마감: 10월 12일\n']},{kind:'replace',beforeStartLine:4,beforeEndLineExclusive:5,afterStartLine:4,afterEndLineExclusive:6,before:['수동 접수 허용\n'],after:['온라인 접수만 허용\n','변경 공지: 10월 5일\n']}]);
  expect(run('ER-090','compare_documents.py',{beforePath,afterPath:beforePath})).toMatchObject({changed:false,hunks:[]});reject('ER-090','compare_documents.py',{beforePath:'relative.md',afterPath},'absolute input');
 });
 test('all distributed Python entrypoints reject invalid JSON instead of returning successful output',async()=>{
  for(const id of ids){for(const file of (await readdir(path.join(directory(id),'scripts'))).filter(file=>file.endsWith('.py'))){const child=spawnSync(python,[path.join(directory(id),'scripts',file)],{input:'{broken',encoding:'utf8',timeout:10000,windowsHide:true});expect(child.status).toBe(1);expect(child.stdout).toBe('');}}
 });
});
