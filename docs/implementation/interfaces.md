# P2 공통 공개 인터페이스

이 문서는 병렬 구현의 연결 계약이다. 변경 시 모든 소비자에 통지한다.

## @studio/spec

Workflow, WorkflowNode, Binding은 JSON Schema 생성 타입. ValidationIssue={severity:'error'|'warning',stage:string,code:string,message:string,nodeId?:string,instancePath:string,hint?:string}.

ValidationResult<T>={valid:true,value:T,issues:ValidationIssue[]}|{valid:false,issues:ValidationIssue[]}.

- validateWorkflowShape(unknown): ValidationResult<Workflow>
- parseWorkflowJson(string): ValidationResult<Workflow> (중복 JSON 키 포함 엄격 검사)
- createBasicWorkflow(name?:string): Workflow
- createNode(type:NodeType): WorkflowNode
- NODE_DEFINITIONS: readonly {type:NodeType,title:string,description:string,category:string,...}[]
- getNodeDefinition(type,typeVersion=1)
- BASIC_CAPABILITIES: ['node.input@1','node.ai@1','node.output@1']

## @studio/workflow-core

- analyzeWorkflow(workflow): ValidationIssue[]
- resolveBindings(node,scope:{workflowInput:unknown,nodeOutputs:Record<string,NodeOutput>,resources?:Record<string,unknown>,error?:unknown}): Record<string,unknown>; 실패는 명확한 ContractError
- collectRequirements(workflow): {capabilities:string[],modelProfiles:string[],resourceAliases:string[]}
- createResolvedPlan(workflow,verifiedDependencies,runtimeBindings): Promise<ResolvedPlan>; 비밀정보 없는 JCS/SHA256 불변계획. WebCrypto를 사용해 Node전용 import를 피한다.
- NodeOutput={data:unknown,text?:string,files?:unknown[],sources?:unknown[],effects?:unknown[]} (실행 envelope 계약; schema 생성으로 통합 가능)

## @studio/package-kit (Node/server only)

- TargetHost='codex'|'claude-code'|'opencode'
- buildPackage({workflow,editor?,resources?:Record<string,Uint8Array>,host,metadata?}): Promise<{bytes:Uint8Array,manifest:PackageManifest}>
- inspectPackage(bytes,options?): Promise<{manifest:PackageManifest,workflow?:Workflow,files:Map<string,Uint8Array>,trust:'unsigned'|'verified',warnings:string[]}>
- canonicalDigest(value): string (JCS UTF8 SHA256)
- parseStrictJson(text): unknown (spec parser 유틸 재사용 권장)

metadata는 정식검증을 꾸며내지 않는다. 개인 unsigned 패키지에서 runtime.lock은 계약/capability와 실제 빌드구성 버전만 포함하며 host 검증은 unverified로 기록한다.

## Runner 연결

Runner는 위 spec/core/package-kit의 공개 진입점만 사용한다. 자체 내부 ModelProvider.generate(request,signal), RunStore, CredentialStore를 정의한다. HTTP/MCP는 RunnerService의 동일 start/status/events/cancel/results를 사용한다. 세부 API를 구현하는 담당자가 파일과 계약을 통지한다.
