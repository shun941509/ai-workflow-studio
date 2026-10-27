import { afterEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, readSkillMetadata, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';
import { checkCatalog } from '../../tooling/catalog/check.js';

const root=process.cwd(),python=process.env.STUDIO_CATALOG_PYTHON??(process.platform==='win32'?'python':'python3');
const catalog=JSON.parse(await readFile(path.join(root,'catalog/official/catalog.json'),'utf8')) as OfficialCatalog;
const ids=Array.from({length:10},(_,index)=>`ER-${String(index+91).padStart(3,'0')}`);
const directory=(id:string)=>path.join(root,'catalog/official/resources',id);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const bytes=(text:string)=>new TextEncoder().encode(text);
const sample=async(id:string):Promise<Record<string,unknown>>=>JSON.parse(await readFile(path.join(directory(id),'references/example-input.json'),'utf8')) as Record<string,unknown>;
const temporaryRoots:string[]=[];
async function temporary(){const value=await mkdtemp(path.join(tmpdir(),'studio-harnesses-'));temporaryRoots.push(value);return value;}
afterEach(async()=>{
  // Test cleanup is constrained to verified task-created directories, never resource or arbitrary source paths.
  for(const value of temporaryRoots.splice(0)){const resolved=path.resolve(value);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep+'studio-harnesses-'))throw new Error('Unsafe cleanup target.');await rm(resolved,{recursive:true,force:true});}
});
function invoke(id:string,helper:string,input:unknown,environment?:Record<string,string>){return spawnSync(python,[path.join(directory(id),'scripts',helper)],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,maxBuffer:3*1024*1024,windowsHide:true,env:{...process.env,...environment}});}
function run(id:string,helper:string,input:unknown,environment?:Record<string,string>):Record<string,unknown>{const child=invoke(id,helper,input,environment);expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);return JSON.parse(child.stdout) as Record<string,unknown>;}
function reject(id:string,helper:string,input:unknown,reason:string){const child=invoke(id,helper,input);expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain(reason);}

describe('harness Skill packaging and original operational content',()=>{
 test.each(ids)('%s provides distinct inspection rules and intact skill copies for three hosts',async id=>{
  const entry=catalog.entries.find(e=>e.id===id)!;expect(entry.state).toBe('implemented');expect(entry.resourceKind).toBe('skill');expect(entry.verificationRecords).toEqual([]);expect(entry.review).toBeUndefined();
  const descriptorBytes=new Uint8Array(await readFile(path.join(directory(id),'resource.json'))),descriptor=JSON.parse(decode(descriptorBytes)) as ResourceDescriptor,reference:ResourceRef={id,kind:'skill',revision:1,sha256:hash(descriptorBytes)};
  const files=new Map<string,Uint8Array>([[`resources/${id}/resource.json`,descriptorBytes]]);
  for(const file of descriptor.files){const content=new Uint8Array(await readFile(path.join(directory(id),file.path)));expect(hash(content)).toBe(file.sha256);expect(content.length).toBe(file.bytes);files.set(`resources/${id}/${file.path}`,content);}
  expect(verifyResources({[id]:reference},files).get(id)?.id).toBe(id);const skill=files.get(`resources/${id}/SKILL.md`)!,metadata=readSkillMetadata(skill);
  expect(decode(skill)).toContain(entry.definition.purpose);expect(decode(skill)).toContain(entry.definition.acceptanceCriteria);expect(decode(skill).match(/^\d+\. /gm)).toHaveLength(5);expect((await sample(id)).fictional).toBe(true);
  expect(decode(files.get(`resources/${id}/LICENSE.md`)!)).toContain('코드·스키마');
  for(const content of files.values())expect(decode(content)).not.toContain('C:/Users/ght11111');
  for(const host of ['codex','claude-code','opencode']as const){const built=await buildMaterialsPackage({host,refs:{[id]:reference},resources:Object.fromEntries(files),name:entry.name}),inspected=await inspectPackage(built.bytes);expect(inspected.manifest.purpose).toBe('production');expect(inspected.manifest.compatibility.host.verification).toBe('unverified');const archive=unzipSync(built.bytes),native=host==='codex'?'.agents/skills':host==='claude-code'?'.claude/skills':'.opencode/skills';for(const file of descriptor.files){expect(hash(archive[`${native}/${metadata.name}/${file.path}`]!)).toBe(file.sha256);expect(hash(archive[`resources/${id}/${file.path}`]!)).toBe(file.sha256);}expect(Object.keys(archive).some(name=>/(?:^|\/)(?:fixtures|tests|node_modules)(?:\/|$)|requirements-verification|verification\.spec/.test(name))).toBe(false);}
 });
 test('no regeneration and no claimed actual-host use or published completion',async()=>{
  const child=spawnSync(process.execPath,['--import','tsx','tooling/catalog/materialize-harnesses.ts'],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true});expect(child.status).toBe(1);expect(child.stderr).toContain('refusing to overwrite');
  const report=await checkCatalog(catalog,{root});expect(report.issues).toEqual([]);expect(report.releaseReady).toBe(false);expect(report.counts.usableResources).toBe(0);expect(report.counts.publishedResources).toBe(0);expect(report.counts.verifiedHostCombinations).toBe(0);
  const procedures=await Promise.all(ids.map(async id=>(await readFile(path.join(directory(id),'SKILL.md'),'utf8')).split('## 작업 절차\n\n')[1]!.split('## 실행')[0]!));expect(new Set(procedures).size).toBe(10);
 });
});

describe('real harness program decisions',()=>{
 test('ER-091 passes valid data and reports type, required, extra and uniqueness errors without coercion',async()=>{
  const input=await sample('ER-091');expect(run('ER-091','validate_contract.py',input)).toMatchObject({valid:true,issues:[]});
  const result=run('ER-091','validate_contract.py',{...input,value:{count:'3',extra:'do-not-echo',sources:['D1','D1']}});
  expect(result).toMatchObject({valid:false,issues:[{pointer:'/status',keyword:'required'},{pointer:'/count',keyword:'type'},{pointer:'/extra',keyword:'additionalProperties'},{pointer:'/sources',keyword:'uniqueItems'}]});expect(JSON.stringify(result)).not.toContain('do-not-echo');
  expect(run('ER-091','validate_contract.py',{schema:{type:'number',enum:[1]},value:1.0}).valid).toBe(true);expect(run('ER-091','validate_contract.py',{schema:{type:'array',uniqueItems:true},value:[1,1.0]}).issues).toEqual([{pointer:'',keyword:'uniqueItems'}]);
  expect(run('ER-091','validate_contract.py',{schema:{type:['number','boolean'],enum:[1]},value:true}).valid).toBe(false);
  // Preserve the lexical decimal: JSON.stringify would turn 1.0 into 1 before the Python boundary.
  const decimal=spawnSync(python,[path.join(directory('ER-091'),'scripts/validate_contract.py')],{input:'{"schema":{"type":"integer"},"value":1.0}',encoding:'utf8',windowsHide:true});expect(decimal.status,decimal.stderr).toBe(0);expect(JSON.parse(decimal.stdout).valid).toBe(true);
  reject('ER-091','validate_contract.py',{schema:{type:'string',pattern:'.*'},value:'anything'},'Unsupported contract');reject('ER-091','validate_contract.py',{schema:{type:'null'}},'Actual value');
 });
 test('ER-092 tracks new tools, paths, domains and manifest requests without granting permissions',async()=>{
  const input=await sample('ER-092');const result=run('ER-092','compare_permissions.py',input);
  expect(result).toMatchObject({grants:{tools:{added:['write-report'],removed:[]},readPaths:{added:[],removed:[]},writePaths:{added:['workspace/output'],removed:[]},domains:{added:['api.example.invalid'],removed:[]}},requestedPermissions:{added:[{kind:'connection',target:'reports'}],removed:[]},reviewRequired:true,approvalGranted:false,packageAuthenticityChecked:false});
  const before=input.before as Record<string,unknown>;expect(run('ER-092','compare_permissions.py',{before,after:before}).reviewRequired).toBe(false);
  reject('ER-092','compare_permissions.py',{before:{...before,grants:{}},after:before},'Complete package');
 });
 test('ER-093 reproduces bounded calls/tokens and exposes exceeded budgets as estimates',async()=>{
  const input=await sample('ER-093');expect(run('ER-093','estimate_usage.py',input)).toMatchObject({total:{baseCalls:3,maximumCalls:5,baseTokens:5100,maximumTokens:8100},overBudget:{calls:false,tokens:false},estimated:true,actualUsage:null});
  expect(run('ER-093','estimate_usage.py',{...input,budgets:{calls:4,tokens:8000}}).overBudget).toEqual({calls:true,tokens:true});reject('ER-093','estimate_usage.py',{...input,steps:[{id:'unknown'}]},'Complete bounded');
 });
 test('ER-094 reads actual output files and keeps zero/false while finding missing fields and broken references',async()=>{
  const input={...await sample('ER-094'),rootDirectory:path.join(directory('ER-094'),'references/output')};expect(run('ER-094','check_completeness.py',input)).toMatchObject({complete:true,issues:[],contentQualityChecked:false});
  const temp=await temporary();await writeFile(path.join(temp,'result.json'),JSON.stringify({approved:false,attachment:'missing.txt'}));
  const result=run('ER-094','check_completeness.py',{...input,rootDirectory:temp});expect(result.issues).toEqual([{kind:'missing-file',path:'summary.txt'},{kind:'missing-required-field',pointer:'/count'},{kind:'broken-file-reference',pointer:'/attachment',path:'missing.txt'}]);
  await writeFile(path.join(temp,'result.json'),JSON.stringify({count:0,approved:false,attachment:'../outside.txt'}));reject('ER-094','check_completeness.py',{...input,rootDirectory:temp},'Unsafe relative path');
 });
 test('ER-095 never retries uncertain writes and honors success, side effects and attempt limits',async()=>{
  const input=await sample('ER-095');expect(run('ER-095','assess_retry.py',input)).toMatchObject({decision:'reconcile',automaticRetryAllowed:false,requestSent:false});
  expect(run('ER-095','assess_retry.py',{...input,effect:'read'})).toMatchObject({decision:'retry-candidate',remainingAttempts:2,automaticRetryAllowed:false});
  expect(run('ER-095','assess_retry.py',{...input,outcome:'confirmed-success'}).decision).toBe('keep-success');expect(run('ER-095','assess_retry.py',{...input,outcome:'failed-after-effect'}).decision).toBe('stop');expect(run('ER-095','assess_retry.py',{...input,outcome:'failed-before-effect',attempts:3}).decision).toBe('stop');
  reject('ER-095','assess_retry.py',{...input,outcome:'probably-failed'},'Complete operation');
 });
 test('ER-096 preserves completed effects and distinguishes active cancellation from unknown outcomes',async()=>{
  const input=await sample('ER-096');const result=run('ER-096','report_cancellation.py',input);expect(result).toMatchObject({status:'cancelled-with-effects',rollbackPerformed:false});expect(result.appliedEffects).toEqual(input.effects);
  expect(run('ER-096','report_cancellation.py',{...input,nodes:[{id:'still-running',state:'running'}]})).toMatchObject({status:'cancellation-pending',activeNodes:['still-running']});
  expect(run('ER-096','report_cancellation.py',{...input,effects:[{operationId:'unknown',state:'unknown',evidence:'no response'}]}).status).toBe('attention-required');
  reject('ER-096','report_cancellation.py',{...input,effects:[{operationId:'A',state:'rolled-back',evidence:'cancel requested'}]},'Unique effect states');
 });
 test('ER-097 validates real pinned checkpoint bytes and refuses tampering or unresolved writes without resuming',async()=>{
  const input=await sample('ER-097'),rootDirectory=path.join(directory('ER-097'),'references/checkpoint');expect(run('ER-097','check_resume.py',{...input,rootDirectory})).toMatchObject({readyForReview:true,issues:[],resumeStarted:false,approvalValidityChecked:false});
  const temp=await temporary();await writeFile(path.join(temp,'workflow.json'),await readFile(path.join(rootDirectory,'workflow.json')));await writeFile(path.join(temp,'result.txt'),'changed');
  expect(run('ER-097','check_resume.py',{...input,rootDirectory:temp})).toMatchObject({readyForReview:false,issues:[{path:'result.txt',reason:'hash-or-size-mismatch'}],resumeStarted:false});
  const checkpoint=input.checkpoint as Record<string,unknown>;expect(run('ER-097','check_resume.py',{...input,rootDirectory,checkpoint:{...checkpoint,unresolvedOperations:['W-19']}}).issues).toEqual([{operationId:'W-19',reason:'external-outcome-unresolved'}]);
 });
 test('ER-098 observes actual environment presence and missing capabilities without leaking credential values',()=>{
  const input={executables:[],pythonPackages:[{name:'python-docx',version:'1.2.0'}],credentialNames:['STUDIO_HARNESS_TEST_SECRET'],requiredModes:['local-files']};const marker='test-only-secret-do-not-print';
  const child=invoke('ER-098','inspect_environment.py',input,{STUDIO_HARNESS_TEST_SECRET:marker});expect(child.status,child.stderr).toBe(0);expect(child.stdout).not.toContain(marker);expect(child.stderr).not.toContain(marker);
  expect(JSON.parse(child.stdout)).toMatchObject({state:'connections-unverified',credentials:[{name:'STUDIO_HARNESS_TEST_SECRET',state:'configured-unverified'}],authenticationTested:false,permissionsGranted:false,pythonPackages:[{name:'python-docx',state:'matched'}]});
  expect(run('ER-098','inspect_environment.py',{...input,executables:['studio-nonexistent-test-executable'],requiredModes:['native-isolated-worker']},{STUDIO_HARNESS_TEST_SECRET:''})).toMatchObject({state:'needs-setup',credentials:[{state:'missing'}],modes:[{state:'unavailable'}]});
  reject('ER-098','inspect_environment.py',{...input,executables:['node; send-secret']},'Safe executable');
 });
 test('ER-099 distinguishes allowed output changes from required loss, source changes and metric regressions',async()=>{
  const input=await sample('ER-099');const output=run('ER-099','compare_results.py',input);expect(output).toMatchObject({changes:[{pointer:'/summary',kind:'changed',allowed:true}],missingRequired:[],sourcesChanged:false,reviewRequired:false});
  const after=input.after as Record<string,unknown>;const result=run('ER-099','compare_results.py',{...input,after:{...after,output:{summary:'가상 수정 초안'},metrics:{coverage:0.4},sources:[{id:'D1',revision:2,sha256:'b'.repeat(64)}]},allowedPointers:['/summary','/count']});expect(result).toMatchObject({missingRequired:['/count'],sourcesChanged:true,reviewRequired:true});expect(result.metrics).toMatchObject([{name:'coverage',withinTolerance:false}]);
  reject('ER-099','compare_results.py',{...input,metricTolerance:{coverage:-1}},'nonnegative');
 });
 test('ER-100 validates an actual materials ZIP without extraction or implied signature/permission approval',async()=>{
  const packagePath=path.join(directory('ER-100'),'references/sample.zip');const before=hash(await readFile(packagePath));expect(run('ER-100','inspect_package.py',{packagePath})).toMatchObject({integrityValid:true,packageKind:'materials',targetHost:'codex',fileCount:9,signatureVerified:false,permissionApproved:false,workflowSemanticsValidated:false});expect(hash(await readFile(packagePath))).toBe(before);
 });
 test('ER-100 rejects actual tampered, missing, unlisted, development, traversal and case-collision ZIPs',async()=>{
  const source=unzipSync(await readFile(path.join(directory('ER-100'),'references/sample.zip'))),temp=await temporary();
  const payload=Object.keys(source).find(name=>name.endsWith('/instructions.md'))!;
  const changes:Array<{name:string;change:(files:Record<string,Uint8Array>)=>void;reason:string}>=[
   {name:'tampered',change:files=>{files[payload]=bytes('changed body');},reason:'hash/size mismatch'},
   {name:'missing',change:files=>{delete files[payload];},reason:'Declared file missing'},
   {name:'unlisted',change:files=>{files['unexpected.txt']=bytes('extra');},reason:'Unlisted file'},
   {name:'development',change:files=>{files['tests/check.py']=bytes('# forbidden development file\n');},reason:'Development or secret-only'},
   {name:'escape',change:files=>{files['../outside.txt']=bytes('escape');},reason:'Unsafe relative path'},
   {name:'case',change:files=>{files['manifest.JSON']=files['manifest.json']!;},reason:'case-colliding'},
  ];
  for(const change of changes){const files={...source};change.change(files);const packagePath=path.join(temp,change.name+'.zip');await writeFile(packagePath,zipSync(files));reject('ER-100','inspect_package.py',{packagePath},change.reason);}
  expect((await readdir(temp)).every(name=>name.endsWith('.zip'))).toBe(true);
 });
 test('all ten helpers reject malformed and duplicate JSON without successful output',async()=>{
  for(const id of ids){const helper=(await readdir(path.join(directory(id),'scripts'))).find(name=>name.endsWith('.py'))!;for(const input of ['{broken','{"value":1,"value":2}']){const child=spawnSync(python,[path.join(directory(id),'scripts',helper)],{input,encoding:'utf8',timeout:10000,windowsHide:true});expect(child.status).toBe(1);expect(child.stdout).toBe('');}}
 });
});
