# 제한된 Agentic RAG 작성 계약

이 문서는 기존 `agent` 블록의 `task`와 `agentic_rag` 작성 모드를 구분한다. 실제 실행 계약은 `agentic-rag.md`와 `validateAgenticRag`를 따른다. 새 블록·호스트 실행 방식·모델을 추가하지 않는다. 순수 작성 헬퍼·전용 패널·편집기 및 내보내기 지원 검사가 같은 작성 계약을 사용한다.

## 제공 범위와 고정 경계

Agentic 모드는 현재 실행에서 만든 키워드 색인을 검색하고, 근거가 부족하면 답변을 유보한다. 추가 질문, 외부 도구, 직접 자료 첨부, 벡터·혼합·재순위·Graph 검색을 제공하지 않는다. 일반 지식·검색 블록에서 제공하는 다른 검색 모드가 Agentic 지원을 뜻하지 않는다.

|설정|기본값|작성 한도|
|---|---|---|
|전체 단계 `maxSteps`|12|3~32 정수|
|검색 라운드 `maxRounds`|3|1~4 정수|
|라운드당 질의 `maxQueriesPerRound`|2|1~3 정수|
|누적 청크 `maxRetrievedChunks`|30|1~100 정수|
|누적 문맥 `maxContextTokens`|3000|20~12000 정수|
|근거 부족 처리|`abstain`|고정|
|재시도·오류 처리|1회 시도·`fail`|고정|

각 모델 판단과 개별 검색이 각각 한 단계다. 문맥은 안내문을 포함한 `o200k_base` 검색 문맥 누적량이며 모델 과금 토큰이나 비용 상한이 아니다. 실행 전체의 모델 호출·토큰·시간 예산도 적용된다. 수치 입력을 자동으로 자르거나 반올림하지 않는다.

## 작성 헬퍼와 상태 전환

`apps/studio-web/src/features/editor/agent-authoring.ts`는 파일·네트워크·DB·Runner 앱 내부에 접근하지 않는 순수 모듈이다.

- `changeAgentStrategy(workflow, nodeId, strategy, { discardSearchSettings?: true })`는 현재 흐름의 노드 변경을 하나의 `Partial<Workflow>`로 반환한다. 기존 모델·작업 지침·결과 스키마·task/context 입력을 보존한다. 현재 전략을 다시 선택하면 아무 것도 바꾸지 않는다.
- task에서 Agentic으로 전환할 때 기존 자료 첨부, 도구 설정, 16,000자를 넘는 지침, 오류 경로 또는 재시도 설정을 자동으로 삭제하지 않고 이유를 알려 거절한다. 지원하지 않는 task 설정도 전환으로 조용히 정규화하지 않는다. 새 검색 정책은 위 기본값으로 추가하되 색인 입력이나 결과를 꾸며 넣지 않는다.
- Agentic에서 task로 바꾸면 검색 정책과 `indexes` 입력을 제거해야 한다. 패널은 제거 범위를 먼저 표시하고 명시적인 전환 버튼을 제공한다. `discardSearchSettings: true` 없이 변경할 수 없다. 나머지 노드·흐름·제어 연결은 삭제하지 않는다.
- `nextAgenticAlias(workflow)`는 `agentic_default`, `agentic_2`, … 중 미사용 이름을 찾는다.
- `addAgenticDeclaration(workflow, nodeId, alias)`는 선언과 해당 노드 참조를 한 번의 편집으로 반환한다. 기존 별칭을 덮어쓰지 않고, 프로토타입 예약어·경로·비ASCII 별칭을 거절한다.
- `validateAuthoredAgent(node, workflow?)`는 canonical 노드 구조와 task/Agentic 운영 모드 검사를 함께 수행한다. 직접 입력한 task·context·indexes의 확인 가능한 한도와 선택된 선언의 chat 종류도 검사한다. 동적 입력의 실제 값과 색인 소유·세대·키워드 종류 검증은 Runner 책임이다.

반환 patch는 기존 `editFlowDraft`/편집기 history 경로로 한 번만 적용한다. 하위 흐름의 같은 노드 ID가 기본 흐름을 변경해서는 안 되며, 프로필 선언은 프로젝트 공통 영역에 남는다. 전환·선언 한 번은 undo 한 번으로 복구되어야 한다. 고급 JSON으로 가져온 미지원 값을 단지 화면을 열었다는 이유로 바꾸지 않는다.

## 입력과 결과

필수 `task`는 공백뿐인 값을 제외한 최대 16,000자 문자열이다. 선택 `context`는 JSON 직렬화한 UTF-8 크기 16 KiB 이하이다. 필수 `indexes`는 현재 실행에 속한 서로 다른 키워드 `IndexRef` 배열 1~4개다. 편집기에서 정적으로 통과한 참조도 실행 중 소유·세대·권한 검사를 통과해야 한다.

최소 제어 흐름은 `입력 → 파일 선택 → 지식 구성(keyword) → 경로 합류(combine: array) → 에이전트(agentic_rag) → 결과`다. 지식 구성의 `/data`는 색인 하나이므로, 하나만 사용해도 합류 블록에서 배열로 감싼 `/data`를 `indexes`에 연결한다. 실제 파일 선택은 기본 흐름에서 받고, 하위 흐름에는 입력을 명시적으로 전달한다. 후속 파일 추가와 권한 변경은 기존 실행 전체 공개 범위 검사를 따른다.

Agentic 결과는 `/data/status`, `/data/result`, `/data/citations`, `/data/stopReason`, `/data/usage`를 제공한다. 답변 상태는 `answered`, `insufficient_evidence`, `conflicting_evidence`이며 유보·충돌일 때 `result`는 null이다. 결과 스키마는 답변에만 적용된다. 안전한 기본 연결 안내는 최종 JSON 결과에 `/data` 전체를 전달하는 것이다. `result`만 필수 문자열 결과로 연결하면 정상 유보가 출력 형식 오류가 될 수 있다.

인용 확인은 실제 원문·ID·권한 일치를 검사한다. 의미상의 정답이나 충돌 판단의 품질을 보증하지 않는다. 검색 실패와 정상 빈 검색, 답변 유보를 같은 성공 답변으로 표시하지 않는다.

## 모델 선언과 공개 범위

새 선언은 `{ "kind": "chat", "requiredFeatures": ["json_schema"] }`이며 기본 별칭은 `agentic_default`이다. 패키지 요구 계약 `openai-agentic-keyword-abstain-v1`에 의해 실제 Runner 연결은 OpenAI `gpt-5.4-mini-2026-03-17`로 제한된다. 같은 모델명을 사용하는 reranker/embedding 연결도 chat 역할을 대신하지 않는다.

일반 작업의 기존 프로필 선언을 변경하지 않는다. 기존 chat 별칭을 공유하면 같은 별칭을 사용하는 작업도 고정 모델 요구를 함께 받는다는 안내를 표시한다. 실제 연결과 인증정보는 Runner에서 지정한다. API 키, 개발용 모델, 테스트 응답은 패널이나 ZIP에 포함하지 않는다.

모델 판단마다 작업·참고 내용·검색에서 수집한 원문이 OpenAI의 입력 토큰 확인과 응답 생성에 전달된다. 로컬 키워드 검색 자체는 모델을 호출하지 않는다. 현재 프로필·연결·권한·예산 확인을 거치기 전에는 실제 모델 실행 성공으로 표시하지 않는다.

## 통합과 완료 기준

`agent-authoring.ts`는 순수 계약, `AgentInspector.tsx`는 편집 폼, `tests/editor/agent-authoring.test.ts`는 경계·보존 회귀를 담당한다. `editor-contract.ts`의 `editorSupportIssues`를 브라우저와 서버 내보내기가 공통으로 사용하므로 고급 JSON을 가져와도 작성 범위를 우회할 수 없다.

`OperationalInspector`의 기존 에이전트 폼은 전용 패널로 옮겼다. `ConfigInspector`, `BindingEditor`, `binding-options`, `ResourcePicker`, `resource-links`, `RagInspector`가 실제 지원 범위를 표시한다. 자료 조회가 진행되는 동안 같은 노드의 전략을 바꾸면 이전 조회를 취소하고, 순수 연결 헬퍼도 현재 전략을 다시 확인해 Agentic 첨부를 거절한다. `WorkflowEditor`의 자료 패널 키는 흐름·노드·전략을 구분한다. 기존 자료 버전·전이 의존·개인 계정 바인딩 로직은 그대로 사용한다.

필수 검증은 기본값·경계·정수·직접 입력 한도, 원본 불변성, 손실 없는 전환 거절, 명시적 검색 설정 제거, 프로필 종류/별칭, 하위 흐름 단일 patch, 미지원 설정 보존이다. 전체 통합에서는 브라우저 작성·undo/redo·저장 복구, 3종 실제 ZIP 원문과 계약 요구, 모델 미연결 차단, 기존 실제 키워드 색인/검색 회귀를 검사한다. 시험 대역은 tests 내부에만 둔다. 실제 모델 품질·3종 호스트 활용·usable·게시 검증은 별도 증거가 생기기 전까지 미검증이다.

`tests/e2e/agentic-authoring.spec.ts`는 실제 폼으로 파일 선택→키워드 색인→색인 배열→Agentic→JSON 결과를 만들고, undo·로컬 복구·3호스트 ZIP 해시 및 모델 요구를 검사한다. 각 ZIP을 실제 Runner로 가져온 뒤 모델 연결이 없으면 준비 검사가 차단하고 모델 요청은 0건임을 확인한다. 별도 시험은 추가 질문 원본의 보존·다운로드 차단과, 계정 HTTP만 시험 대역으로 바꾼 실제 자료 패널에서 같은 노드의 전략을 undo하는 동안 늦은 응답이 첨부를 만들지 않는지를 검사한다. 이 시험은 실제 Supabase Auth/RLS 또는 유료 모델·호스트 실행 검증이 아니다.
