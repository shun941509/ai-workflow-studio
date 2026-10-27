# 전체 통합 개발 체크리스트

> 이전 계획 답변의 원문을 보존한 설계 기준입니다. 아래의 ‘구현하지 않음’은 당시 상태이며, 현재 구현·검증 상태는 `docs/implementation/status.md`를 따릅니다. 출시 수량은 이후 확정한 각각 120개 전체 검증·게시 기준을 적용합니다.

**구현은 진행하지 않고, 아래 내용을 최종 통합 개발 계획으로 정리합니다.** 코드·폴더·예제 파일은 생성하거나 수정하지 않았습니다.

이번 계획의 정식 출시 범위는 **31개 블록, Studio Runner, Codex·Claude Code·OpenCode용 운영 ZIP, 예제 프로젝트 120개, 예제 자료 및 도구 120개, Agentic RAG·Hybrid RAG·GraphRAG 확장**입니다. 기존의 ‘각 100개 이상’ 기준은 **각 120개 전체의 실제 사용 검증·게시 완료**로 갱신합니다.

---

**1. 제품 범위와 운영 원칙을 다음과 같이 고정합니다.**

| 구분 | 최종 기준 |
|---|---|
| 주요 사용자 | 비전문가 사용자, 전문가 관리자 |
| 핵심 흐름 | 예제 선택 또는 새로 만들기 → 블록 구성 → 자료 연결 → 준비 상태 확인 → ZIP 다운로드 → 기존 AI 도구에서 실행 |
| 편집기 | 운영에 필요한 블록·설정·검증·다운로드 기능 제공 |
| 실행 엔진 | Studio Runner 하나가 31개 블록의 실행 순서·상태·권한·복구를 담당 |
| AI 도구 연동 | Codex·Claude Code·OpenCode가 Studio MCP를 통해 같은 Runner 사용 |
| 공식 프로젝트 | 기존에 정한 `EP-001~EP-120` 전체 |
| 공식 자료 및 도구 | 기존에 정한 `ER-001~ER-120` 전체 |
| RAG 확장 | 기존 블록의 설정·실행 기능 확장으로 구현. 블록 수는 31개 유지 |
| 우선 지원 환경 | Windows. 정확한 지원 버전·에디션·AI 도구 버전은 호환성 시험 후 고정 |
| 배포 방식 | Studio Runner 설치 프로그램 + 프로젝트별 작은 ZIP |
| 실제 사용 조건 | 필요한 계정·연결·모델·권한·비용 조건을 다운로드 전에 표시 |
| 출시 완료 판단 | 코드 작성뿐 아니라 실제 실행·배포·복구·예제 검증까지 통과 |

**운영용만 제공한다는 기준**은 다음과 같습니다.

| 운영 제품에 포함 | 운영 제품에서 제외 |
|---|---|
| 실제 실행, 연결 점검, 권한 확인, 진행 상태, 오류 안내, 취소·복구 | 개발 모드, 가짜 성공 결과, 모의 모델 선택 |
| 실제 사용할 `SKILL.md`, 코드, 템플릿, 참조 문서 | 개발 서버 실행 안내, 테스트 키, 내부 테스트 fixture |
| 사용자가 직접 품질을 확인하는 운영 하네스·평가 자료 | 내부 CI용 검증 명세·개발 전용 실행 도구 |
| 예제임을 표시한 실제 사용 가능한 입력 자료 | 내용을 채우지 않은 샘플, 기능 없는 버튼, 실행되지 않는 예제 |

내부 개발·검증 환경에는 테스트 도구가 필요합니다. 다만 **사용자에게 제공하는 편집기와 ZIP에는 포함하지 않습니다.**

---

**2. 메뉴와 편집기 구성을 확정합니다.**

| 메뉴 | 경로 | 역할 |
|---|---|---|
| 홈 | `/` | 최근 프로젝트, 이어서 작업, 시작 안내 |
| 내 프로젝트 | `/projects` | 소유 프로젝트 관리 |
| 도구 및 자료 | `/resources` | 보유한 MCP 연결 정의·작업 지침·문서·Skill 관리 |
| 프로젝트 둘러보기 | `/explore/projects` | 다른 사용자가 공유한 프로젝트 탐색·복사 |
| 도구 및 자료 둘러보기 | `/explore/resources` | 다른 사용자가 공유한 자료 탐색·가져오기 |
| 예제 프로젝트 | `/examples` | 관리자가 제공하는 공식 프로젝트 120개 |
| 예제 자료 및 도구 | `/examples/resources` | 관리자가 제공하는 공식 자료 및 도구 120개 |
| 사용 가이드 | `/guide` | 만들기·다운로드·실행·문제 해결 안내 |

프로필 버튼을 누르면 `/account`로 이동합니다. **프로필·설정과 관리자 화면은 일반 사이드 메뉴에 추가하지 않습니다.** `워크플로 만들기`는 주요 행동 버튼으로 제공합니다.

편집기는 기존 디자인 방향을 유지합니다.

- 밝은 배경, 흰색 패널, 파란색 주요 버튼.
- 왼쪽: 블록·도구 및 자료.
- 가운데: 워크플로 캔버스.
- 오른쪽: **기본 / 자료·도구 / 입력·결과** 탭.
- 상단: 프로젝트 이름, 저장 상태, 준비 상태 확인, ZIP 다운로드.
- 고급 설정은 각 탭 안에서 펼쳐 보기.
- 끌어 놓기 외에 클릭·키보드 추가, 실행 취소·다시 실행 지원.
- 오류는 해당 블록과 설정 항목으로 바로 이동.
- 연결·권한·비용·실행 환경 안내는 운영 기능으로 유지.

---

**3. 기술 구성과 책임을 고정합니다.**

| 영역 | 기술·구조 | 책임 |
|---|---|---|
| 웹 | TypeScript, React, Next.js | 프로젝트·자료 관리, 편집기, 공유, 관리자 기능 |
| 캔버스 | React Flow | 블록 배치와 연결 표현 |
| UI | Tailwind CSS, shadcn/ui | 공통 화면·접근성·입력 컴포넌트 |
| 공통 규격 | JSON Schema 2020-12, Ajv, 생성된 TypeScript 타입 | 편집기·Runner·ZIP의 동일한 데이터 계약 |
| Runner | TypeScript, Node.js | 실행 제어, 도구 호출, 상태 저장, 승인·복구 |
| Runner 화면 | React, Vite | 로컬 설정·실행 상태·사용자 확인 |
| 로컬 저장 | SQLite, OS 보안 저장소 | 실행 기록·색인 메타데이터와 비밀정보 분리 |
| 웹 저장 | Supabase Auth·Postgres·Storage | 계정, 프로젝트, 버전, 공개 자료, 파일 |
| 문서·그래프 작업 | 격리된 Worker, 필요한 경우 Python | OCR·문서 변환·GraphRAG 색인 |
| 품질 관리 | pnpm workspace, Vitest, Playwright, GitHub Actions | 규격·보안·통합·배포 검증 |

React Flow의 화면 데이터를 그대로 실행 규격으로 저장하지 않습니다. `workflow.json`이 실행 설계의 기준이며, 화면 배치는 `editor.json`에 따로 저장합니다.

실행 구조는 다음과 같습니다.

```text
웹 편집기
  └─ 운영 ZIP 생성
       └─ Codex / Claude Code / OpenCode
            └─ Studio MCP Bridge
                 └─ Studio Runner
                      ├─ 실행 상태·예산·승인 관리
                      ├─ 모델·MCP 호출 중계
                      ├─ 파일·지식·검색 관리
                      └─ 격리된 코드·문서·GraphRAG Worker
```

MCP Bridge 연결이 끊겨도 Runner의 실행 기록과 대기 상태는 유지합니다. Runner가 사용하는 모델 인증·과금은 사용 중인 AI 도구의 로그인·구독과 구분합니다.

---

**4. 대상 파일은 다음 구조를 기준으로 배정합니다.**

아래는 모두 **앞으로 생성할 예정 경로**입니다. 프로젝트 루트는 `C:\Users\ght11111\Documents\Codex\ai-workflow-studio`이며, 표에서는 아래 약어를 사용합니다.

| 약어 | 예정 경로 |
|---|---|
| `D` | `docs/specifications` |
| `S` | `packages/spec` |
| `C` | `packages/workflow-core` |
| `K` | `packages/package-kit` |
| `UI` | `packages/ui` |
| `W` | `apps/studio-web` |
| `R` | `apps/runner` |
| `U` | `apps/runner-ui` |
| `DB` | `infrastructure/supabase` |
| `CAT` | `catalog/official` |
| `T` | `tests` |

```text
apps/
  studio-web/
  runner/
  runner-ui/

packages/
  spec/
  workflow-core/
  package-kit/
  ui/

catalog/official/
  catalog.json
  projects/EP-001/ ... EP-120/
  resources/ER-001/ ... ER-120/

docs/specifications/
infrastructure/
tooling/
tests/
```

`workflow-core`는 파일·네트워크·DB에 접근하지 않는 순수 검증·해석 코드로 유지합니다. 앱끼리 내부 코드를 직접 가져오지 않고 공통 패키지를 사용합니다.

---

**5. 1단계 — 데이터·실행·배포 규격을 먼저 확정합니다.**

각 표의 `☐`는 아직 완료하지 않은 개발 작업입니다. 선행 작업이 충족되면 병렬로 진행할 수 있습니다.

| 순서·작업 | 대상 파일 | 선행 관계 | 산출물·완료 기준 |
|---|---|---|---|
| ☐ **P1-01 제품 범위·메뉴 고정** | `D/product-scope.md`, `navigation.md`, `production-policy.md` | 없음 | 8개 메뉴, 프로필 이동, 운영용 정책, 120+120 출시 범위 명시 |
| ☐ **P1-02 데이터 계약 설계** | `D/workflow-format.md`, `resource-references.md`, `retrieval-contract.md` | P1-01 | 노드·연결·입력 바인딩·자료 참조·검색 결과·색인 버전 정의 |
| ☐ **P1-03 31개 블록 계약** | `D/node-contracts.md`, `support-matrix.md` | P1-02 | 각 블록의 설정·입출력·제어 포트·자료 연결·지원 모드 확정 |
| ☐ **P1-04 실행·안전 계약** | `D/execution-semantics.md`, `runner-protocol.md`, `worker-contract.md`, `security-boundaries.md` | P1-02~03 | 대기·승인·취소·재시도·복구·병렬 예산·Worker 경계 정의 |
| ☐ **P1-05 ZIP·호스트·버전 계약** | `D/package-format.md`, `host-adapters.md`, `version-policy.md` | P1-02, P1-04 | ZIP 파일 목록·해시·서명·호환성·마이그레이션·색인 포함 정책 정의 |
| ☐ **P1-06 검증·출시 계약** | `D/conformance-plan.md`, `official-examples.md`, `release-gates.md` | P1-01~05 | 31개 블록과 240개 예제의 검증 방식, 지원 조합, 출시 차단 조건 확정 |

P1-02~05에서 다음 사항은 반드시 명문화합니다.

| 계약 | 확정 내용 |
|---|---|
| 공통 노드 | `id`, `type`, `typeVersion`, `label`, `inputBindings`, `config`, `attachments`, `execution` |
| 입력 바인딩 | 리터럴·프로젝트 입력·이전 노드·자료·오류 참조를 구분. 누락·기본값·null 처리 명시 |
| 제어 흐름 | 실행 연결과 데이터 연결 분리. 임의 순환 금지, 반복은 `loop` 사용 |
| 자료 연결 | 자료 ID·버전·해시 고정. 자료 첨부가 실행 권한 부여를 의미하지 않음 |
| 실행 식별 | `runId`, `nodeInstanceId`, `attemptId`, 외부 변경의 `operationId` 분리 |
| 외부 변경 | 실행 의도를 먼저 기록. 결과 불명 상태를 무조건 재시도하지 않음 |
| 승인 | 실제 대상·인수·계획 해시에 연결. 검토 블록과 보안 승인은 구분 |
| 버전 | 실행 중 정의·자료·색인·모델 설정을 몰래 변경하지 않음 |
| 검색 출처 | 문서·청크·버전·페이지 또는 범위·접근 범위 기록 |
| ZIP 색인 | 재생성할지, 배포 가능한 고정 색인을 포함할지 명시 |

**1단계 완료 조건:** 같은 예제를 편집기·Runner·ZIP 관점에서 해석했을 때 데이터와 실행 의미가 일치해야 합니다.

---

**6. 2단계 — 작은 워크플로를 실제로 만드는 것부터 다운로드·실행까지 연결합니다.**

이 단계에서는 `input → ai → output`을 먼저 완성합니다. 이는 내부 개발 기준점이며, 최종 출시 범위를 3개 블록으로 줄이는 것이 아닙니다.

| 순서·작업 | 대상 파일 | 선행 관계 | 산출물·완료 기준 |
|---|---|---|---|
| ☐ **P2-01 저장소·빌드 기반** | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.github/workflows/ci.yml` | P1 전체 | 앱·패키지 빌드, 타입 검사, 의존 방향 검사 통과 |
| ☐ **P2-02 공통 스키마·타입 생성** | `S/schemas/*.schema.json`, `S/src/registry.ts`, `tooling/generate-spec.ts` | P2-01 | 하나의 스키마에서 타입·검증기 생성. 중복 규격 제거 |
| ☐ **P2-03 그래프·바인딩 검증** | `C/src/validate-graph.ts`, `resolve-bindings.ts`, `resolve-plan.ts` | P2-02 | 잘못된 연결·누락 입력·순환·잘못된 자료 참조 차단 |
| ☐ **P2-04 기본 실행 엔진** | `R/src/engine/scheduler.ts`, `handlers/input.ts`, `ai.ts`, `output.ts` | P2-03 | 3개 블록의 실행 순서·결과 계약·오류 상태 구현 |
| ☐ **P2-05 실행 저장·복구 기반** | `R/src/state/store.ts`, `state/migrations/001-runs.sql`, `engine/recovery.ts` | P2-04 | 재시작 후 상태 복구, 요청 중복 방지, 실행 식별자 보존 |
| ☐ **P2-06 계정·비공개 프로젝트** | `DB/migrations/001-private-content.sql`, `W/src/server/projects.ts`, `resources.ts` | P2-02 | 소유자 권한·초안·버전 저장. 다른 사용자 자료 접근 차단 |
| ☐ **P2-07 공통 UI·편집기** | `UI/src/`, `W/src/config/navigation.ts`, `features/editor/WorkflowEditor.tsx`, `NodeInspector.tsx` | P2-03, P2-06 | 8개 메뉴 구조, 캔버스, 오른쪽 3탭, 저장·복구·오류 이동 |
| ☐ **P2-08 ZIP 생성·가져오기** | `K/src/build-package.ts`, `inspect-package.ts`, `adapters/codex.ts`, `claude-code.ts`, `opencode.ts` | P2-03, P2-06 | 호스트별 ZIP 생성, 경로·해시·파일 목록·비밀정보 검사 |
| ☐ **P2-09 실제 모델·자격증명** | `R/src/providers/model-provider.ts`, `providers/openai.ts`, `security/credential-store.ts` | P2-04~05 | 실제 모델 호출, OS 보안 저장, 로그·ZIP에 비밀정보 미포함 |
| ☐ **P2-10 Runner 화면·Studio MCP** | `R/src/mcp/server.ts`, `bridge.ts`, `local-api/server.ts`, `U/src/pages/RunPage.tsx` | P2-05, P2-08~09 | 시작·조회·취소·결과 회수, 로컬 인증, 연결 종료 후 상태 유지 |
| ☐ **P2-11 처음부터 끝까지 검증** | `T/e2e/basic-workflow.spec.ts`, `T/hosts/`, `tooling/release/build-runner.ts` | P2-07~10 | 깨끗한 Windows 환경에서 세 호스트로 실제 결과 생성 |

**2단계 완료 조건:** 사용자 흐름으로 프로젝트를 저장하고 ZIP을 받은 뒤, Codex·Claude Code·OpenCode 각각에서 실제 AI 결과를 얻을 수 있어야 합니다.

---

**7. 3단계 — 나머지 28개 블록과 RAG 확장을 구현합니다.**

모든 블록 작업에는 **스키마·실행 처리·오른쪽 설정 패널·자료 연결·ZIP 호환 검사·검증 코드**가 함께 포함됩니다. 실행 코드만 작성한 상태는 완료로 보지 않습니다.

| 순서·작업 | 주요 대상 파일 | 선행 관계 | 산출물·완료 기준 |
|---|---|---|---|
| ☐ **P3-01 실행 정책·격리 기반** | `R/src/security/policy.ts`, `engine/budget.ts`, `effects/journal.ts`, `workers/isolation.ts` | P2-11 | 병렬 예산 예약, 외부 작업 기록, Windows 격리 방식·지원 환경 검증 |
| ☐ **P3-02 자료·변환** | `R/src/handlers/resource.ts`, `transform.ts` | P3-01 | 고정 버전 자료 사용, 명시된 변환만 실행, 임의 코드 평가 차단 |
| ☐ **P3-03 분기·병합·오류·보호** | `handlers/condition.ts`, `merge.ts`, `error.ts`, `guardrail.ts` | P3-02 | 분기 건너뛰기·합류 처리, 교착 방지, 보호 중단을 성공으로 바꾸지 않음 |
| ☐ **P3-04 분류·평가** | `handlers/classify.ts`, `evaluate.ts`, `evaluation/rules.ts` | P3-02 | 분류 라벨 검증, 규칙·모델 평가 구분, 평가 결과와 분기 연결 명확화 |
| ☐ **P3-05 입력 요청·검토·승인** | `handlers/form.ts`, `review.ts`, `approvals/service.ts`, `U/src/pages/ApprovalPage.tsx` | P3-03~04 | 대기 상태 복구, 사용자 검토와 보안 승인 분리, AI의 자체 승인 차단 |
| ☐ **P3-06 파일 입출력** | `handlers/file_input.ts`, `file_output.ts`, `artifacts/store.ts` | P3-01 | 허용 경로·형식·크기 검사, 원본 보호, 실제 결과 파일 확인 |
| ☐ **P3-07 프로그램·Worker** | `handlers/program.ts`, `workers/host.ts`, `workers/protocol.ts` | P3-01, P3-05~06 | 코드 실행의 파일·네트워크·시간·프로세스 제한 검증 |
| ☐ **P3-08 문서 처리·Skill** | `handlers/document_extract.ts`, `skill.ts`, `documents/extract.ts`, `skills/loader.ts` | P3-02, P3-07 | 실제 문서·표·OCR 처리, 지침 Skill과 실행 Skill 구분 |
| ☐ **P3-09 도구·보상 작업** | `handlers/tool.ts`, `compensate.ts`, `tools/broker.ts`, `effects/reconcile.ts` | P3-01, P3-05, P3-07 | 실제 MCP 호출, 변경 승인, 중복 방지, 결과 불명 처리, 확인된 변경만 보상 |
| ☐ **P3-10 기억·지식·기본 검색** | `handlers/memory.ts`, `knowledge.ts`, `retrieval.ts`, `providers/embeddings.ts` | P3-08~09 | 실제 문서 색인, 키워드·벡터 검색, 근거가 있는 답변 |
| ☐ **P3-10A 색인 수명·접근 제어** | `knowledge/index-store.ts`, `chunk-store.ts`, `index-lifecycle.ts`, `retrieval/access-scope.ts` | P3-10 | 문서·청크·모델 버전 추적, 삭제·재색인·권한 변경 반영 |
| ☐ **P3-10B Hybrid·reranker** | `retrieval/hybrid.ts`, `rank-fusion.ts`, `rerank.ts`, `providers/rerankers/` | P3-10A, P3-01 | 후보 정규화·중복 제거·순위 결합·재정렬·실패 정책·사용량 기록 |
| ☐ **P3-10C GraphRAG 색인** | `knowledge/graph/indexer.ts`, `entities.ts`, `communities.ts`, `R/workers/graph-index/` | P3-07, P3-10A | 개체·관계·출처·별칭·커뮤니티 요약 생성, 삭제·권한 전파 |
| ☐ **P3-10D GraphRAG 검색** | `retrieval/graph-local.ts`, `graph-global.ts`, `graph-evidence.ts` | P3-10C | 실제 그래프·요약·원문을 사용한 검색, 근거 추적, 권한 누출 방지 |
| ☐ **P3-11 하위 워크플로** | `handlers/subworkflow.ts`, `engine/child-scope.ts` | P3-05, P3-09 | 입출력 계약·버전·깊이 제한, 부모와 자식의 실행 범위 분리 |
| ☐ **P3-12 반복·병렬** | `handlers/loop.ts`, `parallel.ts`, `engine/concurrency.ts` | P3-01, P3-11 | 반복 상한, 결과 순서, 부분 실패, 자식 취소, 병렬 예산 검증 |
| ☐ **P3-13 Agent** | `handlers/agent.ts`, `agents/tool-policy.ts`, `agents/session.ts` | P3-04, P3-09, P3-11~12 | 허용 도구·역할·기억·단계 제한을 적용한 실제 작업 |
| ☐ **P3-13A Agentic RAG** | `agents/retrieval-policy.ts`, `query-planner.ts`, `evidence-check.ts` | P3-05, P3-10A, P3-12~13 | 질문 분해·재검색·추가 질문·근거 부족 종료·예산 제한 |
| ☐ **P3-14 후보 탐색** | `handlers/candidate_search.ts`, `search/verifiers.ts` | P3-04, P3-07, P3-11~12 | 등록된 검증기로 후보 평가, 탐색 수·깊이·비용 제한 |
| ☐ **P3-15 팀·오케스트레이션** | `handlers/agent_team.ts`, `orchestrator.ts`, `orchestration/replan.ts` | P3-12~14 | 역할 전달·병렬 협업·계획 변경·권한 재확인·중단 처리 |
| ☐ **P3-16 트리거** | `handlers/trigger.ts`, `triggers/scheduler.ts`, `trigger-state.ts` | P2-05, P3-05, P3-09, P3-15 | 시간대·중복 실행·중단·재시작 처리. 가져오기만으로 활성화되지 않음 |
| ☐ **P3-17A RAG 품질 검증** | `T/retrieval/`, `T/security/retrieval-acl/`, `tooling/evaluation/run-retrieval.ts` | P3-10B~D, P3-13A | 검색 순위·인용·답변 유보·삭제·접근 제어를 실제 자료로 측정 |
| ☐ **P3-17 전체 블록 통합 검증** | `T/conformance/nodes/`, `T/e2e/advanced-workflows.spec.ts`, `D/support-matrix.md` | P3 전체 | 31개 블록과 공개 지원 모드의 편집·실행·복구·ZIP 경로 통과 |

`P3-11~15`는 RAG 확장 전체가 끝날 때까지 기다리지 않아도 됩니다. 표의 선행 작업이 준비되면 병렬로 진행합니다.

31개 블록의 누적 수는 다음과 같습니다.

| 구현 묶음 | 추가 블록 | 누적 |
|---|---|---:|
| 2단계 | `input`, `ai`, `output` | 3 |
| 자료·변환·제어·평가 | `resource`, `transform`, `condition`, `merge`, `error`, `guardrail`, `classify`, `evaluate` | 11 |
| 사용자 참여 | `form`, `review` | 13 |
| 파일·프로그램·문서·Skill | `file_input`, `file_output`, `program`, `document_extract`, `skill` | 18 |
| 외부 작업 | `tool`, `compensate` | 20 |
| 기억·검색 | `memory`, `knowledge`, `retrieval` | 23 |
| 실행 구성 | `subworkflow`, `loop`, `parallel` | 26 |
| 에이전트 구성 | `agent`, `candidate_search`, `agent_team`, `orchestrator` | 30 |
| 자동 시작 | `trigger` | **31** |

기술 전문가·페르소나·작업자·문서처리 Agent는 역할·자료·도구 설정으로 구성합니다. Sub Agent는 Agent와 하위 워크플로로, 하네스는 평가·검증·반복을 조합한 운영 프로젝트로 제공합니다.

---

**8. RAG 확장의 완료 기준은 별도로 엄격하게 관리합니다.**

| 기능 | 구현 내용 | 완료로 인정하는 증거 |
|---|---|---|
| 기본 RAG | 문서 정제·청크·색인·검색·인용 | 실제 원문과 인용 위치 일치, 없는 근거는 없다고 표시 |
| Agentic RAG | 질문 분해, 검색원 선택, 재검색, 추가 질문, 종료 판단 | 검색 횟수·예산 제한 준수, 불충분한 근거를 성공으로 처리하지 않음 |
| Hybrid RAG | 키워드 검색과 벡터 검색의 후보·순위 결합 | 공통 후보 ID, 중복 제거, 정의된 결합 알고리즘 검증 |
| reranker | 검색된 후보의 관련성 재평가 | 후보 밖 문서를 만들어 내지 않음, 버전·제한·실패 처리 기록 |
| GraphRAG 색인 | 개체·관계·근거·커뮤니티 요약 | 관계마다 근거 확인, 삭제·권한 변경 시 파생 결과 무효화 |
| GraphRAG 검색 | 특정 개체 중심 검색과 전체 주제 검색 | 그래프·요약·원문 연결 확인, 접근 불가 자료 누출 없음 |

Hybrid 검색은 단순 문자열 합치기가 아니라 검색 순위를 결합해야 합니다. 초기 결합 방식은 RRF를 기준으로 설계하고, reranker 적용 전후를 별도로 측정합니다. [Hybrid 검색 공식 설명](https://www.elastic.co/docs/solutions/search/hybrid-search)

GraphRAG는 개체·관계 추출뿐 아니라 커뮤니티 구성·요약과 검색까지 포함합니다. 초기 지원 범위는 **local 검색과 global 검색**으로 고정합니다. [GraphRAG 색인](https://microsoft.github.io/graphrag/index/overview/), [GraphRAG 검색](https://microsoft.github.io/graphrag/query/overview/)

추가 적용 사항은 다음과 같습니다.

- GraphRAG Worker의 모델·임베딩 호출도 Runner의 인증·예산 중계를 통과합니다.
- 접근 제어는 최종 검색 결과뿐 아니라 색인·관계·커뮤니티 요약 생성 범위에도 적용합니다.
- 비공개 자료에서 만든 임베딩·그래프·요약을 자동으로 공개 가능한 자료로 취급하지 않습니다.
- 필요한 검색 기능이 없는 Runner에서는 실행 전 차단합니다. 다른 검색 방식으로 몰래 대체하지 않습니다.
- 검색 품질 기준은 평가 실행 전에 고정하고, 정답 자료를 답변 생성 입력에 섞지 않습니다.

---

**9. 4단계 — 공유·공식 예제·검수·운영을 구현합니다.**

공유 기능은 3단계 전체 완료를 기다리지 않고 데이터·패키지 규격이 안정된 뒤 병행할 수 있습니다. 정식 출시는 모든 완료 조건을 충족한 뒤 진행합니다.

| 순서·작업 | 대상 파일 | 선행 관계 | 산출물·완료 기준 |
|---|---|---|---|
| ☐ **P4-01 공개·검수 데이터 모델** | `DB/migrations/002-publications.sql`, `W/src/server/publications.ts`, `roles.ts` | P2-06, E-02 | 소유·공유·공식 예제·검수·배포 상태 분리, 관리자 권한 검사 |
| ☐ **P4-02 배포 버전 고정** | `W/src/server/releases/create-release.ts`, `dependency-graph.ts`, `K/src/materialize-resources.ts` | P4-01, P2-08 | 참조 자료까지 버전·해시 고정, 공개 권리·포함 파일 확인 |
| ☐ **P4-03 안전한 미리보기·자동 검사** | `W/src/jobs/scan-publication.ts`, `features/preview/`, `infrastructure/jobs/` | P4-02, P3-07 | 업로드 코드를 실행하지 않는 검사, 위험 파일·비밀정보·누락 탐지 |
| ☐ **P4-04 검수·서명·게시** | `W/src/features/admin/reviews/`, `server/releases/publish.ts`, `sign-release.ts` | P4-03 | 검수한 정확한 해시만 게시, 서명 키 분리, 감사 기록 |
| ☐ **P4-05 둘러보기·상세·복사** | `W/src/app/explore/projects/page.tsx`, `explore/resources/page.tsx`, `features/library/` | P4-01~02 | 검색·필터·상세·독립 복사, 원작·라이선스 유지, 비밀정보 제외 |
| ☐ **P4-06 공식 예제·관리 화면** | `W/src/app/examples/page.tsx`, `examples/resources/page.tsx`, `features/admin/examples/` | P4-04~05, E-02 | 두 공식 메뉴, 관리자 제공 표시, 예제 버전 관리·복사·다운로드 |
| ☐ **P4-07 신고·철회·영향 분석** | `W/src/server/reports.ts`, `revocations.ts`, `dependency-impact.ts` | P4-04~05 | 신고 처리, 신규 배포 중단, 의존 예제 영향 확인, 이력 보존 |
| ☐ **P4-08 운영 설치·업데이트** | `tooling/release/`, `R/src/update/`, `infrastructure/signing/` | P3-17, P2-08, P4-04 | 서명된 설치·업데이트, 취약 버전 차단, 구성요소·라이선스 목록 |
| ☐ **P4-09 계정·가이드·운영 복구** | `W/src/app/account/page.tsx`, `app/guide/`, `server/observability/`, `infrastructure/backup/` | P4-01, P4-07~08 | 계정·삭제·보존 정책, 사용자 안내, 경보, DB와 파일의 실제 복원 |
| ☐ **P4-10 최종 출시 판정** | `tooling/release/check-gates.ts`, `T/release/`, `D/release-report.md` | P3-17, P4-01~09, E-12 | 전체 출시 조건 통과, 미검증 항목을 완료로 집계하지 않음 |

개인 프로젝트 작성과 개인 ZIP 다운로드에 공개 게시용 검수 절차를 일괄 적용하지 않습니다. 공개 배포 시에는 포함된 자료와 코드까지 검수합니다.

---

**10. 예제 프로젝트 120개와 자료 및 도구 120개는 별도 제작 작업으로 관리합니다.**

기존에 정한 **개별 이름·목적·블록 연결·입력·결과·검증 기준은 유지**합니다. 아래 묶음은 제작 순서와 의존 기능을 관리하기 위한 작업 단위입니다.

| 프로젝트 범위 | 분야 | 개수 | 주요 의존 기능 |
|---|---|---:|---|
| EP-001~010 | 일반 업무 Agent | 10 | AI·Agent·자료·평가 |
| EP-011~020 | 기술 전문가 Agent | 10 | 읽기 도구·코드/설정 분석·근거 |
| EP-021~030 | 페르소나 Agent | 10 | 역할 지침·검토·반복 |
| EP-031~040 | 작업자 Agent | 10 | 변환·파일·프로그램·외부 작업·트리거 |
| EP-041~050 | 문서처리 Agent | 10 | 문서 추출·OCR·표·출처 |
| EP-051~060 | 운영 하네스 | 10 | 실행 기록·계약·예산·무결성·복구 |
| EP-061~070 | 멀티 에이전트 | 10 | 역할 분담·팀 실행·검토 |
| EP-071~080 | 병렬 에이전트 | 10 | 병렬 실행·통합·충돌 처리 |
| EP-081~090 | Sub Agent | 10 | 하위 워크플로·인계 계약 |
| EP-091~100 | 오케스트레이션 | 10 | 재계획·실패 대응·승인·트리거 |
| EP-101~105 | 기본 RAG | 5 | 기본 검색·색인·인용 |
| EP-106~110 | Agentic RAG | 5 | 질문 분해·재검색·종료 |
| EP-111~115 | Hybrid RAG·reranker | 5 | 검색 결합·재정렬 |
| EP-116~120 | GraphRAG | 5 | 그래프 색인·local/global 검색 |
| **합계** | | **120** | |

| 자료 및 도구 범위 | 종류 | 개수 | 주요 의존 기능 |
|---|---|---:|---|
| ER-001~010 | MCP 연결 정의 | 10 | 실제 서비스 연결·권한·도구 검사 |
| ER-011~040 | 작업 지침 | 30 | 지침 첨부·역할·버전 관리 |
| ER-041~060 | 문서·평가 자료 | 20 | 문서·출처·평가·일부 그래프 기능 |
| ER-061~080 | 에이전트·협업 Skill | 20 | Skill·Agent·팀·인계 |
| ER-081~090 | 파일·데이터 Skill | 10 | 파일·프로그램·문서 처리 |
| ER-091~100 | 운영 하네스 Skill | 10 | 실행 기록·정책·무결성 검사 |
| ER-101~120 | RAG Skill | 20 | 기본·Agentic·Hybrid·GraphRAG |
| **합계** | | **120** | |

MCP 10개는 GitHub·Notion·Atlassian·Linear·Figma·Supabase·Sentry·Cloudflare 문서·Playwright·Microsoft Learn 연결 정의입니다. **서비스가 존재한다는 확인만으로 완성 처리하지 않고, Studio에서 실제 연결·사용을 검증합니다.**

예제 제작 작업은 다음과 같습니다.

| 순서·작업 | 대상 파일 | 선행 관계 | 산출물·완료 기준 |
|---|---|---|---|
| ☐ **E-01 240개 목록 고정** | `CAT/catalog.json`, `D/official-examples.md` | P1-06 | 고유 ID·이름·목적·종류·필요 기능·참조 자료 등록 |
| ☐ **E-02 예제·검증 기록 규격** | `S/schemas/official-example.schema.json`, `verification-record.schema.json` | E-01, P2-02 | 입력·결과·전제 조건·권한·버전·검증 기준 검사 |
| ☐ **E-03 제작·검증 도구** | `tooling/catalog/validate.ts`, `T/catalog/` | E-02, P2-11 | 중복 ID·끊어진 참조·누락 파일·잘못된 지원 표시 차단 |
| ☐ **E-04 기초 자료 제작** | `CAT/resources/ER-xxx/`의 지침·문서·기초 Skill | E-03, 해당 블록 | 실제 본문·코드·템플릿·사용법·권리 정보 완성 |
| ☐ **E-05 연결·고급 자료 제작** | 같은 경로의 MCP·실행 Skill·RAG 자료 | E-03, 해당 P3 기능 | 실제 연결·실행·실패 처리 확인, 각 자료의 사용 증거 확보 |
| ☐ **E-06 기본 프로젝트 제작** | `CAT/projects/EP-001~060/` | 해당 자료와 `requiredCapabilities` | 실제 입력·워크플로·결과·안내·검증 기준 완성 |
| ☐ **E-07 협업 프로젝트 제작** | `CAT/projects/EP-061~100/` | 해당 자료, P3-11~16 중 필요한 기능 | 역할 전달·병렬·인계·재계획·부분 실패 검증 |
| ☐ **E-08 RAG 프로젝트 제작** | `CAT/projects/EP-101~120/` | 해당 자료, P3-10A~D·P3-13A | 실제 검색·인용·답변 유보·접근 범위·색인 변경 검증 |
| ☐ **E-09 실제 사용·호스트 검증** | `T/catalog/acceptance/`, `tooling/catalog/verify-hosts.ts` | 각 예제 제작, P3-17, P4-08 | 프로젝트 실제 실행, 자료 실제 사용, 세 호스트 사용 경로 기록 |
| ☐ **E-10 예제 검수·게시** | `CAT/catalog.json`, 관리자 게시 기능, 검증 기록 저장소 | E-09, P4-04, P4-06 | 자료 의존 관계·권리·비밀정보 확인 후 정확한 버전 게시 |
| ☐ **E-11 공식 메뉴 완성 검증** | `T/e2e/official-examples.spec.ts`, 공식 예제 화면 | E-10, P4-06 | 두 메뉴에 각각 120개, 검색·상세·복사·다운로드 동작 |
| ☐ **E-12 재검증·최종 집계** | `tooling/catalog/reverify.ts`, `T/catalog/release-gate.test.ts` | E-11, P4-07~09 | 유효한 프로젝트 120개·자료 120개, 변경·철회 영향 반영 |

E-04~08은 전체 묶음이 끝날 때까지 다음 묶음을 기다리는 구조가 아닙니다. **각 프로젝트가 필요로 하는 자료와 기능이 준비되는 순서로 제작**합니다.

---

**11. 240개 항목 각각에는 동일한 완료 체크리스트를 적용합니다.**

프로젝트별 예정 구조는 다음과 같습니다.

```text
catalog/official/projects/EP-xxx/
  example.json
  workflow.json
  editor.json
  README.ko.md
  sample-inputs/
  licenses/
  verification.spec.json
```

자료별 예정 구조는 다음과 같습니다.

```text
catalog/official/resources/ER-xxx/
  resource.json
  README.ko.md
  content/
  licenses/
  verification.spec.json
```

Skill의 `content/`에는 용도에 맞게 다음을 포함합니다.

```text
content/
  SKILL.md
  scripts/
  references/
  assets/
```

Skill은 `SKILL.md`와 함께 실행 코드·참조 문서·템플릿을 포함할 수 있습니다. 표준 파일명은 대문자 **`SKILL.md`**를 사용합니다. [Agent Skills 규격](https://agentskills.io/specification)

각 항목마다 아래 작업을 수행합니다.

- [ ] 이름·목적·사용 대상이 구체적이다.
- [ ] 필요한 블록·기능·자료·연결이 명시되어 있다.
- [ ] 참조 자료와 코드의 버전·해시가 고정되어 있다.
- [ ] 실제 입력과 예상 결과의 형태가 준비되어 있다.
- [ ] 계정·설치·권한·비용 조건이 안내되어 있다.
- [ ] 실제 파일·본문·코드·템플릿이 들어 있다.
- [ ] 성공·실패·근거 부족·권한 거부의 처리 기준이 있다.
- [ ] 실제 실행 또는 사용 증거가 있다.
- [ ] 배포 권리·라이선스·비밀정보 검사를 통과했다.
- [ ] 해당 버전의 검수·게시가 완료되었다.

`verification.spec.json`은 내부 검증용이므로 운영 ZIP에서 제외합니다. 반면 사용자가 직접 평가하는 운영 하네스와 평가 데이터는 정상 자료로 제공할 수 있습니다.

**작성자가 `verified: true`를 적는 방식으로 검증 상태를 만들지 않습니다.** 검증 시스템과 검수자가 대상 해시에 연결된 기록을 남깁니다.

기록에는 실행 ID, 입력·결과 해시, Runner·호스트·모델·색인 버전, 검증 날짜와 검수자를 포함합니다. 비밀정보는 기록하지 않습니다.

---

**12. ZIP 규격은 공통 실행 내용과 호스트별 파일을 분리합니다.**

| 구성 | 포함 내용 |
|---|---|
| 공통 실행 설계 | `workflow.json` |
| 편집기 복원 정보 | `editor.json` |
| 배포 목록·권한·호환성 | `manifest.json` |
| 고정 실행 의존성 | `runtime.lock.json` |
| 검증된 자료 | `resources/` |
| 사용 안내 | `README.ko.md` |
| 배포 서명 | `manifest.sig` |
| 호스트별 추가 파일 | 지침·Skill·Studio MCP 설정 |

호스트별 어댑터는 해당 도구의 파일 배치를 따릅니다.

| 대상 | 주요 생성 대상 | 역할 |
|---|---|---|
| Codex | `AGENTS.md`, `.agents/skills/`, `.codex/config.toml` | 사용 지침·Skill·프로젝트 MCP 연결 |
| Claude Code | `CLAUDE.md`, `.claude/skills/`, `.mcp.json` | 사용 지침·Skill·프로젝트 MCP 연결 |
| OpenCode | `AGENTS.md`, `.opencode/skills/`, `opencode.json` | 사용 지침·Skill·MCP 설정 |

실제 설정 키와 지원 버전은 어댑터 검증 기준에 고정합니다. Codex의 프로젝트 MCP 설정에는 프로젝트 신뢰 조건도 반영합니다. [Codex Skill](https://learn.chatgpt.com/docs/build-skills), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code Skill](https://code.claude.com/docs/en/skills), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [OpenCode Skill](https://opencode.ai/docs/skills/), [OpenCode 설정](https://opencode.ai/docs/config/)

ZIP에는 API 키·OAuth 토큰·승인 기록·개인 실행 이력·사용자의 로컬 절대 경로를 넣지 않습니다. 압축 해제나 가져오기만으로 프로그램·MCP·예약 실행을 시작하지 않습니다.

또한 두 배포 용도를 구분합니다.

| 다운로드 용도 | 보장 범위 |
|---|---|
| **워크플로 실행 ZIP** | Studio Runner가 31개 블록과 실행 정책을 처리 |
| **자료 활용 ZIP** | 지침·Skill·문서·연결 정의를 해당 AI 도구에서 활용 |

자료 활용 ZIP을 받은 호스트가 자체 도구로 실행하는 코드는 그 호스트의 보안 범위에 속합니다. Runner가 직접 통제한다고 표시하지 않습니다.

---

**13. 실제 개발은 다음 순서로 진행합니다.**

| 진행 순서 | 묶음 | 다음으로 넘어가는 조건 |
|---|---|---|
| 1 | P1 전체 + E-01 | 제품·규격·240개 목록 고정 |
| 2 | P2 전체 + E-02~03 | 기본 워크플로가 세 호스트에서 실제 실행 |
| 3 | P3-01~09 + 기초 자료 제작 | 승인·파일·코드·MCP 실행 경계 검증 |
| 4 | 기본 RAG와 하위 실행·Agent를 병렬 구현 | 검색·Agent·반복·병렬 각각 사용 가능 |
| 5 | Agentic·Hybrid·GraphRAG와 팀·오케스트레이션 구현 | 고급 프로젝트에 필요한 기능 완성 |
| 6 | P4 공유·검수·운영 기능 병행 | 실제 예제 배포·철회·복구 가능 |
| 7 | 예제 묶음별 제작·검증·게시 | 각 항목의 자료 의존성과 실제 사용 검증 통과 |
| 8 | E-12 + P4-10 | 31개 블록·240개 예제·배포·운영 조건 전체 통과 |

세 호스트 모두 지원한다고 표시하는 프로젝트는 **120 × 3 = 360개 사용 조합**을 검증 대상으로 관리합니다. 공통 엔진의 단위 검사를 세 번 복제할 필요는 없지만, 각 ZIP을 통한 **호스트 진입 → 실제 실행 시작 → 결과 회수** 경로는 확인합니다.

외부 서비스가 필요한 예제는 실제 연결 조건에서 검증합니다. 연결이 준비되지 않았거나 실행에 실패한 항목을 가짜 결과로 통과시키지 않습니다.

---

**14. 정식 출시 전 필수 체크리스트입니다.**

- [ ] 31개 블록과 공개한 모든 실행 모드가 편집기·Runner·ZIP에서 일치한다.
- [ ] Agentic RAG·Hybrid·reranker·GraphRAG의 실제 기능과 품질 검증을 통과했다.
- [ ] 공식 프로젝트 **120개 전부**가 실제 실행 검증·검수·게시를 완료했다.
- [ ] 공식 자료 및 도구 **120개 전부**가 실제 사용 검증·검수·게시를 완료했다.
- [ ] 이름 변경·번역·ZIP 변형·Skill 내부 파일을 별도 예제로 중복 집계하지 않았다.
- [ ] 세 호스트의 프로젝트 사용 조합과 버전별 지원 상태가 기록되어 있다.
- [ ] 편집기와 ZIP에 개발 모드·모의 결과·내부 검증 파일이 없다.
- [ ] 사용자가 Node·Python 개발 환경을 직접 구성하지 않아도 Runner를 사용할 수 있다.
- [ ] 코드·로컬 MCP의 격리, 파일 경계, 네트워크 제한, 로컬 API 인증을 검증했다.
- [ ] 병렬 예산·승인·중복 외부 작업·결과 불명·취소·재개 검증을 통과했다.
- [ ] ZIP 경로 조작·누락 파일·해시 변조·압축 크기 제한 검사를 통과했다.
- [ ] 비공개 자료와 RAG 파생 데이터의 접근 제어·삭제 반영을 검증했다.
- [ ] 설치·업데이트·서명·취약 버전 대응 절차를 검증했다.
- [ ] 신고·배포 중단·의존 예제 재검증·감사 기록이 동작한다.
- [ ] DB와 Storage 파일을 함께 복원하는 실제 복구 시험을 통과했다.
- [ ] 비전문가 사용성 검증에서 예제 복사·편집·다운로드·실행·결과 확인이 가능했다.
- [ ] 사용 가이드와 각 예제의 준비 조건·오류 해결 안내가 실제 제품 동작과 일치한다.

**모든 작업은 현재 계획 상태입니다. 위 완료 기준을 충족한 항목만 구현 완료·사용 가능·출시 가능으로 표시합니다.**

