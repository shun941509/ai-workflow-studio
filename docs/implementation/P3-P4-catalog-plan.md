# P3/P4/공식 콘텐츠 후속 구현 명세

P2 이후 계획을 이 문서로 고정한다. 각 블록 작업에는 config/input/output Schema, Registry, inspector, 자료연결, handler, 취소/복구, capability, ZIP검사, 정상/부정 시험이 함께 필요하다. 모듈·공개함수·안전 경계 주석 필수. 모든 항목은 아직 계획이다.

## P3

R=apps/runner/src, C=packages/workflow-core/src. 표의 파일은 예정 대상이며 각 작업에는 tests/conformance 또는 tests/security의 해당 시험이 동반된다.

|ID|파일/산출물|선행|완료 증거|
|---|---|---|---|
|P3-01|R/security/policy.ts,engine/budget.ts,effects/journal.ts,workers/isolation.ts|P2-11|원자적예산·작업의도·실제 Windows 파일/네트워크/프로세스 격리|
|P3-02|R/handlers/resource.ts,transform.ts; C/transform/operations.ts|01|고정자료·변환DSL·임의코드차단|
|P3-03|handlers/condition,merge,error,guardrail; C/control-flow.ts|02|all_active·skip·오류복구·보호차단 우회불가|
|P3-04|handlers/classify,evaluate; evaluation/rules.ts|02|라벨계약·규칙계산·평가결과와분기 구분|
|P3-05|handlers/form,review; waits/store.ts; approvals/service.ts; runner-ui ApprovalPage|03,04|영속대기·중복응답·검토와보안승인 분리|
|P3-06|handlers/file_input,file_output; artifacts/store.ts; security/path-policy.ts|01|실제 파일·경로/형식/크기·원본보존|
|P3-07|handlers/program; workers/host,protocol,profiles|01,05,06|고정코드·프로필·시간/메모리/네트워크/자식종료|
|P3-08|handlers/document_extract,skill; documents/extract; skills/loader; workers/document|02,07|실제 PDF/표/OCR·출처·지침/실행 Skill 구분|
|P3-09|handlers/tool,compensate; tools/broker; effects/reconcile|01,05,07|고정도구·인수승인·operationId·응답유실·보상|
|P3-10|handlers/memory,knowledge,retrieval; knowledge/index-store; providers/embeddings|08,09|기억격리·키워드/벡터·원문근거|
|P3-10A|knowledge/chunk-store,index-lifecycle; retrieval/access-scope|10|불변세대·현재ACL·삭제즉시차단·캐시무효화|
|P3-10B|retrieval/hybrid,rank-fusion,rerank; providers/rerankers|10A,01|후보정규화·RRF·재정렬·후보밖ID거부·품질|
|P3-10C|knowledge/graph/indexer,entities,relations,communities; workers/graph-index|07,10A|개체/관계/별칭/커뮤니티/요약 근거·중계·ACL|
|P3-10D|retrieval/graph-local,graph-global,graph-evidence|10C|실제관계/원문/요약 local/global 검색|
|P3-11|handlers/subworkflow; engine/child-scope; C/validate-flow-refs|05,09|입출력·고정ref·깊이·재귀/권한확대 차단|
|P3-12|handlers/loop,parallel; engine/concurrency|01,11|상한·입력순서·부분실패·취소·readonly first_match|
|P3-13|handlers/agent; agents/tool-policy,session,step-runner|04,09,11,12|허용도구·단계·예산·자식실행 추적|
|P3-13A|agents/retrieval-policy,query-planner,evidence-check|05,10A,12,13|제한된 재검색·추가질문·불충분 종료|
|P3-14|handlers/candidate_search; search/verifiers,frontier|04,07,11,12|등록검증기·탐색깊이/후보/검증상한|
|P3-15|handlers/agent_team,orchestrator; orchestration/replan,plan-history|12,13,14|역할전달·새불변계획·권한/승인재검사|
|P3-16|handlers/trigger; triggers/scheduler,trigger-state|P2-05,05,09,15|UTC/IANA·DST·중복·missed·import비활성|
|P3-17A|tests/retrieval; tooling/evaluation/run-retrieval|10B,10C,10D,13A|고정평가 Recall/MRR/nDCG·인용·유보·ACL|
|P3-17|tests/conformance/nodes; tests/e2e/advanced-workflows|P3전체|31개·공개모드·편집/실행/복구/ZIP 일치|

격리를 실증하지 못한 program/실행Skill/로컬MCP는 차단하며 전체31개 완료도 주장하지 않는다. 구현 순서를 위한 차단은 기능을 모의 구현하는 허가가 아니다.

## P4

W=apps/studio-web/src, DB=infrastructure/supabase.

|ID|파일/산출물|선행|완료 증거|
|---|---|---|---|
|P4-01|DB/migrations/002-publications.sql; W/server/publications,roles|P2-06,E-02|소유/복사/검수/배포·역할/RLS|
|P4-02|W/server/releases/create-release,dependency-graph; package-kit/materialize-resources|01,P2-08|전이의존·라이선스·해시·private공개차단|
|P4-03|W/jobs/scan-publication; features/preview; infrastructure/jobs|02,P3-07|안전미리보기·비밀/악성파일 검사·업로드코드 실행금지|
|P4-04|W/features/admin/reviews; server/releases/publish,sign-release|03|검수한해시만 서명·감사·키분리|
|P4-05|W/app/explore/projects,resources; features/library|01,02|검색·상세·독립복사·원작/권리 보존|
|P4-06|W/app/examples,examples/resources; features/admin/examples|04,05,E-02|공식두메뉴·준비조건·버전·복사/다운로드|
|P4-07|W/server/reports,revocations,dependency-impact|04,05|신고/이의/신규배포중단/영향 재검증|
|P4-08|tooling/release; R/update; infrastructure/signing|P3-17,P2-08,04|서명설치·업데이트·SBOM·취약버전·중간업데이트금지|
|P4-09|W/app/account,guide; server/observability; infrastructure/backup|01,07,08|보존/삭제·가이드·경보·큐재처리·DB+Storage 실제복원|
|P4-10|tooling/release/check-gates; tests/release; release-report|P3-17,P4전체,E-12|31개/240개/3호스트/설치/격리/복구 증거|

## 공식 예제 E

CAT=catalog/official. 기존 EP-001~120 및 ER-001~120 이름·목적·입출력·검증 기준을 유지한다. 이름 변경/번역/ZIP변형/Skill 내부파일을 별도 항목으로 세지 않는다.

|ID|대상|선행|완료|
|---|---|---|---|
|E-01|CAT/catalog.json|P1-06|240개 고유ID·목적·요구capability·자료참조|
|E-02|spec official-example/verification-record schemas|E-01,P2-02|사전조건/권리/버전/증거 계약|
|E-03|tooling/catalog/validate; tests/catalog|E-02,P2-11|중복·누락·끊긴참조·허위지원 차단|
|E-04|CAT/resources/ER-xxx 기초지침/문서/Skill|E-03,해당기능|실제본문/코드/템플릿·권리·사용법|
|E-05|CAT/resources MCP/고급Skill/RAG|E-03,해당P3|실제연결/실행/검색·실패 처리|
|E-06|CAT/projects/EP-001~060|해당자료/기능|실제입력/workflow/출력/검증|
|E-07|EP-061~100|P3-11~16중필요기능|팀/병렬/인계/재계획/부분실패|
|E-08|EP-101~120|P3검색확장|색인/인용/유보/ACL|
|E-09|tests/catalog/acceptance; tooling/catalog/verify-hosts|각예제,P3-17,P4-08|120×3 호스트 사용경로·자료활용 증거|
|E-10|관리자예제/배포/검증DB|E-09,P4-04,06|자료권리·정확한해시 검수게시|
|E-11|tests/e2e/official-examples|E-10,P4-06|두메뉴 각각120,필터/복사/다운로드|
|E-12|tooling/catalog/reverify; tests/catalog/release-gate|E-11,P4-07~09|유효게시120+120,철회/변경 재검증|

프로젝트 파일: example.json,workflow.json,editor.json,README.ko.md,sample-inputs/,licenses/,verification.spec.json. 자료: resource.json,README.ko.md,content/,licenses/,verification.spec.json. 지침/문서는 실제 소비 결과로, 코드는 실제 실행/산출물로 검증한다. 증거는 입력/결과/패키지hash,runId,런타임/호스트/모델/색인버전,검증시각,검수자에 연결한다.

제작순서: ER-011~040 지침30 → ER-041~060 문서20 → ER-001~010 MCP10(실제연결 병행) → ER-061~080 Agent Skill20 → ER-081~090 파일Skill10 → ER-091~100 하네스10 → ER-101~120 RAG20. 프로젝트는 각자 의존 자료/기능이 준비되는 순서로 제작하며 전체 묶음을 무조건 기다리지 않는다.

프로젝트분류: EP001~040 일반/전문가/페르소나/작업자40; 041~060 문서/하네스20; 061~100 팀/병렬/Sub Agent/오케스트레이션40; 101~105 기본RAG5;106~110 Agentic5;111~115 Hybrid5;116~120 GraphRAG5.

## 계획 종료와 구현 진행

P1 계약과 P2/P3/P4/E의 대상·의존·검증·완료 조건이 정리되었으므로 구축 단계로 넘어간다. 새 라이브러리/격리 실증 문제는 해당 구현 작업에서 검증한다. 모델/Supabase/외부서비스/호스트/서명 준비가 없어도 독립 구현·시험은 계속한다. 준비 없는 실제통합/게시/출시를 완료로 처리하지 않는다.
