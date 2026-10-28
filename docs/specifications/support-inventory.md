# 블록·모드 지원 목록

`packages/spec/src/support-inventory.ts`는 31개 `NodeType`의 작성 화면과 기본 Runner 구현 범위를 기록하는 단일 설명 목록이다. JSON Schema의 구조·타입을 복제하거나 대체하지 않는다. 현재 편집기는 21개 블록, 기본 Runner는 제한된 모드의 28개 블록을 지원한다. 운영 예약 시작(`trigger`), 프로그램 Worker(`program`), 변경 보상(`compensate`)은 구현 목록에 넣지 않는다.

## 데이터와 소비자

- `NODE_SUPPORT_INVENTORY`: NodeType 전체를 빠짐없이 갖는 Record. `editorOrder`는 기존 팔레트 순서 또는 null, `modes`는 구현된 제한 모드, `constraints`는 공통 제한, `unavailable`은 아직 지원하지 않는 범위다.
- 각 mode는 안정적인 ID, 설명, 해당 모드의 작성 화면 제공 여부, 추가 capability, 준비할 연결·자료를 가진다. 모드 표시는 설정값을 검증하거나 기본값을 삽입하지 않는다. 외부 입력 검사는 기존 Schema/core/Runner의 책임이다.
- `EDITOR_NODE_TYPES`와 `EditorNodeType`은 이 목록에서 유도한다. 기존 input→form→ai→agent…→subworkflow의 21개 순서를 보존한다. `editor-contract.ts`의 목록만 바꾸며 `editorSupportIssues`와 서버 내보내기 검사를 유지한다.
- `DOCUMENTED_RUNNER_CAPABILITIES`는 구현 모드의 추가 capability와 해당 node capability의 합집합이다. 문서 드리프트 검사 용도이며 Runner 등록 목록이 아니다.
- `SUPPORT_INVENTORY_VERIFICATION`은 외부 서비스와 실제 호스트 실행을 현재 unverified로 유지한다. 내부 회귀·실제 파일/SQLite 검사와 외부 계정 사용 검증을 합치지 않는다.

가이드의 작성 가능 블록 목록·개수·31개 상세 설명은 위 데이터를 사용한다. 각 블록은 작성 화면, Runner의 제한 모드, 연결 요구사항, 미지원 범위를 따로 보여 준다. 새 서버 조회나 클라이언트 상태가 필요 없는 Server Component로 유지한다.

## 기능 활성화와의 분리

실제 Runner는 설치된 처리기·프로필·연결·토크나이저와 준비 검사로 기능을 판단한다. 기본 `RunnerService`에는 실제 문맥 토크나이저가 포함돼 키워드/벡터/혼합 검색과 제한된 Agentic·재순위가 선언된다. 이 설명 목록을 import해 처리기를 등록하거나 검증을 우회하지 않는다. 사용자 설치물이 기본 구현과 다르거나 필요한 계정/자료가 없으면 준비 검사가 차단해야 한다.

특히 다음 구분을 보존한다.

- `skill.instructions`는 Runner의 지침 bundle 읽기이며 Skill 코드 실행과 편집기 폼을 뜻하지 않는다.
- `tool`은 현재 실행의 파일을 읽는 등록 builtin 두 종류만 지원한다. 외부 MCP·쓰기·보상을 활성화하지 않는다.
- `agent.task`는 maxSteps=1이다. `agentic_rag`는 keyword/abstain만 지원한다. 일반 검색 블록의 vector/hybrid/reranker 지원을 Agentic 지원으로 확대하지 않는다.
- `orchestrator.plan`은 검증된 계획 데이터만 반환한다. 그 작업을 dispatch하거나 재계획하지 않는다.
- 병렬·반복·고정 에이전트 팀의 Runner 구현은 해당 작성 폼 제공을 뜻하지 않는다. 모든 하위 실행은 기존 권한·예산·대기 제한을 유지한다.
- 파일 업로드·최종 결과 전달은 PDF/OCR/Word 변환 구현이 아니다. 파일 생성과 등록은 별도의 관리 파일 처리기를 사용한다.
- 자료 ZIP과 원본 의존성 보존이 성공해도 Runner의 더 좁은 실행 자료 크기·연결·의존성 제한은 여전히 적용된다.

`workflow.completion@1`, `workflow.work_definition@1`처럼 블록 종류에 속하지 않는 공통 실행 계약은 node/mode 목록과 별도다. 전용 드리프트 시험에서 이 이름만 명시적으로 분리한다. 후자는 업무 정의 검증·보존 계약이며 Avatar 전체 구현이나 실제 문맥 소비를 뜻하지 않는다. 새로운 공통 capability가 생기면 그 계약과 시험을 검토해야 하며, 임의 접두사를 통째로 무시하지 않는다.

## 검증과 변경 순서

`tests/contracts/support-inventory.test.ts`는 canonical 31타입과의 일치, 21개 순서, 28타입 제한, 중첩 데이터 불변성, mode별 준비사항, 미지원 폼/설정의 실제 거절을 검사한다. 실제 기본 Runner를 일시적인 SQLite 저장소와 함께 생성하여 광고 capability를 비교한다. credential 접근과 fetch는 시험에서 금지하고 실제 키나 모델 결과를 만들지 않는다.

새 모드 추가 순서는 실행 계약·처리기·회귀 검증 → 명시적 capability → 설명 목록 → 작성 폼·공통 내보내기 검사 → 통합 검증이다. inventory 행만 수정해 기능이 완성된 것으로 표시하지 않는다. 현재 출시·실제 외부 연동 성공 여부는 별도 증거 gate가 판단한다.

2026-10-28 전용 기록: inventory 및 기존 editor 계약 2파일 27시험 통과(3.02초). spec 타입 검사와 새 시험을 진입점으로 수행한 strict TypeScript 검사도 통과했다. 실제 기본 Runner의 node/mode capability 일치와 네트워크·credential 접근 0건을 확인했다. 가이드의 최신 운영 빌드·브라우저 확인은 루트 통합 담당 범위이며 이 전용 시험 기록으로 대신하지 않는다.
