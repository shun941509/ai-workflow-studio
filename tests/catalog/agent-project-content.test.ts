import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWorkflowJson, validateJsonValue, type Workflow, type WorkflowNode } from '@studio/spec';
import { analyzeWorkflow, collectRequirements, evaluateCondition, mergeValues, propagateInactiveEdges, resolveBindings, resolveNodeActivation, selectControlEdges } from '@studio/workflow-core';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { WindowsCredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { checkCatalog, digestBytes } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const ids=['EP-001','EP-003','EP-007','EP-015','EP-020'];
const root=process.cwd(),catalogPath=join(root,'catalog/official/catalog.json');
const catalog=JSON.parse(await readFile(catalogPath,'utf8')) as OfficialCatalog;
const projects=new Map<string,{workflow:Workflow;sample:Record<string,unknown>;readme:string}>();
for(const id of ids){const folder=join(root,'catalog/official/projects',id),parsed=parseWorkflowJson(await readFile(join(folder,'workflow.json'),'utf8'));if(!parsed.valid)throw new Error(`${id} invalid source workflow.`);projects.set(id,{workflow:parsed.value,sample:JSON.parse(await readFile(join(folder,'sample-input.json'),'utf8')) as Record<string,unknown>,readme:await readFile(join(folder,'README.md'),'utf8')});}
const agentFor=(workflow:Workflow)=>workflow.nodes.find((node):node is Extract<WorkflowNode,{type:'agent'}>=>node.type==='agent')!;

/** These tests exercise contracts, control flow and real packaging. They do not replace a model response or host verification. */
describe('five distinct authored operational agent projects',()=>{
 let dataDirectory:string;let store:RunStore;let service:RunnerService;
 beforeAll(async()=>{dataDirectory=await mkdtemp(join(tmpdir(),'studio-agent-projects-'));store=new RunStore(join(dataDirectory,'state.sqlite'));service=new RunnerService(store,new WindowsCredentialStore(join(dataDirectory,'credentials')),dataDirectory);});
 afterAll(async()=>{await service?.shutdown();store?.close();if(dataDirectory){const target=resolve(dataDirectory);if(dirname(target)!==resolve(tmpdir())||!target.includes('studio-agent-projects-'))throw new Error('Unsafe project test cleanup.');await rm(target,{recursive:true,force:true});}});

 test.each(ids)('%s preserves its approved purpose, core blocks, meaningful inputs and actual scalar task binding',async id=>{
  const {workflow,sample,readme}=projects.get(id)!;const entry=catalog.entries.find(item=>item.id===id)!;
  expect(entry.state).toBe('implemented');expect(entry.verificationRecords).toEqual([]);expect(entry.review).toBeUndefined();expect(workflow.name).toBe(entry.name);expect(readme).toContain(entry.definition.acceptanceCriteria);
  for(const block of entry.blocks)expect(workflow.nodes.map(node=>node.type)).toContain(block);
  expect(analyzeWorkflow(workflow).filter(issue=>issue.severity==='error')).toEqual([]);expect(validateJsonValue(workflow.inputs,sample).valid).toBe(true);
  expect(validateJsonValue(workflow.inputs,{...sample,goal:''}).valid).toBe(false);expect(validateJsonValue(workflow.inputs,{...sample,undeclared:'extra'}).valid).toBe(false);
  const agent=agentFor(workflow);expect(agent.config.strategy).toBe('task');expect(agent.config.maxSteps).toBe(1);expect(agent.config.toolAllowlist).toEqual([]);expect(agent.inputBindings.indexes).toBeUndefined();
  expect(resolveBindings(agent,{workflowInput:sample,nodeOutputs:{request:{data:sample}}})).toEqual({task:sample.goal,context:sample});
  expect(workflow.nodes.filter(node=>node.type==='output')).toHaveLength(1);expect(workflow.policy.limits.maxModelCalls).toBe(id==='EP-003'?1:2);
  expect((await readdir(join(root,entry.artifact!.rootPath))).sort()).toEqual(['LICENSE.md','README.md','sample-input.json','workflow.json']);
  for(const file of entry.artifact!.files)expect(digestBytes(await readFile(join(root,entry.artifact!.rootPath,file.path)))).toBe(file.sha256);
  expect(readme).toContain('실제 모델의 결과 품질');expect(readme).toContain('가상 연습자료');
 });

 test.each(ids)('%s builds and imports three real host ZIPs; only the absent actual model blocks execution',async id=>{
  const {workflow,sample}=projects.get(id)!;
  for(const host of ['codex','claude-code','opencode']as const){const built=await buildPackage({workflow,host}),inspected=await inspectPackage(built.bytes);expect(inspected.workflow).toEqual(workflow);expect(inspected.manifest.purpose).toBe('production');expect(inspected.manifest.compatibility.host.verification).toBe('unverified');expect(inspected.manifest.requiredCapabilities).toContain('agent.single_step@1');
   const imported=await service.importPackage(built.bytes),readiness=await service.validate(imported.packageHandle,{});expect(readiness.ready).toBe(false);expect(readiness.issues.filter(issue=>issue.severity==='error').map(issue=>issue.code)).toEqual(['MODEL_PROFILE_REQUIRED']);
   await expect(service.start({packageHandle:imported.packageHandle,requestId:`${id}_${host}`,inputs:sample,modelBindings:{}})).rejects.toMatchObject({code:'WORKFLOW_NOT_READY'});expect(store.listRuns()).toHaveLength(0);
  }
 },15000);

 test('distinct authored instructions are not renamed copies and release evidence stays absent',async()=>{
  expect(new Set([...projects.values()].map(project=>agentFor(project.workflow).config.instructions)).size).toBe(5);
  const report=await checkCatalog(catalog,{root});expect(report.issues).toEqual([]);expect(report.releaseReady).toBe(false);expect(report.counts.usableProjects).toBe(0);expect(report.counts.publishedProjects).toBe(0);expect(report.counts.verifiedHostCombinations).toBe(0);
  const snapshot=digestBytes(await readFile(catalogPath));const child=spawnSync(process.execPath,['--import','tsx','tooling/catalog/materialize-agent-projects.ts','--recover-identical'],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true});expect(child.status).toBe(1);expect(child.stderr).toContain('refusing to overwrite');expect(digestBytes(await readFile(catalogPath))).toBe(snapshot);
 });
});

describe('purpose-specific workflow and acceptance boundaries',()=>{
 test('EP-001 retains every request and unknown owner/deadline; classification branches merge before review',()=>{
  const {workflow,sample,readme}=projects.get('EP-001')!;const requests=sample.requests as Array<{id:string;owner:string|null;due:string|null}>;
  expect(requests.map(request=>request.id)).toEqual(['R1','R2','R3']);expect(requests[0]).toMatchObject({owner:null,due:null});expect(requests[1]).toMatchObject({owner:'문서 담당',due:null});
  expect(agentFor(workflow).config.instructions).toContain('mapping에 정확히 한 번');expect(readme).toContain('R1과 R3을 하나');expect(validateJsonValue(workflow.inputs,{...sample,requests:[]}).valid).toBe(false);
  const classification=workflow.nodes.find(node=>node.type==='classify')!;expect(classification.type).toBe('classify');
  for(const port of ['ready_for_review','needs_clarification','unclassified']){
   const selected=selectControlEdges('triage',port,workflow.edges),incoming=workflow.edges.filter(edge=>edge.to.nodeId==='packet').map(edge=>({edgeId:edge.id,state:selected[edge.id]!,...(selected[edge.id]==='active'?{outcome:'succeeded' as const}:{})}));
   expect(resolveNodeActivation({nodeId:'packet',entryNodeId:workflow.entryNodeId,incoming,waitFor:'all_active'}).state).toBe('ready');
  }
  // This is an explicit rejected review protocol value, not a generated or substituted model answer.
  const reviewed=workflow.nodes.find((node):node is Extract<WorkflowNode,{type:'merge'}>=>node.id==='reviewed'&&node.type==='merge')!;
  const decision={decision:'rejected',feedback:{sourceCoverageChecked:false,constraintsChecked:false,notes:'원문 매핑 재검토 필요'}};
  const bindings=resolveBindings(reviewed,{workflowInput:sample,nodeOutputs:{packet:{data:{proposal:{},triage:{label:'unclassified',reason:'insufficient'}}},review:{data:decision}}});expect(mergeValues(bindings,reviewed.config)).toMatchObject({review:decision});
 });

 test('EP-003 has two actual done records and rejection skips all file serialization and storage',()=>{
  const {workflow,sample,readme}=projects.get('EP-003')!;const records=sample.records as Array<{id:string;status:string;evidence:string|null}>;
  expect(records.filter(record=>record.status==='done').map(record=>record.id)).toEqual(['T1','T3']);expect(records.find(record=>record.id==='T4')?.evidence).toBeNull();expect(readme).toContain('완료 건수는 2');
  const chosen=selectControlEdges('review','rejected',workflow.edges);const propagated=propagateInactiveEdges(workflow,chosen);expect(propagated.skippedNodeIds).toContain('format');expect(propagated.skippedNodeIds).toContain('save');expect(propagated.skippedNodeIds).not.toContain('finish');
  const saved=workflow.nodes.find((node):node is Extract<WorkflowNode,{type:'merge'}>=>node.id==='saved'&&node.type==='merge')!;
  const decision={decision:'rejected',feedback:{sourceCoverageChecked:false,constraintsChecked:false,notes:'완료 건수 대조 실패'}};
  const output=mergeValues(resolveBindings(saved,{workflowInput:sample,nodeOutputs:{review:{data:decision}}}),saved.config);expect(output).toEqual({review:decision});expect(validateJsonValue(workflow.outputs,output).valid).toBe(true);
  const file=workflow.nodes.find(node=>node.type==='file_output')!;expect(file.config).toEqual({format:'markdown',filename:'weekly-report.md',outputDirectory:'outputs'});
  expect(validateJsonValue(workflow.inputs,{...sample,records:[{...records[0],status:'probably-done'}]}).valid).toBe(false);
 });

 test.each(['EP-007','EP-015','EP-020'])('%s rejects missing evaluation criteria and cannot average a failed required score into a pass',id=>{
  const {workflow}=projects.get(id)!;const evaluation=workflow.nodes.find((node):node is Extract<WorkflowNode,{type:'evaluate'}>=>node.type==='evaluate')!;
  const criteria=id==='EP-007'?['completion','constraints','dependencies']:id==='EP-015'?['coverage','observable','honesty']:['dependency_order','verification','recovery'];
  const scores=Object.fromEntries(criteria.map(key=>[key,1]));const evidence=criteria.map(ruleId=>({ruleId,reason:'검사 계약의 단위 시험용 근거 문자열이며 실제 모델 결과가 아님'}));
  expect(evaluateCondition(evaluation.config.passRule,{scores,evidence,value:{}})).toBe(true);expect(evaluateCondition(evaluation.config.passRule,{scores:{...scores,[criteria[0]!]:0},evidence,value:{}})).toBe(false);
  expect(validateJsonValue(evaluation.config.resultSchema,{scores,passed:true,evidence}).valid).toBe(true);expect(validateJsonValue(evaluation.config.resultSchema,{scores:{},passed:true,evidence:[]}).valid).toBe(false);
  expect(collectRequirements(workflow).capabilities).toContain('evaluate.model@1');
 });

 test('EP-007 requires constraints and explicit per-step checks while preserving absent approval dates',()=>{
  const {workflow,sample,readme}=projects.get('EP-007')!;expect(validateJsonValue(workflow.inputs,{...sample,constraints:[]}).valid).toBe(false);expect(validateJsonValue(workflow.inputs,{...sample,availableInputs:[]}).valid).toBe(true);
  expect(agentFor(workflow).config.instructions).toContain('completion.check');expect(agentFor(workflow).config.instructions).toContain('constraintCoverage에 정확히 한 번');expect(readme).toContain('승인 기한이 미정');expect(workflow.nodes.some(node=>node.type==='review')).toBe(true);
 });

 test('EP-015 designs verification without converting planned checks into executed results',()=>{
  const {workflow,sample,readme}=projects.get('EP-015')!;expect((sample.requirements as Array<{id:string}>).map(requirement=>requirement.id)).toEqual(['REQ1','REQ2','REQ3']);expect(validateJsonValue(workflow.inputs,{...sample,availableEvidence:[]}).valid).toBe(true);
  expect(agentFor(workflow).config.instructions).toContain('모든 executionState는 not-run');expect(readme).toContain('테스트 서버 미준비');expect(workflow.nodes.some(node=>node.type==='review')).toBe(false);
  const schemaProbe={traceability:[{requirementId:'REQ1',target:'이름 필드',method:'빈 값 제출',passCondition:'제출 차단',expectedEvidence:'화면 위치',evidenceIds:[],executionState:'passed',gaps:[]}],unresolved:[]};
  expect(validateJsonValue(agentFor(workflow).config.resultSchema,schemaProbe).valid).toBe(false);expect(validateJsonValue(agentFor(workflow).config.resultSchema,{...schemaProbe,traceability:[{...schemaProbe.traceability[0],executionState:'not-run'}]}).valid).toBe(true);
 });

 test('EP-020 requires recovery evidence and planned state, retaining unconfirmed backup readiness',()=>{
  const {workflow,sample,readme}=projects.get('EP-020')!;expect(sample.backupState).toBeNull();expect(validateJsonValue(workflow.inputs,{...sample,current:[]}).valid).toBe(false);expect(agentFor(workflow).config.instructions).toContain('backupState=null');expect(readme).toContain('web→files에서 web→objects');
  const stage={id:'prepare',action:'연결 준비 사항 확인',dependsOn:[],affectedComponents:['objects'],preconditions:['연결 상태 확인'],verification:{method:'읽기 결과 대조',expected:'기존 내용과 일치'},constraintIds:['C1'],executionState:'planned'};
  expect(validateJsonValue(agentFor(workflow).config.resultSchema,{stages:[stage],dependencyNotes:['web 의존 대조'],unresolved:['백업 미확인']}).valid).toBe(false);
  expect(validateJsonValue(agentFor(workflow).config.resultSchema,{stages:[{...stage,rollback:{trigger:'읽기 결과 불일치',actions:['기존 읽기 경로 유지'],limits:'백업 복원 가능 여부 미확인'}}],dependencyNotes:['web 의존 대조'],unresolved:['백업 미확인']}).valid).toBe(true);
 });
});
