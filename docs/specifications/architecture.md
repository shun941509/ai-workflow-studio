# 시스템 구조와 공통 계약

## 소유 경계

apps/studio-web: Next.js/React 웹, 계정·프로젝트·공유·서버 내보내기.
apps/runner: TypeScript/Node 실행, SQLite 상태, OS 비밀정보 저장, MCP, 로컬 API.
apps/runner-ui: React/Vite 로컬 운영 화면.
packages/spec: JSON Schema 2020-12, 생성 타입, Registry와 오류 계약.
packages/workflow-core: 파일/네트워크/DB 없는 그래프·Binding·계획 검사.
packages/package-kit: ZIP·경로·해시·호스트 어댑터. 서버/Node 전용.
packages/ui: 공통 화면·토큰. 계정/실행 저장소 접근 없음.

의존 방향: spec ← workflow-core ← package-kit. 웹은 spec/core/ui, 웹 서버만 package-kit. Runner는 spec/core/package-kit, runner-ui는 spec/ui. 앱끼리 내부 import 금지. React Flow 데이터는 실행 규격의 기준이 아니다.

## 문서와 상태

workflow.json은 실행 정의, editor.json은 위치/화면, manifest.json은 배포 목록/권한 요청/호환성, runtime.lock.json은 구성요소/검증 버전이다. 실행 계획·이벤트·대기·승인은 로컬 DB, 키는 OS 보안 저장소에 둔다. ZIP에 인증정보·승인·개인 실행 이력을 넣지 않는다.

## Workflow v1

schemaVersion="1.0.0", id, revision>=1, name, entryNodeId, inputs(JSON Schema), outputs(JSON Schema), modelProfiles, resources, subworkflows, nodes, edges, policy가 필수다. description은 선택이다. 빈 map도 명시한다. inputs는 값이 아니라 스키마이며 실행 값은 start 요청에서 받는다.

노드 필수: id,type,typeVersion,label,inputBindings,config,attachments,execution. description 선택. typeVersion=1은 첫 규격이다. 각 config는 type별 판별 스키마로 검사하고 임의 키를 금지한다. Registry는 config/input/output Schema, controlPorts, requiredCapabilities, handlerId, uiDefinition을 제공한다. 사용자 패키지가 실행 모듈 경로를 handlerId로 지정할 수 없다.

31개 type: input, form, trigger, agent, ai, classify, output, tool, retrieval, knowledge, resource, skill, memory, compensate, transform, program, candidate_search, merge, condition, guardrail, evaluate, error, review, file_input, document_extract, file_output, parallel, agent_team, orchestrator, subworkflow, loop.

## Binding과 출력

from=literal(value), workflowInput(pointer,onMissing), node(nodeId,pointer,onMissing), resource(resource,pointer,onMissing), error(pointer,onMissing). onMissing=error/default/omit. default일 때만 defaultValue 필수. literal에 다른 참조 필드 금지. null과 missing을 구분하며 자동 형변환하지 않는다. JSON Pointer는 RFC6901, 빈 pointer는 루트다. prototype 키 접근을 차단한다. 인증정보는 Binding에서 읽지 못한다.

NodeOutput={data: JSON value,text?:string,files?:FileRef[],sources?:SourceRef[],effects?:EffectRef[]}. 노드 참조는 /data/... 기준이다. input.data는 실행 입력 전체, ai text 모드 data는 문자열, output.data는 result 입력이다. EffectRef는 Runner만 발행하며 모델 응답의 같은 이름 필드는 실제 변경 증거가 아니다.

## 그래프

edge={id,from:{nodeId,port},to:{nodeId,port}}. 기본 in/next, condition true/false, classify 라벨/unclassified, review accepted/rejected, 복구 가능한 오류 error, output 성공 포트 없음. 시작과 최종 출력은 흐름당 하나다. 일반 연결 순환·하위 흐름 재귀 금지. 정상 성공 경로는 최종 출력에 도달해야 한다. 합류는 merge, 동시 실행은 parallel로 표현한다. 제어 연결과 데이터 Binding을 별도로 검사한다.

merge all_active는 모든 입력 경로의 활성 여부가 결정되고 활성 경로들이 완료되면 실행한다. 비활성 분기 전체 후손을 재귀적으로 skip하지 않는다. 공유 merge가 살아 있어야 한다. 비활성 결과 Binding은 omit/default가 필요하다. 보호 차단은 error 노드로 성공 전환할 수 없다.

## 버전·검증

schemaVersion, typeVersion, 설계 revision, 배포 packageVersion, 색인 generationId, 실행 planRevision을 구분한다. 스키마는 유일한 타입 원본이다. Ajv coerceTypes/useDefaults/removeAdditional을 끄고 외부 ref 다운로드를 금지한다. 기본값은 새 노드 생성 때 기록한다. 구조 → 의미 → 준비 → 실행 결과 검사를 분리한다. 시간은 UTC, 일정은 IANA 시간대를 사용한다.

사용자 스키마의 const/enum/uniqueItems는 JavaScript 객체의 constructor가 아니라 JSON 값으로 비교한다. 객체 필드 순서와 일반/null 프로토타입 차이는 무시하고, 배열 순서·타입·필드 유무는 보존한다. -0과0은 같다. 검증 전 descriptor·크기·깊이를 확인하고 스키마만 복제해 컴파일 캐시가 호출자의 수정에 영향받지 않도록 한다. valueOf/toString/toJSON 이름의 데이터는 호출하지 않으며 원래 입력 객체는 변경하지 않는다. required는 상속받은 속성으로 충족할 수 없다.
