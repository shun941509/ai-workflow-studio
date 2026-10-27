# 진행 상태와 검증 기록

기준일: 2026-10-28 KST. 사용자 승인에 따라 P2 상세 계획과 후속 계획을 기록한 뒤 실제 구축·테스트를 진행한다. 코드 구현과 실제 외부 서비스 인증을 구분하며 정식 출시 완료를 주장하지 않는다.

## 계획

P1 원문 상세 규격, 240개 공식 예제 원문 목록, 통합 작업 목록을 보존했다. P2-01~11의 대상 파일·순서·의존·검증·완료 조건은 P2-detailed-spec.md에 있고, P3/P4/E/출시는 P3-P4-catalog-plan.md에 있다. 추가 결정은 개별 규격 문서에 기록한다. [P2 실제 파일 대조](P2-verification.md), [제품 전체 출시 검사](release-gates.md).

## 구현 현황

| 영역 | 확인한 범위 | 남은 경계 |
|---|---|---|
| 공통 계약 | workspace·Node24·Schema→타입·31개 폐쇄 config·strict JSON/Ajv·그래프/Binding/불변 계획·FileRef | 전 공개 모드 실행·화면 일치 |
| 웹 | 8메뉴·17블록 폼·undo/redo·저장 주소 복구·오류 이동·ZIP·실제 지침/문서 고정 버전 첨부. 파일·기억·단일 작업 Agent 추가 | 17블록 production 재검사·31블록 화면·실계정 통합 |
| 계정 저장 | Supabase 서버 CRUD/RLS·불변 버전 소스, 실제 PostgreSQL SQL/RLS 시험 | 실제 Supabase Auth HTTP/Storage |
| Runner | SQLite v7 기준23타입. 기본13+subworkflow/loop/parallel/file_input/file_output/memory/skill/agent/agent_team/orchestrator. 영속 DAG·하위 scope·공유 예산·대기·복구·DPAPI·Responses·로컬 UI/API·MCP | 타입별 지원 모드 제한. agent 단일 호출, team 고정 흐름, orchestrator 제안만. RAG 연결 진행·실제 모델 미검증 |
| 관리 파일 | 실행별 불변 저장·원본해시·중복/충돌·quota·링크 경계, text/markdown/json/csv/copy 처리기. 서비스/API/사용자 선택 업로드·다운로드 통합 | 임의 OS 경로·실행 worker·PDF/DOCX 등은 미지원 |
| ZIP | 3호스트 workflow/materials, 폐쇄 목록·원본해시·외부 신뢰 Ed25519·자료 전이의존·native Skill 사본 | 완전한 runtime lock·공식 설치·3호스트 실사용 |
| 공유 운영 | 제출/스캔/검수/고정해시 게시/철회·역할·감사·신고 SQL. 안전한 공개 열·제한 검색·cursor·4종 목록/상세·신고 화면 | 정적 스캐너/API 구현 중. 실계정·검수화면·서명/배포·복사·보존 삭제 |
| 예제 | 240개 원문 계약·검증기. 자료90개(지침30·문서20·Agent Skill20·파일 Skill10·하네스10), 프로젝트6개 원본 제작·3호스트 ZIP 검사 | 프로젝트114·자료30 제작 및 전 목록 실제 호스트 검증·게시. 사용/게시 확인0 |
| 격리 | native LPAC 파일·자식·CPU·메모리·시간·링크 경계 실증 | zero-cap Node 시작 실패. registryRead 진단 프로필은 운영 제외 |
| RAG | 불변 세대·현재 ACL/tombstone·Hybrid/RRF/rerank·Agentic 예산 계약. bounded BM25/exact vector 계산·UTF8 byte 인용·SQLite 세대/원본 artifact·원자적 활성화·검색 전후 권한 검사 | 실제 임베딩·Runner 연결·GraphRAG·물리 삭제·품질 검증 |

## 새 실행 증거

- 최신 전체 통합 시험(2026-10-28 06:51 KST, 후속 memory/Skill·검색·확장 화면 작업 전): **37파일/436시험 통과**, Node24.22.1. Windows native 격리 시험 포함하되 Node Worker 준비 완료로 집계하지 않는다.
- 이후 별도 시험: RAG 계약·검색·SQLite 58개, Runner focused 213개, catalog184개 통과. 후보 파일의 실제 바인딩 오류를 수정했으며 모델 품질/실사용 증거는 생성하지 않았다. 새 RAG·스캐너 연결 후 통합 검사로 갱신한다.
- 13블록 웹 production build와 실제 Chrome14개 시나리오 통과. 이후 17블록에서 파일·기억·Agent 3개 시나리오 및 공유 목록8개 개발 서버 검사 통과. 17블록 production 빌드·회귀 진행 중이다.
- 전체8패키지/tooling 타입 검사 통과. 진행 중인 후속 변경 후 전체 검사를 다시 수행한다.
- Runner 후보 artifacts/runner/win32-x64/2026-10-27T21-50-21-203Z: 별도 Node24 프로세스에서 DPAPI·UI·인증·세션/CSRF·ZIP 가져오기·모델 미연결 차단·가져오기 자동 실행 없음 등9개 확인. 이후 소스 변경을 포함하지 않는 빌드 시점 증거다.
- 파일 실행은 실제 Chromium에서 파일 선택→제출→성공→원본 bytes 다운로드를 확인했다. 루프백 세션/Origin/CSRF·run 소유권으로 제한하고 MCP/bearer가 업로드·사용자 응답을 대신하지 못한다.
- PGlite PostgreSQL SQL/RLS 시험에서 Storage owner 조회의 열 해석 오류를 발견해 수정했다. Auth/Storage helper fixture는 SQL 경계 시험용이며 실제 Supabase 인증 서버 검증이 아니다.
- 운영 의존성 audit 실행 시 보고된 취약점0. 전체 안전성 보장과 구분한다.
- check:release는 valid=true, releaseReady=false, 종료1. 실제13개 제품 gate와120+120 게시 증거가 없어 정상 차단된다.

## 남은 출시 조건

실제 모델·Supabase·외부 MCP10종·세 호스트 로그인/버전·공식 서명/배포·깨끗한 Windows 환경은 준비와 실제 증거가 필요하다. 비밀키를 채팅/ZIP/로그에 넣지 않는다. 독립 구현·시험을 계속하며 미준비 실제 연동을 가짜 성공으로 바꾸지 않는다.

Node Worker 격리, P3 나머지 처리기와 공개 모드, RAG 실제 연결/전체 전략, 240개 검증/게시, 공유 운영 완성, 설치/서명/업데이트/복원/호스트 종단이 남아 있다. 자료와 프로젝트의 implemented 상태는 콘텐츠 제작·정적 검사 완료를 뜻하며 usable/published와 구분한다.

## 환경

초기 저장소는 .git만 있었고 사용자 코드 덮어쓰기·커밋·푸시·외부 배포는 하지 않았다. 시스템 Node26은 변경하지 않고 공식 SHA256 검증 Node24.22.1을 .tools에 두었다. node tooling/run-pnpm.mjs는 자식 프로세스에만 해당 Node와 pnpm12.15.0 네이티브 실행기를 적용한다. Codex/Claude 명령은 발견했지만 로그인·실제 동작은 미검증이며 OpenCode/Docker/psql은 PATH에 없다.
