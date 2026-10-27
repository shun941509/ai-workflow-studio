# P2-01~P2-11 실제 개발 명세

P2는 input→ai→output의 실제 운영 경로를 완성하는 내부 단계다. 31개 블록과 240개 예제의 출시 범위를 줄이지 않는다. 모든 코드의 공개 함수·모듈·정책/트랜잭션 경계에 주석을 작성한다. JSON 설명은 스키마/문서를 사용한다. 테스트 대역은 tests에만 두며 제품에 mock 설정을 노출하지 않는다.

## 폴더와 경계

apps/studio-web/src/{app,features/{editor,projects,resources,exports},server,config}; apps/runner/src/{cli,engine,handlers,state,providers,security,local-api,mcp}; apps/runner-ui/src/{pages,components,api}. packages/spec/{schemas,src/generated}; workflow-core/src/{validate,bindings,plan}; package-kit/src/{archive,adapters,manifest}; ui/src/{components,tokens.css}. infrastructure/supabase/{migrations,tests}; tooling/{generate-spec,check-boundaries,release}; tests/{contracts,security,integration,hosts,e2e}.

## P2-01 저장소·빌드

- 선행: P1 및 후속 구현 계획 기록.
- 파일: package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore, AGENTS.md, 각 package.json, .github/workflows/ci.yml, tooling/check-boundaries.ts.
- 순서: workspace → ESM/strict TS → 정확한 의존 버전/lock → 검사 명령 → CI/경계 검사.
- 명령 계약: generate:spec, check:generated, typecheck, test, build, check:boundaries.
- 검증: 잠금파일 설치·생성 재현성·앱간 import 금지·브라우저의 package-kit import 금지. 생성 타입 드리프트는 CI 실패.
- 완료: 선언한 런타임으로 모든 패키지 검사. Node26 로컬 성공을 Node24 배포 성공으로 기록하지 않음.

## P2-02 공통 규격

- 선행: 01.
- 파일: packages/spec/schemas/{workflow,flow,node-common,node,binding,attachment,execution,resource-ref}.schema.json, schemas/nodes/*.v1.schema.json, src/registry.ts, src/generated/, tooling/generate-spec.ts; tests/contracts/spec.test.ts.
- 공개 API: validateWorkflowShape(unknown), validateNodeShape(unknown), getNodeDefinition(type,typeVersion), createBasicWorkflow().
- 순서: 참조/Binding/execution → node → 타입별config → flow/workflow → Registry → 타입 생성.
- 구조 결과: {valid,issues}; issue={severity,stage,code,message,nodeId?,instancePath,hint?}.
- 검증: P1 예시, 누락·추가키·literal 혼합·null/missing·조건부default·미지원버전·외부ref 거부. 암묵 변환/삭제/기본값삽입 없음.
- 완료: 스키마 단일 원본. 31타입 인식과 설치된 실행 capability를 구분. 구현된 세 타입만 Runner 지원으로 광고.

## P2-03 순수 core

- 선행: 02.
- 파일: packages/workflow-core/src/validate/{graph,bindings}.ts, bindings/resolve.ts, plan/resolve.ts, index.ts; tests/contracts/workflow-core.test.ts.
- API: validateWorkflowSemantics(workflow), resolveBindings(node,scope), createResolvedPlan(workflow,verifiedDependencies,runtimeBindings).
- scope: 현재흐름 입력/완료한 같은흐름 출력/허용자료뷰/오류문맥만. 인증정보 없음.
- 순서: ID/포트 → entry/output/도달성 → 순환 → data참조·선행관계 → 자료/childflow → 불변계획.
- 검증: 없는 노드·포트, 중복, 순환, 미래 노드 참조, null/missing, JSON Pointer escape, prototype 경계, 자료 변경과 고정 참조.
- 완료: 불가능한 실행을 모델 호출 전에 설명 가능한 오류로 차단. 파일/네트워크/DB import 없음.

## P2-04 기본 Runner

- 선행: 03.
- 파일: apps/runner/src/engine/{scheduler,context}.ts, handlers/{input,ai,output,registry}.ts; tests/integration/basic-run.test.ts.
- handler 계약: execute(input,config,context)→NodeOutput. 처리기가 DB를 직접 수정하지 않음.
- 순서: 문맥/상태전이 → input/output → provider seam → ai → 결과검사·오류전파.
- input.data는 전체 입력, ai text.data는 문자열, JSON mode는 result schema, output.data는 result이며 root outputs로 검사.
- 검증: 실제 스케줄러/Binding/입출력 계약. 내부 대역은 provider 경계에만 사용. 미지원 type은 사전 차단.
- 완료: 3개 처리기의 정상/실패/취소 결과를 정확히 기록. 실제 공급자 성공은 09에서 별도 증명.

## P2-05 저장·복구

- 선행: 04.
- 파일: apps/runner/src/state/store.ts, state/migrations/001-runs.sql, engine/{recovery,request-dedup}.ts; tests/integration/recovery.test.ts.
- API: createRun,transitionNode,appendEvent,getRun,listEvents,recoverInterruptedRuns.
- 테이블: schema_migrations; plans(id,hash,body); runs(id,request_id UNIQUE,request_hash,plan_hash,status,input,created_at,cancel_requested); node_instances(id,run_id,node_id,scope,status,result); attempts(id,node_instance_id,status,started_at,ended_at,error,usage); events(run_id,sequence,type,payload,UNIQUE(run_id,sequence)); artifacts(id,run_id,path,sha256,bytes).
- 상태와 이벤트는 동일 트랜잭션. 외래키·WAL·busy timeout·마이그레이션 버전 검사.
- 검증: 재시작, 중복start, 같은ID/다른본문 충돌, 순번, 기록되지 않은 상태 변화 없음. 중단된 모델 호출은 불명 상태이며 자동 과금 재호출 금지.
- 완료: 재시작해도 완료 결과 보존. 살아 있는 실행과 복구 가능한 실행을 혼동하지 않음.

## P2-06 계정·비공개 저장

- 선행: 02.
- 파일: infrastructure/supabase/migrations/001-private-content.sql, tests/private-content.sql; apps/studio-web/src/server/{auth,projects,resources,storage}.ts.
- 테이블: profiles,projects,project_drafts,project_revisions,resources,resource_versions,resource_files.
- CRUD: 생성/목록/읽기/초안저장/불변revision/자료버전. 저장은 expectedVersion, 충돌409. 인증없는 요청401, 소유권 위반403/정보비노출404.
- RLS: auth.uid 소유자만 조회·변경. 버전은 불변. Storage private, 경로와 소유자 일치. service role 브라우저 금지.
- 순서: SQL/RLS → auth session → 서버CRUD → 충돌 → 파일 → revision snapshot.
- 검증: 사용자A/B 격리, 수정경쟁, 타인 객체/파일 URL 차단, 삭제자료 재참조 차단.
- 완료: 실제 Auth/DB/Storage 통합 증거 필요. 자격증명 없음은 준비필요 상태이며 가짜 계정으로 대체하지 않음.

## P2-07 기본 편집기

- 선행: 03,06. 스키마 안정 후 독립 UI 제작 병행 가능.
- 파일: packages/ui/src/; apps/studio-web/src/config/navigation.ts, features/editor/{WorkflowEditor,NodePalette,NodeInspector,ValidationPanel}.tsx, editor-store.ts, workflow-adapter.ts.
- 상태: workflow / editor layout / dirty revision / save state / validation issues 분리. ReactFlow를 canonical workflow로 저장하지 않음.
- 탭: 기본, 자료·도구, 입력·결과. 드래그·클릭·키보드 추가, 연결삭제, undo/redo, 오류항목 focus.
- 저장: 800ms debounce, abort/revision guard, expectedVersion, 저장중/완료/오류/충돌 구분. 브라우저 복구본은 계정 저장 완료로 표시하지 않음.
- 순서: 공통토큰/버튼 → 앱shell8메뉴 → 프로젝트목록 → canvas adapter → inspector → validation → 저장/복구.
- 검증: 브라우저 실제 조작, 새로고침, 한글이름, 키보드, 스키마오류 위치, 저장경쟁. 비활성 기능을 성공처럼 보이지 않음.
- 완료: 세 블록 프로젝트 생성·유효설정·저장·재열기. 미연결 계정이면 정확한 준비 안내.

## P2-08 운영 ZIP 3종

- 선행: 03,06. 순수 빌더는 03 후 독립 구현.
- 파일: packages/package-kit/src/{build-package,inspect-package}.ts, archive/safe-path.ts, manifest/create.ts, adapters/{codex,claude-code,opencode}.ts; tests/security/package-import.test.ts.
- API: buildPackage(snapshot,targetHost,releaseMetadata), inspectPackage(bytes,trustPolicy), createHostFiles(targetHost,descriptor).
- snapshot은 저장한 revision/hash/자료 파일. dirty화면을 묵시적으로 export하지 않음. 개인로컬 작업은 별도 명시 snapshot으로 식별하며 cloud 저장으로 가장하지 않음.
- 순서: 파일역할 allowlist → 경로 → bytehash → manifest → 호스트파일 → ZIP → importer.
- 코드/자료는 transitive dependency를 포함하고 nativefile의 설치bridge만 사용. npx latest/절대개인경로/승인우회 금지.
- 검증: 3종 파일, duplicate ZIP names, path collision/traversal, missing/extra/tamper, streaming size limits, secret/dev 제외. 검사단계 외부호출0.
- 완료: 3종 개인 미서명 운영 패키지의 생성·검사. 공식서명 완료로 표시하지 않음.

## P2-09 실제 모델·키 저장

- 선행: 04,05.
- 파일: apps/runner/src/providers/{model-provider,openai,model-broker}.ts, security/{credential-store,redaction}.ts; tests/security/secret-boundary.test.ts.
- 계약: ModelProvider.generate, CredentialStore.get/set/delete, ModelBroker.invoke. 키는 OS보안저장, DB에는 비밀 아닌 profile/credential ref만.
- 순서: 인터페이스 → Windows securestore → 실제 Responses adapter → timeout/abort/usage → JSON계약/오류비노출.
- 검증: text/JSON, 인증실패, rate-limit, abort, redaction, OS저장 실제roundtrip. 실제 API 실행 별도 기록.
- 완료: 실제 모델로 workflow 완료. 키 없음은 설정필요이며 mock fallback 없음.

## P2-10 Runner UI·MCP

- 선행: 05,08,09.
- 파일: apps/runner/src/local-api/{server,auth}.ts, mcp/{server,bridge}.ts; apps/runner-ui/src/pages/{PackagePage,ConnectionsPage,RunPage,ResultsPage}.tsx.
- HTTP/MCP는 동일 서비스계층 호출. 루프백/Host/Origin/auth, 파일은 artifactId만 받음.
- MCP tools: studio.inspect_package/validate/start/status/events/cancel/results. start requestId 멱등, events cursor, 제한된 안전payload.
- UI: 패키지검사 → 실제모델설정 → 준비상태 → 실행 → 진행/취소 → 결과. 비밀정보 브라우저영구저장 금지.
- 검증: 비인증/타origin 요청, 중복start, 잘못된package, 호스트종료후 run 유지, cursor·취소·결과경계.
- 완료: UI와 호스트가 같은 Runner 실행을 조작. Bridge부팅만으로 외부호출하지 않음.

## P2-11 설치·호스트 종단 검증

- 선행: 07~10.
- 파일: tooling/release/{build-runner,package-windows}.ts, tests/e2e/basic-workflow.spec.ts, tests/hosts/{codex,claude-code,opencode}.spec.ts, docs/implementation/P2-verification.md.
- 순서: production bundle → runtime동봉 → 깨끗한Windows → 저장/ZIP → 각호스트 → 실제모델 → 재시작/실패.
- 시나리오: 계정 생성/접속→세블록편집→저장revision→3ZIP→Runner설치/연결→호스트실행→실제결과/runId/usage→호스트재접속→오류/취소/복구→비밀/개발파일 검사.
- 완료: 개발용 Node/Python 없는 환경, 한글/공백경로, 검증된 세호스트 버전의 실제 실행 증거. 설치파일서명/공식배포는 P4로 구분.

## 의존 그래프와 병렬 소유권

01→02→03→04→05→09. 02→06. 03+06→07/08. 05+08+09→10. 07+08+10→11.
spec/core, Runner, web/UI, package-kit을 소유영역으로 나누고 root manifests/lock/생성타입은 한 통합 담당자만 변경한다.

## 증거 상태

confirmed=새 실행증거, partial=일부만, unverified=미실행, failed=실패. 구현완료와 실제서비스검증을 분리한다. Supabase/모델계정/호스트/격리/서명환경이 없어도 독립구현은 계속하되 통합완료로 집계하지 않는다.
