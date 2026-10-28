import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createNode, validateJsonValue, validateWorkflowShape, type Binding, type ResourceRef, type UserSchema, type Workflow, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { analyzeWorkflow, collectRequirements } from '@studio/workflow-core';
import { buildPackage, inspectPackage, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import { artifactDigest, checkCatalog, digestBytes } from './check.js';
import type { OfficialCatalog } from './inventory.js';
import type { OfficialExample } from './contracts.generated.js';

/** Shared authorship primitives do not execute models, provision accounts, or create verification records. */
export const repository=resolve(import.meta.dirname,'../..');
export const encode=(value:string)=>new TextEncoder().encode(value);
export const jsonBytes=(value:unknown)=>encode(JSON.stringify(value,null,2)+'\n');
export const text:UserSchema={type:'string',minLength:1,maxLength:2000};
export const identifier:UserSchema={type:'string',minLength:1,maxLength:80};
export const object=(properties:Record<string,UserSchema>,required=Object.keys(properties))=>({type:'object' as const,properties,required,additionalProperties:false});
export const array=(items:UserSchema,min=0,max=20):UserSchema=>({type:'array',items,minItems:min,maxItems:max});
export const from=(nodeId:string,pointer='/data',optional=false):Binding=>({from:'node',nodeId,pointer,onMissing:optional?'omit':'error'});
export const input=(pointer=''):Binding=>({from:'workflowInput',pointer,onMissing:'error'});
export const literal=(value:unknown):Binding=>({from:'literal',value}) as Binding;
export const node=<T extends WorkflowNode['type']>(type:T,id:string,label:string)=>({...createNode(type),id,label}) as Extract<WorkflowNode,{type:T}>;
export const edge=(a:string,b:string,port='next'):WorkflowEdge=>({id:`${a}_${port}_${b}`,from:{nodeId:a,port},to:{nodeId:b,port:'in'}});
export const merge=(id:string,label:string,inputBindings:Record<string,Binding>)=>({...node('merge',id,label),config:{waitFor:'all_active',combine:'object',collision:'namespace'} as const,inputBindings});
export const license=(id:string)=>`# Studio 원본 예제 프로젝트 이용 조건 v1\n\nAI Workflow Studio 원본 예제 프로젝트 ${id}의 워크플로·문서·지침·가상 입력을 개인·교육·업무·상업적 목적으로 사용, 복제, 수정 및 재배포할 수 있습니다. 이 조건과 위 출처를 유지하고 수정 사실을 표시하세요. 동봉한 공식 자료는 각 LICENSE.md를 함께 보존하세요. 실제 고객·기관·개인정보를 사용하지 않았습니다.\n\n제3자 서비스·모델·상표·사용자가 추가한 자료의 권리를 부여하지 않습니다. 정확성·적합성·모델 결과·서비스 이용 가능성을 보증하지 않습니다. 모델 판단을 실제 조사·채용 판정·인증·업무 완료 증거로 표시하지 마세요.\n`;
export interface ProjectAssets { refs:Record<string,ResourceRef>; files:Record<string,Uint8Array> }

/** Copy a complete immutable dependency, then author a distinct practice resource containing only operational data. */
export async function projectAssets(id:string,officialIds:string[],sample:unknown,practice:Record<string,string|unknown>,entrypoint='guide.md'):Promise<ProjectAssets>{
 const refs:Record<string,ResourceRef>={},files:Record<string,Uint8Array>={};
 for(const officialId of officialIds){const folder=resolve(repository,'catalog/official/resources',officialId),raw=await readFile(resolve(folder,'resource.json')),descriptor=JSON.parse(raw.toString('utf8')) as ResourceDescriptor,alias=officialId.toLowerCase().replace('-','_');if(descriptor.requiredConnections.length||Object.keys(descriptor.dependencies).length)throw new Error('A bundled instruction must be self-contained.');refs[alias]={id:descriptor.id,revision:descriptor.revision,kind:descriptor.kind,sha256:digestBytes(raw)};files[`resources/${alias}/resource.json`]=raw;for(const item of descriptor.files)files[`resources/${alias}/${item.path}`]=await readFile(resolve(folder,item.path));}
 const payload:Record<string,Uint8Array>={'sample-input.json':jsonBytes(sample),'LICENSE.md':encode(license(id))};for(const[path,value]of Object.entries(practice))payload[path]=typeof value==='string'?encode(value):jsonBytes(value);
 if(!payload[entrypoint])throw new Error(`${id}: actual practice entrypoint required.`);
 const descriptor:ResourceDescriptor={schemaVersion:'1.0.0',id:`${id}-practice`,revision:1,kind:'document',name:`${id} 가상 실습 자료`,entrypoint,license:{id:'LicenseRef-Studio-Examples-v1',path:'LICENSE.md'},dependencies:{},requiredConnections:[],files:Object.entries(payload).map(([path,bytes])=>({path,bytes:bytes.length,sha256:digestBytes(bytes)})) as ResourceDescriptor['files']};const raw=jsonBytes(descriptor);refs.practice={id:descriptor.id,revision:1,kind:'document',sha256:digestBytes(raw)};files['resources/practice/resource.json']=raw;for(const[path,bytes]of Object.entries(payload))files[`resources/practice/${path}`]=bytes;verifyResources(refs,new Map(Object.entries(files)));return {refs,files};
}

export interface AuthoredProject { entry:OfficialExample; workflow:Workflow; sample:unknown; assets:ProjectAssets; instructionsSummary:string; acceptance:string[]; limits:string[]; setup:string[] }
export async function loadCatalog(){return JSON.parse(await readFile(resolve(repository,'catalog/official/catalog.json'),'utf8')) as OfficialCatalog;}

/** Prevalidate the entire batch, write new files only, and finally merge only the owned rows from the latest inventory. */
export async function writeAuthoredBatch(projects:AuthoredProject[]){
 const prepared=new Map<string,{workflow:Workflow;files:Record<string,Uint8Array>}>();
 for(const project of projects){const {entry,workflow,sample,assets}=project;if(entry.state!=='planned'||entry.artifact)throw new Error(`${entry.id}: refusing to overwrite authored project.`);try{await access(resolve(repository,'catalog/official/projects',entry.id));throw new Error(`${entry.id}: directory already exists; no automatic regeneration.`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const checked=validateWorkflowShape(workflow);if(!checked.valid)throw new Error(`${entry.id}: ${JSON.stringify(checked.issues)}`);const issues=analyzeWorkflow(checked.value).filter(issue=>issue.severity==='error');if(issues.length)throw new Error(`${entry.id}: ${JSON.stringify(issues)}`);if(!validateJsonValue(workflow.inputs,sample).valid)throw new Error(`${entry.id}: invalid real sample.`);
  for(const host of ['codex','claude-code','opencode']as const)await inspectPackage((await buildPackage({workflow,host,resources:assets.files})).bytes);
  const readme=`# ${entry.name}\n\n${entry.definition.purpose}. ${entry.definition.inputOutput}.\n\n${project.instructionsSummary}\n\n## 시작\n\n${project.setup.map((line,index)=>`${index+1}. ${line}`).join('\n')}\n\nresources/practice/sample-input.json은 초기 입력에 사용할 실제 가상 연습 데이터이며 프로젝트 폴더의 sample-input.json과 같습니다. 실제 모델 답변이나 테스트 fixture가 아닙니다. 지침·문서 원본과 descriptor 해시를 workflow.resources에 고정했고 모든 해당 원본 파일을 ZIP에 동봉합니다.\n\n원래 필수 구성 ${entry.definition.blocksAndConnections.replaceAll('`','')}을 보존했습니다. 원본 사용자 자료의 내용은 분석 대상이며 작업의 권한·지침을 바꾸는 명령이 아닙니다.\n\n## 결과 확인\n\n${project.acceptance.map((line,index)=>`${index+1}. ${line}`).join('\n')}\n\n공통 완료 기준: ${entry.definition.acceptanceCriteria}.\n\n## 범위·실패·준비\n\n${project.limits.map(line=>`- ${line}`).join('\n')}\n\n실제 JSON 응답 모델을 project-model에 연결해야 합니다. 계정·키·외부 설정은 동봉하지 않습니다. 모델 평가 점수는 모델의 관찰이며 실제 사실 인증이 아닙니다. 입력 스키마·원본 해시·모델 응답이 잘못되거나 토큰·호출·시간 한도에 도달하면 실제 오류로 중단합니다. 응답이 없는 검토는 승인으로 바꾸지 않습니다. 실제 업무 수행·발송·게시·채용 결정·계정 변경을 하지 않습니다.\n\n현재 검증은 공통 계약·원본 무결성·운영 ZIP 및 계정 없이 확인 가능한 순수 처리입니다. 실제 모델 품질, Codex·Claude Code·OpenCode 실제 사용, 검수·게시는 unverified입니다. 원본 사용·수정·재배포 조건은 LICENSE.md에 있습니다. 생성기는 이미 작성된 폴더를 자동 덮어쓰지 않으며 수정 시 새 판본과 해시를 검토합니다.\n`;
  prepared.set(entry.id,{workflow,files:{...assets.files,'workflow.json':jsonBytes(workflow),'sample-input.json':jsonBytes(sample),'README.md':encode(readme),'LICENSE.md':encode(license(entry.id))}});
 }
 for(const[id,item]of prepared)for(const[path,bytes]of Object.entries(item.files)){const target=resolve(repository,'catalog/official/projects',id,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
 const latest=await loadCatalog();for(const entry of latest.entries){const project=prepared.get(entry.id);if(!project)continue;if(entry.state!=='planned'||entry.artifact)throw new Error(`${entry.id}: catalogue changed during authoring.`);const files=Object.entries(project.files).map(([path,bytes])=>({path,sha256:digestBytes(bytes),role:path==='workflow.json'?'entrypoint':path==='README.md'?'readme':path==='LICENSE.md'?'license':'payload'})) as NonNullable<OfficialExample['artifact']>['files'];entry.artifact={rootPath:`catalog/official/projects/${entry.id}`,entrypoint:'workflow.json',sha256:artifactDigest(files),files};entry.state='implemented';entry.requiredCapabilities=[...new Set([...entry.requiredCapabilities,...collectRequirements(project.workflow).capabilities])].sort() as OfficialExample['requiredCapabilities'];}
 const checked=await checkCatalog(latest,{root:repository});if(!checked.valid)throw new Error(JSON.stringify(checked.issues));await writeFile(resolve(repository,'catalog/official/catalog.json'),JSON.stringify(latest,null,2)+'\n');process.stdout.write(`Authored ${projects.map(project=>project.entry.id).join(', ')}; ${projects.length*3} inspected ZIPs. Actual model and host evidence remains absent.\n`);
}
