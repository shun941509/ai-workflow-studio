import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createSchemaValidator, type ResourceRef } from '@studio/spec';
import { buildMaterialsPackage, inspectPackage, readSkillMetadata, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import { checkCatalog } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const root=process.cwd();
const catalogPath=path.join(root,'catalog/official/catalog.json');
const catalog=JSON.parse(await readFile(catalogPath,'utf8')) as OfficialCatalog;
const ids=Array.from({length:20},(_,index)=>`ER-${String(index+61).padStart(3,'0')}`);
const directory=(id:string)=>path.join(root,'catalog/official/resources',id);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const load=async(id:string,file:string):Promise<Record<string,unknown>>=>JSON.parse(await readFile(path.join(directory(id),file),'utf8')) as Record<string,unknown>;
const sample=(id:string)=>load(id,'references/example-input.json');

/** Run the real distributed code with bounded process time; no provider stubs or host success records are created. */
function invoke(id:string,helper:string,input:unknown){
  return spawnSync(process.execPath,[path.join(directory(id),'scripts',helper)],{input:JSON.stringify(input),encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024,windowsHide:true});
}
function run(id:string,helper:string,input:unknown):Record<string,unknown>{
  const child=invoke(id,helper,input);expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Record<string,unknown>;
}
function reject(id:string,helper:string,input:unknown,reason:string){
  const child=invoke(id,helper,input);expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain(reason);
}

describe('original Agent Skills ER-061 through ER-080',()=>{
  test.each(ids)('%s has a distinct usable procedure and byte-identical skill payloads in all three host packages',async(id)=>{
    const entry=catalog.entries.find(e=>e.id===id)!;
    expect(entry.state).toBe('implemented');expect(entry.resourceKind).toBe('skill');expect(entry.verificationRecords).toEqual([]);expect(entry.review).toBeUndefined();
    const descriptorBytes=new Uint8Array(await readFile(path.join(directory(id),'resource.json')));
    const descriptor=JSON.parse(decode(descriptorBytes)) as ResourceDescriptor;
    expect(descriptor.entrypoint).toBe('SKILL.md');expect(descriptor.license).toEqual({id:'LicenseRef-Studio-Examples-v1',path:'LICENSE.md'});
    const ref:ResourceRef={id,revision:1,kind:'skill',sha256:hash(descriptorBytes)};
    const files=new Map<string,Uint8Array>([[`resources/${id}/resource.json`,descriptorBytes]]);
    for(const file of descriptor.files){const bytes=new Uint8Array(await readFile(path.join(directory(id),file.path)));expect(hash(bytes)).toBe(file.sha256);expect(bytes.length).toBe(file.bytes);files.set(`resources/${id}/${file.path}`,bytes);}
    expect(verifyResources({[id]:ref},files).get(id)?.id).toBe(id);
    const skill=decode(files.get(`resources/${id}/SKILL.md`)!);
    const metadata=readSkillMetadata(files.get(`resources/${id}/SKILL.md`)!);
    expect(metadata.description).toContain('사용합니다');expect(skill).toContain(entry.definition.purpose);expect(skill).toContain(entry.definition.acceptanceCriteria);
    expect(skill).toContain('## 필수 입력');expect(skill).toContain('## 실패·미확인 처리');expect(skill.match(/^\d+\. /gm)).toHaveLength(5);
    expect((await sample(id)).fictional).toBe(true);
    expect(decode(files.get(`resources/${id}/README.md`)!)).toContain('실제 모델·외부 서비스 실행 기록이 아닙니다');
    expect(decode(files.get(`resources/${id}/LICENSE.md`)!)).toContain('사용, 복제, 수정, 결합 및 재배포를 허용');
    for(const host of ['codex','claude-code','opencode'] as const){
      const built=await buildMaterialsPackage({host,refs:{[id]:ref},resources:Object.fromEntries(files),name:entry.name});
      const inspected=await inspectPackage(built.bytes);expect(inspected.manifest.purpose).toBe('production');expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      const archive=unzipSync(built.bytes),native=host==='codex'?'.agents/skills':host==='claude-code'?'.claude/skills':'.opencode/skills';
      // Compare every copied original, including code, templates, and binary SQLite data.
      for(const file of descriptor.files){const original=files.get(`resources/${id}/${file.path}`)!;expect(hash(archive[`resources/${id}/${file.path}`]!)).toBe(hash(original));expect(hash(archive[`${native}/${metadata.name}/${file.path}`]!)).toBe(hash(original));}
      expect(Object.keys(archive).some(name=>/(?:^|\/)(?:tests|fixtures|node_modules)(?:\/|$)|requirements-verification|materialize-agent-skills|verification\.spec/.test(name))).toBe(false);
    }
  });

  test('procedures remain distinct and implemented content contributes zero real-use or publication completions',async()=>{
    const sections=await Promise.all(ids.map(async id=>(await readFile(path.join(directory(id),'SKILL.md'),'utf8')).split('## 작업 절차\n\n')[1]!.split('## 결과 계약')[0]!));
    expect(new Set(sections).size).toBe(20);
    const vocabularies=sections.map(text=>new Set(text.split(/\s+/).filter(word=>word.length>2)));
    for(let a=0;a<20;a++)for(let b=a+1;b<20;b++){const common=[...vocabularies[a]!].filter(word=>vocabularies[b]!.has(word)).length;expect(common/new Set([...vocabularies[a]!,...vocabularies[b]!]).size).toBeLessThan(.55);}
    const report=await checkCatalog(catalog,{root});expect(report.issues).toEqual([]);expect(report.releaseReady).toBe(false);expect(report.counts.usableResources).toBe(0);expect(report.counts.publishedResources).toBe(0);expect(report.counts.verifiedHostCombinations).toBe(0);
    expect(ids.filter(id=>catalog.entries.some(e=>e.id===id&&e.state==='implemented'))).toHaveLength(20);
  });

  test('initial authoring cannot overwrite later editorial changes or catalogue hashes',async()=>{
    const before=hash(await readFile(catalogPath));const source=path.join(directory('ER-061'),'SKILL.md');const contentBefore=hash(await readFile(source));
    const child=spawnSync(process.execPath,['--import','tsx','tooling/catalog/materialize-agent-skills.ts'],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true});
    expect(child.status).toBe(1);expect(child.stderr).toContain('refusing to overwrite');expect(hash(await readFile(catalogPath))).toBe(before);expect(hash(await readFile(source))).toBe(contentBefore);
  });
});

describe('actual operational helper behavior',()=>{
  test('ER-064 reports real operation additions/removals and escaped JSON Pointer changes',async()=>{
    const output=run('ER-064','compare-api.mjs',await sample('ER-064'));
    expect(output.operations).toEqual({added:['POST /reports'],removed:['GET /legacy'],retained:['GET /reports']});
    expect(output.changes).toContainEqual({path:'/paths/~1reports/get/responses/200/description',kind:'changed',before:'목록',after:'페이지 목록'});
    expect(output.semanticReviewRequired).toBe(true);
    const before={openapi:'3.1.0',paths:{},info:{version:'1',title:'한빛'}};
    expect(run('ER-064','compare-api.mjs',{before,after:{info:{title:'한빛',version:'1'},paths:{},openapi:'3.1.0'}}).changes).toEqual([]);
    reject('ER-064','compare-api.mjs',{before:{},after:{}},'OpenAPI');
  });

  test('ER-065 performs real SQLite SELECT, truncates rows, rejects writes, and preserves original bytes',async()=>{
    const databasePath=path.join(directory('ER-065'),'references/example.sqlite');const before=hash(await readFile(databasePath));
    expect(run('ER-065','query-readonly.mjs',{databasePath,sql:'SELECT COUNT(*) AS count FROM projects',rowLimit:10})).toMatchObject({rows:[{count:{integerDecimal:'3'}}],truncated:false,readOnly:true});
    expect(run('ER-065','query-readonly.mjs',{databasePath,sql:'SELECT task_id FROM tasks ORDER BY task_id',rowLimit:2})).toMatchObject({rows:[{task_id:'T-001'},{task_id:'T-002'}],truncated:true});
    for(const sql of ['UPDATE projects SET status = \'closed\'','SELECT * FROM projects; DELETE FROM projects','SELECT load_extension(\'bad\')','ATTACH DATABASE \'other.db\' AS other'])reject('ER-065','query-readonly.mjs',{databasePath,sql},'restricted single SELECT');
    reject('ER-065','query-readonly.mjs',{databasePath:'relative.sqlite',sql:'SELECT 1'},'Absolute approved');
    expect(hash(await readFile(databasePath))).toBe(before);
  });

  test('ER-066 retains physical locations, original times, counts and malformed lines',async()=>{
    const output=run('ER-066','group-logs.mjs',await sample('ER-066'));
    expect(output).toEqual({sourceId:'hanbit-demo-log-v1',physicalLines:4,normalCount:1,groups:[{level:'error',code:'TIMEOUT',count:2,lines:[1,3],timestamps:['2026-10-01T09:00:00Z','2026-10-01T09:00:04Z']}],errors:[{line:4,reason:'invalid-json'}]});
    const invalid=run('ER-066','group-logs.mjs',{sourceId:'D2',text:'{"timestamp":"yesterday","level":"error","code":"X","message":"secret"}\n'});
    expect(invalid.errors).toEqual([{line:1,reason:'invalid-fields'}]);expect(JSON.stringify(invalid)).not.toContain('secret');
  });

  test('ER-067 calculates known median/p95/change values and never divides by zero',async()=>{
    const output=run('ER-067','compare-performance.mjs',await sample('ER-067'));
    expect(output.before).toEqual({count:4,mean:250,median:250,p95:400});expect(output.after).toEqual({count:4,mean:200,median:200,p95:320});
    expect(output.changes).toEqual({mean:{absolute:-50,percent:-20},median:{absolute:-50,percent:-20},p95:{absolute:-80,percent:-20}});
    expect(run('ER-067','compare-performance.mjs',{unit:'ms',before:[0],after:[5]}).changes).toMatchObject({mean:{absolute:5,percent:null}});
    reject('ER-067','compare-performance.mjs',{unit:'ms',before:[-1],after:[1]},'nonnegative');
  });

  test('ER-071 validates actual types and exact source quotes without claiming semantic correctness',async()=>{
    const input=await sample('ER-071');expect(run('ER-071','validate-records.mjs',input)).toEqual({valid:true,issues:[],semanticReviewRequired:true});
    const wrong={...input,records:[{requestId:'R-7',quantity:'2',due:null}],evidence:[{requestId:{sourceId:'D1',quote:'not in document'},quantity:{sourceId:'D1',quote:'수량 2개'}}]};
    expect(run('ER-071','validate-records.mjs',wrong)).toMatchObject({valid:false,issues:[{index:0,field:'requestId',reason:'missing-or-invalid-quote'},{index:0,field:'quantity',reason:'type'}]});
    expect(run('ER-071','validate-records.mjs',{...input,records:[{requestId:'R-7',due:null}]}).issues).toContainEqual({index:0,field:'quantity',reason:'required'});
  });

  test('ER-073 exposes ambiguous/missing citations and slices exact UTF-16 text',async()=>{
    const output=run('ER-073','map-citations.mjs',await sample('ER-073'));
    expect(output.citations).toEqual([{id:'Q1',status:'ambiguous',matches:[{page:1,start:7,endExclusive:20},{page:2,start:0,endExclusive:13}]},{id:'Q2',status:'located',matches:[{page:2,start:14,endExclusive:27}]},{id:'Q3',status:'unverified',matches:[]}]);
    expect(run('ER-073','map-citations.mjs',{pages:[{page:1,text:'😀 근거'}],citations:[{id:'Q',quote:'근거'}]}).citations).toEqual([{id:'Q',status:'located',matches:[{page:1,start:3,endExclusive:5}]}]);
    reject('ER-073','map-citations.mjs',{pages:[],citations:[{id:'Q',quote:''}]},'nonempty');
  });

  test('ER-074 computes weighted score but cannot pass a failed required item or missing evidence',async()=>{
    const input=await sample('ER-074');const output=run('ER-074','score-quality.mjs',input);
    expect(output.scorePercent).toBeCloseTo(100/3);expect(output.requiredFailures).toEqual(['ownership']);expect(output.passesRequired).toBe(false);
    expect(run('ER-074','score-quality.mjs',{...input,assessments:[]})).toMatchObject({complete:false,scorePercent:null,passesRequired:false});
    reject('ER-074','score-quality.mjs',{...input,assessments:[{id:'invented',score:1}]},'Unknown or invalid');
  });

  test('ER-075 masks every literal occurrence without logging values, mutating input or resolving overlap silently',async()=>{
    const input=await sample('ER-075');const before=JSON.stringify(input);const output=run('ER-075','mask-copy.mjs',input);
    expect(output.text).toBe('가상 담당 [REDACTED]의 내부코드는 [REDACTED]입니다. [REDACTED] 확인.');expect(output.audit).toHaveLength(3);expect(output.unmatchedRuleIds).toEqual([]);
    expect(JSON.stringify(output)).not.toContain('DEMO-SECRET-42');expect(JSON.stringify(output)).not.toContain('DEMO-PERSON-7');expect(JSON.stringify(input)).toBe(before);
    reject('ER-075','mask-copy.mjs',{text:'abc',rules:[{id:'A',type:'secret',literal:'ab'},{id:'B',type:'secret',literal:'bc'}]},'Overlapping');
    reject('ER-075','mask-copy.mjs',{text:'abc',rules:[{id:'A',type:'secret',literal:''}]},'nonempty');
  });

  test('ER-077 retains expected branch order, conflicts and missing state instead of choosing a winner',async()=>{
    const output=run('ER-077','merge-branches.mjs',await sample('ER-077'));
    expect(output.states).toEqual([{id:'A',status:'completed'},{id:'B',status:'completed'},{id:'C',status:'missing'}]);expect(output.partial).toBe(true);
    expect(output.items).toEqual([{key:'deadline',conflict:true,variants:[{value:'10일',sources:[{branchId:'A',evidence:'D1 v1'}]},{value:'12일',sources:[{branchId:'B',evidence:'D2 v2'}]}]},{key:'channel',conflict:false,variants:[{value:'web',sources:[{branchId:'A',evidence:'D1 v1'}]}]}]);
    const same=run('ER-077','merge-branches.mjs',{expectedBranchIds:['A','B'],branches:[{id:'A',status:'completed',items:[{key:'value',value:0,evidence:'D1'}]},{id:'B',status:'completed',items:[{key:'value',value:0,evidence:'D2'}]}]});
    expect(same.items).toEqual([{key:'value',conflict:false,variants:[{value:0,sources:[{branchId:'A',evidence:'D1'},{branchId:'B',evidence:'D2'}]}]}]);
    reject('ER-077','merge-branches.mjs',{expectedBranchIds:['A','A'],branches:[]},'Unique');
  });

  test('ER-079 validates topological delivery and rejects cycles or unavailable producer input',async()=>{
    expect(run('ER-079','order-team.mjs',await sample('ER-079'))).toMatchObject({order:['read','review'],executionStarted:false});
    reject('ER-079','order-team.mjs',{initialInputs:[],roles:['R'],tasks:[{id:'A',role:'R',dependsOn:['B'],inputs:[],outputs:['a']},{id:'B',role:'R',dependsOn:['A'],inputs:[],outputs:['b']}]},'cycle');
    reject('ER-079','order-team.mjs',{initialInputs:[],roles:['R'],tasks:[{id:'A',role:'R',dependsOn:[],inputs:[],outputs:['a']},{id:'B',role:'R',dependsOn:[],inputs:['a'],outputs:['b']}]},'not an ancestor');
  });

  test('ER-080 preserves completed hashes, flags new permissions and blocks unknown-outcome reexecution',async()=>{
    const input=await sample('ER-080');expect(run('ER-080','compare-plans.mjs',input)).toMatchObject({preservedCompleted:['read'],blocking:[],permissionAdditions:['network:converter'],requiresApproval:true,executionStarted:false});
    const completed={id:'A',status:'completed',action:'Read',resultSha256:'a'.repeat(64)};
    const unknown={id:'B',status:'outcome-unknown',action:'External write'};
    const output=run('ER-080','compare-plans.mjs',{before:{permissions:[],tasks:[completed,unknown]},after:{permissions:[],tasks:[{...completed,resultSha256:'b'.repeat(64)},{...unknown,status:'pending'}]}});
    expect(output.blocking).toEqual([{id:'A',reason:'completed-task-changed-or-removed'},{id:'B',reason:'external-outcome-must-be-reconciled'}]);
    reject('ER-080','compare-plans.mjs',{before:{permissions:[],tasks:[{...completed,resultSha256:'bad'}]},after:{permissions:[],tasks:[]}},'completed hashes');
  });

  test('distributed helpers reject malformed and excessive input without emitting successful output',async()=>{
    for(const id of ids){let helpers:string[];try{helpers=await readdir(path.join(directory(id),'scripts'));}catch{continue;}
      for(const helper of helpers){const child=spawnSync(process.execPath,[path.join(directory(id),'scripts',helper)],{input:'{broken',encoding:'utf8',timeout:5000,windowsHide:true});expect(child.status).toBe(1);expect(child.stdout).toBe('');}}
    const child=spawnSync(process.execPath,[path.join(directory('ER-073'),'scripts/map-citations.mjs')],{input:' '.repeat(1048577),encoding:'utf8',timeout:5000,windowsHide:true});expect(child.status).toBe(1);expect(child.stderr).toContain('1 MiB');
  });
});

describe('non-code contracts and supplied observation material',()=>{
  test('goal, role and handoff schemas reject unsupported readiness, absent outputs and fabricated completion',async()=>{
    const ajv=createSchemaValidator();
    const goal=ajv.compile(await load('ER-061','assets/goal.schema.json'));
    const partial={goal:'정리',deliverable:null,audience:null,constraints:[],acceptance:[],blockingQuestions:['원본 필요'],ambiguous:[],ready:false};
    expect(goal(partial)).toBe(true);expect(goal({...partial,ready:true})).toBe(false);
    const role=ajv.compile(await load('ER-076','assets/role-contract.schema.json'));
    expect(role({id:'R',inputs:['D1'],outputs:['report'],permissions:[],completion:'원문 대조'})).toBe(true);expect(role({id:'R',inputs:[],outputs:[],permissions:[],completion:''})).toBe(false);
    const handoff=ajv.compile(await load('ER-078','assets/handoff.schema.json'));
    const input=await sample('ER-078');const {fictional:_,...contract}=input;expect(handoff(contract)).toBe(true);
    expect(handoff({...contract,response:{taskId:'H1',status:'completed',outputs:{},evidence:[],stopReason:null}})).toBe(false);
  });

  test('accessibility source is a real local form and meeting/reader materials preserve explicit unknowns and constraints',async()=>{
    const screen=await readFile(path.join(directory('ER-068'),'references/screen.html'),'utf8');
    expect(screen).toContain('<label for="title">');expect(screen).toContain('aria-describedby="help error"');expect(screen).toContain('event.preventDefault()');expect(screen).not.toContain('fetch(');
    expect(await sample('ER-068')).toMatchObject({findingState:'not-observed',evidence:null});
    const meeting=await sample('ER-072');expect(meeting.tasks).toContainEqual({id:'T2',action:'기존 안내 링크 목록 수집',owner:null,due:null,source:'발언 4'});
    const text=await readFile(path.join(directory('ER-072'),'references/meeting.md'),'utf8');expect(text).toContain('담당자와 기한은 아직 정하지 못했습니다');
    const reader=await sample('ER-069');expect(reader.beginner).toContain('10MB');expect(reader.beginner).toContain('비밀번호');
    const alternatives=await sample('ER-063');expect(alternatives.options).toContainEqual({id:'A',values:{monthlyCost:18,offline:false}});expect(alternatives.options).toContainEqual({id:'B',values:{monthlyCost:null,offline:true}});
  });
});
