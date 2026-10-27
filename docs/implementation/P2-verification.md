# P2 실제 구현 대조표

상세 요구·예시는 P2-detailed-spec.md와 P1-detailed-spec.md를 따른다. 초기 실행 서비스 조정은 service.ts에 모았고 순수 판정과 영속 제어를 개별 모듈로 나눴다. 파일 배치 변경으로 권한·내구성·검증 조건을 축소하지 않는다.

|작업|실제 주요 대상|선행|현재 산출물·검사|잔여 완료 조건|
|---|---|---|---|---|
|P2-01|root manifests/lock/tsconfig, tooling/run-pnpm.mjs, check-boundaries.ts, CI|P1|workspace·고정 버전·로컬 Node24 검사|원격 CI 실제 실행 별도|
|P2-02|packages/spec/schemas, registry.ts, validation.ts, strict-json.ts, generated, generate-spec.ts|01|31타입 폐쇄 스키마·생성 타입·오류|후속 모드 변경 때 회귀|
|P2-03|workflow-core/src/index.ts, expression.ts, control-flow.ts, transform/operations.ts|02|의미 검사·Binding·불변 계획·분기/변환|전 공개 모드 일치|
|P2-04|runner/src/service.ts, handlers/input/ai/output, providers/model-provider.ts|03|3블록 실제 스케줄러·결과 검사·provider 경계 시험|실제 모델 성공은09|
|P2-05|runner/state/store.ts, execution/durable-graph.ts, tests/integration|04|SQLite 상태/이벤트·멱등·예약·복구·대기|scope migration 후 회귀|
|P2-06|001-private-content.sql, 웹 server Auth/프로젝트/자료/Storage, tests/database|02|CRUD·RLS·충돌·실제 Postgres SQL|Supabase 실계정2개·Storage|
|P2-07|웹 features/editor, navigation.ts, packages/ui, e2e|03,06|기본 편집·자료 연결·복구·실제 ZIP 조작|실계정 저장/재열기·31블록 화면|
|P2-08|package-kit index/resources/archive/adapters, tests/security/package-*|03,06|3종 workflow/materials·해시/서명/경로/의존 검사|공식 서명·3호스트 실사용·완전한 lock|
|P2-09|runner providers/openai/model-broker, security/credential-store|04,05|Responses 어댑터·실제 DPAPI·키 경계·예산|실제 text/JSON/한도·실패|
|P2-10|runner local-api/server.ts, mcp/bridge.ts, runner-ui|05,08,09|동일 서비스·루프백 인증·Origin/CSRF·MCP 프로토콜|호스트 실제 도구 호출·재접속|
|P2-11|build-runner.mjs, verify-runner.ts, tests/e2e|07~10|Node24·운영 UI 동봉, 별도 프로세스9검사|서명 설치·깨끗한 Windows·3호스트 실제 모델|

## 계속할 구현 순서

1. Schema→생성 타입→의미 검사→패키지 요구 capability를 함께 갱신한다.
2. 하위 scope/반복/병렬·RAG foundation을 통합하고 전체 타입·계약·Runner 회귀를 검사한다.
3. 관리 파일을 서비스·사용자 업로드/다운로드·SQLite 기록·운영 UI에 연결한다.
4. Skill·실행 격리·도구 broker·승인/effect journal을 완성한다. 일반 child process를 샌드박스로 대체하지 않는다.
5. RAG 계약을 실제 저장/임베딩/검색에 연결해 현재 권한·삭제·인용·품질을 검사한다.
6. 지원 모드를 편집기·예제에 연결하고 준비된 실제 계정부터 실사용 증거를 확보한다.
7. 공유·검수·게시·신고·복원·서명 설치·3호스트·120+120 예제를 출시 gate로 확인한다.

계획 완료와 출시 완료는 다르다. 외부 조건이 없으면 기록하고 독립 작업을 계속한다. 모든 코드에는 모듈 역할과 중요한 상태·안전 경계 주석을 작성한다.
