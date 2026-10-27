# 공식 예제 120+120 제작 명세

> 이전 계획 답변의 원문을 보존한 설계 기준입니다. 아래의 ‘구현하지 않음’은 당시 상태이며, 현재 구현·검증 상태는 `docs/implementation/status.md`를 따릅니다. 출시 수량은 이후 확정한 각각 120개 전체 검증·게시 기준을 적용합니다.

네. **Skill은 `SKILL.md` 지침뿐 아니라 코드·참조 문서·템플릿·스키마·데이터를 함께 담을 수 있는 묶음**으로 설계할 수 있습니다.

요청하신 분야를 반영해 **예제 프로젝트 120개와 예제 도구·자료 120개**의 구체적인 제작 목록을 아래처럼 정리하겠습니다. 모두 **제작·검증할 후보 명세**이며, 지금 생성하거나 실행을 완료했다는 뜻은 아닙니다. 실제 사용 검증을 통과한 공식 공개 항목을 각각 100개 이상 제공한다는 출시 기준은 유지합니다.

---

**Skill의 표준 진입점은 대문자 `SKILL.md`로 통일합니다.**

```text
skill-name/
├─ SKILL.md
├─ scripts/                 실행 코드
├─ references/              참고 문서·작업 규칙
├─ assets/
│  └─ templates/            보고서·문서·출력 템플릿
└─ schemas/                 Studio에서 활용할 입출력 스키마
```

Agent Skills 규격은 `SKILL.md`를 필수로 두고 코드·문서·템플릿 등의 추가 파일을 허용합니다. `schemas/` 같은 추가 폴더는 Studio의 구성 규칙으로 사용할 수 있습니다. [Agent Skills 공식 규격](https://agentskills.io/specification)

적용 기준은 다음과 같습니다.

- 소문자 `skill.md`로 들어온 파일은 검사 후 표준 이름으로 정규화합니다. 대소문자만 다른 파일이 함께 있으면 충돌로 처리합니다.
- 모든 Skill에 코드가 필요한 것은 아닙니다.
- 코드를 포함한 Skill은 실행 진입점·의존성·입출력·필요 권한을 선언합니다.
- 코드가 들어 있다고 자동 실행하거나 권한을 부여하지 않습니다.
- 세 호스트에 공통 내용을 제공하되 호스트 전용 옵션은 어댑터가 처리합니다. [Claude Code Skills](https://code.claude.com/docs/en/skills), [OpenCode Skills](https://opencode.ai/docs/skills/)

자료 종류는 기존 네 가지를 유지하면서 **MCP 10개, 작업 지침 30개, 문서 20개, Skill 60개**로 배분하겠습니다. 코드와 템플릿을 활용하는 항목을 늘리기 위한 조정입니다.

---

**요청하신 에이전트 유형은 기존 블록의 조합으로 표현합니다.**

| 유형 | 구성 방식 |
|---|---|
| 일반·기술 전문가·페르소나 Agent | `agent` + 역할 지침 + 허용 도구 + 결과 계약 |
| 작업자 Agent | 좁은 작업 범위의 `agent`·`program`·`subworkflow` |
| 문서처리 Agent | `document_extract` + `agent` + 검증·파일 출력 |
| 멀티 에이전트 | `agent_team` |
| 병렬 에이전트 | `parallel` 내부의 여러 `agent` |
| Sub Agent | `subworkflow` 내부의 제한된 `agent` |
| 하네스 | Runner의 권한·예산·기록·검증·복구 구성 |
| 오케스트레이션 | `orchestrator` + 허용된 작업 정의 |
| RAG | `knowledge` + `retrieval` + `ai` |
| Agentic RAG | `agent`가 등록된 검색 도구를 제한적으로 반복 사용 |
| Hybrid RAG·reranker | 키워드·벡터 검색 결합 + 후보 재정렬 |
| GraphRAG | 개체·관계·출처·그래프 색인·그래프 기반 검색 |

기술 전문가와 페르소나는 역할 설정입니다. 실제 자격이나 실제 사용자 조사 결과를 가진 것처럼 표시하지 않습니다.

Hybrid 검색은 키워드와 벡터 검색의 순위를 결합하고, reranker는 질문과 후보 문서를 받아 관련성 순서를 다시 정합니다. 단순 문자열 합치기와 구분합니다. [Elastic Hybrid 검색](https://www.elastic.co/docs/solutions/search/hybrid-search), [Cohere Rerank 설명](https://docs.cohere.com/docs/rerank-overview)

GraphRAG는 관계 그림만 만드는 예제가 아니라, 출처 있는 개체·관계와 색인을 구축하고 조회하는 구성으로 계획합니다. 초기 구현은 로컬 관계 검색과 전역 주제 검색의 범위를 명시하겠습니다. [GraphRAG 색인](https://microsoft.github.io/graphrag/index/overview/), [GraphRAG 조회](https://microsoft.github.io/graphrag/query/overview/)

---

**표의 표기는 다음 기준을 사용합니다.**

- 공통 `input`·`output`과 일반 오류 처리는 생략하고 핵심 블록을 표시합니다.
- AI를 사용하는 항목은 공통 모델 연결이 필요합니다.
- 파일은 사용자가 허용한 입력·결과 영역을 뜻합니다.
- **†**는 검색·색인·어댑터 확장이 필요한 항목입니다. 구현·검증 전에는 사용 가능으로 공개하지 않습니다.
- 검증 기준은 앞으로 통과해야 할 조건이며, 이미 통과했다는 표시가 아닙니다.

---

**EP-001~020은 일반 에이전트와 기술 전문가 프로젝트입니다.**

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-001 업무 요청함 정리 | 요청을 업무로 구조화 | `agent·classify·review` | 요청 묶음 → 업무표 | 원문 전체 매핑, 미정 담당·기한 유지 |
| EP-002 회의 후속 작업 정리 | 결정과 할 일 분리 | `document_extract·agent·review` / 파일 | 회의록 → 결정·담당·기한 | 결정·제안 구분, 원문 근거 연결 |
| EP-003 주간 현황 보고 | 실제 진행 상태 취합 | `agent·transform·file_output` | 현황·목표 → 주간 보고서 | 완료 수 일치, 없는 성과 추가 금지 |
| EP-004 FAQ 보완 후보 찾기 | 기존 FAQ의 빈틈 확인 | `retrieval·agent·review` / 지식 | FAQ·문의 → 보완 후보 | 기존 답변과 중복·근거 여부 확인 |
| EP-005 공개 자료 조사 | 여러 출처의 사실 정리 | `retrieval·agent·evaluate` / 웹 | 질문·범위 → 출처별 요약 | URL·본문 일치, 검색 실패 명시 |
| EP-006 대안 비교표 작성 | 사용자 기준으로 비교 | `form·agent·transform` | 대안·기준 → 비교표 | 모든 기준 반영, 미확인 값 구분 |
| EP-007 목표 실행 체크리스트 | 큰 일을 단계로 분해 | `agent·evaluate·review` | 목표·제약 → 실행 목록 | 단계별 완료 조건과 제약 준수 |
| EP-008 자료 변경 영향 요약 | 버전 변화 확인 | `memory·program·agent` / 비교기 | 이전·현재 자료 → 변경 보고 | 실제 차이·버전 추적 가능 |
| EP-009 읽을 자료 순서 정리 | 목적별 읽기 계획 | `document_extract·agent` / 파일 | 자료·질문 → 읽기 순서 | 추천 구간 존재·관련성 근거 |
| EP-010 고객 문의 답변 초안 | 정책에 맞는 답변 작성 | `classify·retrieval·agent·review` | 문의·정책 → 답변 초안 | 정책 밖 약속·처리 완료 주장 없음 |
| EP-011 API 변경 영향 분석 | 명세 호환성 검토 | `program·agent·evaluate` / 명세 비교기 | 구·신 명세 → 변경·영향 | 실제 경로·필드 차이와 일치 |
| EP-012 읽기 전용 SQL 분석 | 조회 결과 해석 | `program·agent` / 제한 DB | 질의·스키마 → 결과 해설 | DB 권한으로 쓰기 차단, 수치 일치 |
| EP-013 저장소 온보딩 지도 | 코드 읽기 경로 안내 | `tool·agent·file_output` / GitHub | 저장소·기능 → 구조 지도 | 지정 리비전에 파일·심벌 존재 |
| EP-014 장애 로그 원인 후보 | 사실과 원인 가설 분리 | `file_input·program·agent` | 로그 → 사건 순서·가설 | 시각·코드 일치, 가설을 사실로 단정하지 않음 |
| EP-015 요구사항 검증 설계 | 확인 항목 도출 | `agent·evaluate` | 요구사항 → 검증 추적표 | 모든 요구사항에 검사 기준 연결 |
| EP-016 의존성 변경 검토 | 업데이트 영향 확인 | `program·retrieval·agent` / 공식 공지 | 잠금 파일 → 변경·조치 후보 | 패키지·버전·공지 일치 |
| EP-017 HTML 접근성 점검 | 선언된 정적 규칙 검사 | `program·agent` / HTML 검사기 | HTML → 문제·수정 안내 | 위반 위치 재현, 전체 인증으로 표시하지 않음 |
| EP-018 성능 측정 해설 | 측정 변화 설명 | `program·agent` / 측정 파일 | 기준·현재 값 → 변화 보고 | 계산 재현, 원인 추정 구분 |
| EP-019 설정 변경 검토 | 정책 위반 차이 확인 | `program·guardrail·review` | 구·신 설정 → 변경·위반 목록 | 실제 키·값 대조, 비밀 값 비노출 |
| EP-020 기술 이전 계획 | 의존 순서와 복구 설계 | `agent·evaluate·review` | 현재·목표 구조 → 이전 계획 | 선행 관계·검증·복구 조건 존재 |

---

**EP-021~040은 페르소나 기반 업무와 작업자 프로젝트입니다.**

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-021 면접 연습 상대 | 답변 연습 지원 | `agent·form·loop·evaluate` | 직무·답변 → 질문·피드백 | 질문 수 준수, 채용 판정으로 표시하지 않음 |
| EP-022 발표 청중 리허설 | 설명 부족 부분 발견 | `document_extract·agent·form` | 발표 자료 → 질문·보완 구간 | 질문과 피드백의 자료 근거 확인 |
| EP-023 협업 조건 정리 | 합의·충돌 구분 | `form·agent·review` | 양측 조건 → 합의 가능·미합의 표 | 필수 조건 보존, 미합의를 합의로 변경하지 않음 |
| EP-024 초보 고객 온보딩 점검 | 안내의 빈틈 확인 | `agent·evaluate` | 시작 안내 → 혼동·누락 목록 | 원문 위치 연결, 실제 사용자 조사와 구분 |
| EP-025 교육 퀴즈 설계 | 목표별 문제 생성 | `agent·evaluate·file_output` | 자료·목표 → 문제·해설 | 정답 근거와 목표별 문항 연결 |
| EP-026 회의 진행자 의제 설계 | 시간 내 결정 구성 | `form·agent·program` | 목표·시간 → 의제·시간표 | 총시간 제한, 의제별 결과 정의 |
| EP-027 편집자 문체 개선 | 스타일 적용 | `resource·agent·review` | 초안·지침 → 수정본 | 수치·고유명사·핵심 사실 보존 |
| EP-028 반대 검토자 가정 점검 | 취약한 전제 찾기 | `agent·evaluate·review` | 계획·근거 → 반례·확인 실험 | 지적과 가정 연결, 추정 표시 |
| EP-029 다국어 독자 안내 개선 | 의미·용어 전달 | `resource·agent·evaluate` | 원문·용어집 → 번역·확인표 | 지정 용어·숫자·링크 보존 |
| EP-030 행사 운영 진행표 | 준비와 당일 순서 정리 | `form·agent·program` | 구성·인력·시간 → 진행표 | 시간·인력 충돌 확인 |
| EP-031 CSV 정리 작업자 | 형식 표준화 | `program·review·file_output` | CSV·규칙 → 정제본·변경 내역 | 행 수·변경 셀 추적, 원본 보존 |
| EP-032 중복 레코드 병합 | 중복과 값 충돌 처리 | `program·condition·review` | 데이터·키 → 병합본·충돌 목록 | 원본 행 추적, 충돌값 임의 선택 금지 |
| EP-033 두 목록 대조 | 누락·추가·변경 확인 | `program·transform·file_output` | 두 목록 → 차이 보고서 | 비교 키별 실제 차이 일치 |
| EP-034 파일 이름 표준화 | 규칙에 맞춘 복사본 생성 | `program·review·file_output` | 파일·규칙 → 복사본·대응표 | 충돌·경로 이탈 차단, 원본 보존 |
| EP-035 표 파일 일괄 변환 | 교환 형식 변경 | `loop·program·file_output` | CSV·JSON → 변환 묶음 | 지원 자료형·행·열의 왕복 보존 |
| EP-036 GitHub 이슈 등록 | 승인된 요구를 기록 | `agent·review·tool` / GitHub | 요구사항 → 등록 이슈 ID | 승인 대상·본문 일치, 중복 생성 방지 |
| EP-037 외부 문서 등록 | 승인한 초안 저장 | `agent·review·tool` / 문서 서비스 | 초안·위치 → 문서 링크 | 승인 내용과 실제 문서 재조회 일치 |
| EP-038 보고서 필수 요소 점검 | 배포 요건 확인 | `document_extract·evaluate·review` | 보고서·기준 → 누락 목록 | 지정 필수 항목의 누락을 검출 |
| EP-039 운영 로그 정기 요약 | 기간별 사건 취합 | `trigger·program·agent` / 로그 파일 | 기간·로그 → 집계·요약 | 집계·시각 일치, 중복 기간 처리 방지 |
| EP-040 항목 일괄 태깅 | 분류표에 따라 태그 부여 | `loop·classify·review` | 목록·태그 → 분류 목록 | 허용 태그만 사용, 미분류 보존 |

---

**EP-041~060은 문서처리와 운영 하네스 프로젝트입니다.**

하네스 점검은 사용자가 허용하거나 내보낸 실제 운영 기록을 사용합니다. 승인 생성·임의 재전송·개발용 모의 실행 기능을 제공하지 않습니다.

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-041 PDF 근거 요약 | 페이지 근거와 함께 요약 | `document_extract·agent·evaluate` | PDF → 요약·페이지 근거 | 인용 위치 일치, 추출 실패 표시 |
| EP-042 스캔 회의록 정리 | OCR 후 결정 추출 | `document_extract·agent·review` / OCR | 스캔 → 결정·업무·불확실 구간 | 담당·기한 대조, 애매한 값 표시 |
| EP-043 문서 구조 목차화 | 제목 계층 정리 | `document_extract·program·agent` | 문서 → 계층 목차 | 원문 제목 순서·계층·구간 일치 |
| EP-044 내부 지침 개정 비교 | 적용 기준 변화 확인 | `document_extract·program·agent` | 구·신 지침 → 변경·영향 | 버전과 실제 변경 절 연결 |
| EP-045 표 추출·단위 정리 | 문서 표 재사용 | `document_extract·program·review` | 표 문서 → CSV·단위표 | 행·열·필수 셀·단위 대조 |
| EP-046 문서 묶음 인덱스 | 자료 탐색 지도 생성 | `loop·document_extract·agent·merge` | 문서 묶음 → 주제 인덱스 | 모든 파일 포함, 구간 연결 |
| EP-047 공개 문서 마스킹 | 지정 정보 가림 | `document_extract·guardrail·review` | 문서·기준 → 가린 사본 | 기준 검출 사례 확인, 원본 보존 |
| EP-048 신청서 필드 추출 | 양식 구조화 | `document_extract·agent·evaluate` | 신청서·필드 → 레코드 | 원문 값 대조, 누락값 추측 금지 |
| EP-049 문서 중복·유사본 점검 | 대표본과 차이 확인 | `program·agent·review` | 문서 묶음 → 동일·유사 그룹 | 동일·유사 구분, 자동 삭제 없음 |
| EP-050 주장·근거 대조 | 보고서 주장 확인 | `retrieval·agent·evaluate` | 주장·문서 → 근거 판정표 | 모든 판정에 구간 또는 불충분 표시 |
| EP-051 기준 질문 품질 하네스 | 실제 결과 품질 비교 | `loop·subworkflow·evaluate` | 질문·기준 → 품질 보고 | 실제 실행 ID 연결, 호출 한도 준수 |
| EP-052 결과 계약 하네스 | 산출물 형식 검사 | `program·condition` / 스키마 검사기 | 결과·스키마 → 오류 위치 | 누락·자료형·추가 필드 판정 |
| EP-053 실행 예산 하네스 | 사용량 확인 | `file_input·program·condition` | 실행 기록·한도 → 사용량 | 원시 호출량 대조, 추정 비용 구분 |
| EP-054 승인 범위 감사 | 승인과 수행 내용 대조 | `program·review` / 운영 기록 | 승인·작업 기록 → 불일치 목록 | 대상·인자·계획 해시 대조 |
| EP-055 외부 작업 중복 점검 | 반복 수행 여부 확인 | `program·condition·review` | 작업·시도 기록 → 중복 후보 | 작업 ID·시도 ID 구분, 재전송 없음 |
| EP-056 중단 실행 복구 계획 | 재개 지점 확인 | `file_input·program·agent·review` | 체크포인트 → 복구 계획 | 완료 작업 재실행 제외, 불명확 작업 분리 |
| EP-057 연결 가용성 점검 | 서비스 준비 상태 확인 | `loop·tool·condition·merge` | 연결 목록 → 접근·응답 상태 | 실제 읽기 호출, 서비스 변경 없음 |
| EP-058 산출물 민감 정보 점검 | 공개 전 위험 항목 확인 | `guardrail·evaluate·review` | 결과·공개 기준 → 검토 대상 | 기준 유형 검출, 로그 재노출 없음 |
| EP-059 결과 파일 무결성 점검 | 등록 파일과 실제 파일 대조 | `file_input·program·condition` | 명세·파일 → 누락·변조 목록 | 실제 바이트 해시·크기 일치 |
| EP-060 실행 환경 호환 점검 | 필요한 기능 확인 | `program·condition·review` | 패키지·환경 정보 → 준비 상태 | 실제 모드·버전·의존성과 대조 |

---

**EP-061~080은 멀티 에이전트와 병렬 에이전트 프로젝트입니다.**

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-061 릴리스 노트 편집팀 | 변경을 사용자 안내로 전환 | `agent_team·tool·review` / GitHub | 병합 목록 → 릴리스 노트 | 변경 ID 추적, 없는 기능 추가 금지 |
| EP-062 기술 제안서 검토팀 | 요구사항 충족 확인 | `agent_team·document_extract·evaluate` | 요구·제안서 → 충족표 | 요구 ID마다 근거·판정 존재 |
| EP-063 교육 과정 설계팀 | 수업·실습·평가 통합 | `agent_team·resource·evaluate` | 목표·자료 → 교육 과정 | 목표별 수업·평가·실습 자료 연결 |
| EP-064 장애 회고 작성팀 | 사실·가설·조치 분리 | `agent_team·guardrail·review` | 사건 기록 → 회고·조치 | 시각·ID 일치, 원인 가설 표시 |
| EP-065 아키텍처 결정팀 | 선택 근거 문서화 | `agent_team·retrieval·review` | 제약·대안 → ADR | 대안별 근거, 미측정 수치 단정 없음 |
| EP-066 고객 의견 개선팀 | 의견을 개선 후보로 전환 | `agent_team·classify·program` | 의견 목록 → 주제·빈도·개선안 | 원문 ID와 실제 빈도 일치 |
| EP-067 역할별 온보딩팀 | 준비·업무·지원 통합 | `agent_team·resource·form` | 역할·자료 → 온보딩 계획 | 준비 항목 근거·완료 조건 존재 |
| EP-068 사용 설명서 검토팀 | 절차·용어 누락 확인 | `agent_team·document_extract·evaluate` | 설명서·기능 → 수정안 | 기준 기능 누락 검출, 없는 화면 생성 금지 |
| EP-069 접근성 개선 작업팀 | 검사 결과를 작업화 | `agent_team·program·review` | 검사 보고 → 개선 작업 | 오류 ID별 조치·재확인 절차 |
| EP-070 발표 원고 제작팀 | 사실과 전달 흐름 분담 | `agent_team·resource·evaluate` | 근거·목적 → 원고·메모 | 수치·인용 보존, 분량 기준 준수 |
| EP-071 문서 묶음 쟁점 지도 | 문서별 주장 통합 비교 | `parallel·agent·document_extract·merge` | 문서 묶음 → 공통·쟁점 지도 | 각 쟁점 출처와 입력 문서 추적 |
| EP-072 기술 제안 병렬 비교 | 제안별 근거를 독립 추출 | `parallel·agent·retrieval·merge` | 제안서·기준 → 비교표 | 셀별 출처, 미기재 값 구분 |
| EP-073 다국어 안내 병렬 제작 | 언어별 결과 생성 | `parallel·agent·skill·evaluate` | 원문·언어 → 안내문 묶음 | 용어·날짜·링크 보존 |
| EP-074 모듈별 API 참조 점검 | 코드와 API 연결 확인 | `parallel·agent·tool·merge` / GitHub | 모듈·명세 → 참조 점검표 | 실제 심벌·경로 연결, 저장소 변경 없음 |
| EP-075 CSV 묶음 품질 검사 | 파일별 문제 취합 | `parallel·program·agent·merge` | CSV 묶음 → 품질 보고 | 계산 수치 일치, 문제 행 추적 |
| EP-076 출처별 공지 취합 | 기간별 공지 정리 | `parallel·retrieval·agent·merge` / 웹 | 출처·기간 → 공지 목록 | 시각·원문 확인, 허용 출처 준수 |
| EP-077 채널별 콘텐츠 제작 | 같은 사실을 형식별 변환 | `parallel·agent·resource·evaluate` | 안내 원문 → FAQ·공지·도움말 | 형식 기준 준수, 내용 모순 없음 |
| EP-078 독립 근거 조사 대조 | 출처의 일치·충돌 확인 | `parallel·agent·retrieval·evaluate` | 질문 → 근거 비교 | 근거 없는 합의 생성 금지 |
| EP-079 회의 간 결정 충돌 대조 | 여러 회의의 변경·충돌 확인 | `parallel·agent·document_extract·merge` | 회의 묶음 → 충돌·승계 결정 | 회의·시점·결정 근거 보존 |
| EP-080 변경로그 병렬 취합 | 패키지별 변경 조사 | `parallel·retrieval·program·agent` | 버전 목록 → 변경 보고 | 버전 범위 정확, 미확인 공지 표시 |

---

**EP-081~100은 Sub Agent와 오케스트레이션 프로젝트입니다.**

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-081 요청 명세화 Sub Agent | 하위 작업 계약 생성 | `subworkflow·agent·form` | 요청 → 목표·입력·완료 조건 | 필수 정보 없으면 질문 |
| EP-082 FAQ 생성 Sub Agent | 설명서에서 FAQ 작성 | `subworkflow·agent·retrieval` | 설명서 → 근거 FAQ | 문서 밖 기능 추가 없음 |
| EP-083 발주 문서 추출 Sub Agent | 품목·수량 구조화 | `subworkflow·document_extract·program` | 발주 문서 → 레코드 | 필수 값·합계 대조, 불명확 값 표시 |
| EP-084 번역 용어 검토 Sub Agent | 용어 일관성 확인 | `subworkflow·agent·resource·evaluate` | 원문·번역 → 용어 오류 | 위반 검출, 허용 동의어 보존 |
| EP-085 이슈 재현 절차 Sub Agent | 재현 가능한 단계 작성 | `subworkflow·agent·tool·review` / GitHub | 이슈·환경 → 절차·부족 정보 | 전제·관찰 결과 구분, 미실행을 실행했다고 표시하지 않음 |
| EP-086 절별 근거 수집 Sub Agent | 특정 질문만 조사 | `subworkflow·agent·retrieval` | 절별 질문 → 근거 묶음 | 위임 범위·검색 한도 준수 |
| EP-087 파일 처리 대상 선정 Sub Agent | 허용된 파일 범위 확정 | `subworkflow·agent·program·review` | 파일 목록·목적 → 대상 목록 | 원본 ID 보존, 범위 밖 파일 제외 |
| EP-088 역할 준비 항목 Sub Agent | 역할별 부족 조건 확인 | `subworkflow·agent·resource` | 역할·상태 → 준비 항목 | 역할 자료·권한 범위 준수 |
| EP-089 문서 등록 Sub Agent | 지정 위치에 승인 등록 | `subworkflow·agent·review·tool` / 문서 서비스 | 내용·대상 → 등록 기록 | 내용 검토·보안 승인 구분, 중복 방지 |
| EP-090 데이터 수정 검토 Sub Agent | 정리 전후 차이 검증 | `subworkflow·program·agent·review` | 원본·수정본 → 차이 보고 | 실제 셀 변화 일치, 원본 보존 |
| EP-091 문의 해결 경로 조율 | 검색·질문·검토 선택 | `orchestrator·retrieval·form·review` | 문의 → 답변·확인 요청 | 근거 부족 시 확인, 허용 경로 준수 |
| EP-092 자료 확보 실패 대응 | 대체 출처로 조사 | `orchestrator·retrieval·evaluate` | 질문·출처 → 확보·미확인 자료 | 실패 기록, 허용 대체 출처만 사용 |
| EP-093 혼합 문서 접수 조율 | 파일별 추출 방식 선택 | `orchestrator·program·document_extract` | 텍스트·스캔 → 추출 결과 | 적절한 모드 선택, 실패 페이지 표시 |
| EP-094 행사 준비 누락 조율 | 준비 부족을 단계적으로 해결 | `orchestrator·form·subworkflow` | 준비 상태 → 보완 요청·준비표 | 미해결 필수 항목을 완료로 표시하지 않음 |
| EP-095 업무 요청 묶음 조율 | 우선순위·선행 작업 실행 | `orchestrator·classify·subworkflow` | 요청·규칙 → 계획·결과 | 선행 관계·작업 수 한도 준수 |
| EP-096 지식 변경 영향 조율 | 변경 자료의 후속 처리 | `orchestrator·knowledge·program` | 문서 변경 → 갱신 작업 | 불필요한 재처리 방지, 버전 기록 |
| EP-097 품질 기준 수정 조율 | 제한된 횟수로 개선 | `orchestrator·agent·evaluate·review` | 초안·기준 → 수정본·검토 요청 | 수정 상한 준수, 미달을 성공 처리하지 않음 |
| EP-098 승인된 자료 게시 조율 | 검토·등록·보상 연결 | `orchestrator·review·tool·compensate` | 자료·대상 → 게시 기록 | 선행 승인 준수, 확인된 작업만 보상 |
| EP-099 변경 시에만 보고 | 반복 호출 줄이기 | `trigger·orchestrator·memory·program` | 자료·예약 → 변경 보고 | 동일 버전 중복 처리 방지 |
| EP-100 파일 납품 패키지 조율 | 준비물부터 결과 묶음 생성 | `orchestrator·subworkflow·program·file_output` | 납품 항목 → 파일 묶음 | 필수 파일·형식·목록 일치 |

---

**EP-101~120은 RAG·Agentic RAG·Hybrid RAG·GraphRAG 프로젝트입니다.**

| ID·이름 | 목적 | 핵심 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| EP-101 업무 안내서 RAG | 지정 자료에서 답변 | `knowledge·retrieval·ai` | 안내서·질문 → 인용 답변 | 정답 구간 인용, 근거 없는 질문 유보 |
| EP-102 제품 문제 해결 RAG | 제품 버전별 절차 안내 | `knowledge·retrieval·ai·review` | 증상·버전 → 해결 안내 | 다른 버전 절차 혼입 없음 |
| EP-103 회의 결정 이력 RAG | 결정·시점 찾기 | `knowledge·retrieval·ai` | 질문 → 결정 이력 | 실제 결정문·회의·시점 일치 |
| EP-104 기술 문서 버전 RAG | 버전 차이 설명 | `parallel·retrieval·ai·merge` | 질문·두 버전 → 차이·근거 | 버전별 출처 구분 |
| EP-105 연구 근거 목록 RAG | 문헌 구간 정리 | `knowledge·retrieval·ai` | 연구 질문 → 근거 목록 | 주장·해석 구분, 인용 위치 확인 |
| EP-106 질문 분해 Agentic RAG† | 복합 질문을 나눠 검색 | `agent·tool·retrieval·merge` / 등록 검색 | 복합 질문 → 통합 답변 | 하위 질문 포함, 검색 한도 준수 |
| EP-107 추가 질문 Agentic RAG† | 근거 부족 보완 | `agent·tool·evaluate·form` | 불완전 질문 → 확인·답변 | 부족 사례에서 임의 답변 대신 질문 |
| EP-108 충돌 조사 Agentic RAG† | 상충 근거 재조사 | `agent·tool·evaluate·review` | 주장·자료 → 충돌 설명 | 상충 내용·버전·해결 한계 표시 |
| EP-109 다단계 근거 Agentic RAG† | 문서 사이 연결 추적 | `agent·tool·memory·evaluate` | 관계 질문 → 단계별 근거 | 각 단계에 실제 출처 존재 |
| EP-110 최신성 Agentic RAG† | 시점에 따른 재검색 | `agent·tool·condition` / 버전·웹 검색 | 질문·기준일 → 최신 근거 | 확인 시점 기록, 오래된 자료 구분 |
| EP-111 부품 번호·증상 Hybrid RAG† | 코드와 의미 동시 검색 | `knowledge·retrieval·ai` / 융합·reranker | 번호·증상 → 절차 | 정답 구간 상위 회수, 유사 코드 구분 |
| EP-112 해결 이력 Hybrid RAG† | 실제 해결 근거 우선 | `knowledge·retrieval·ai` / 융합·reranker | 문의 → 관련 해결 이력 | 정답 사례 회수, 접근 범위 누출 없음 |
| EP-113 한·영 Hybrid RAG† | 언어가 다른 자료 연결 | `knowledge·retrieval·ai` / 다국어·reranker | 한·영 질문 → 근거 답변 | 양방향 질문 세트, 식별자 보존 |
| EP-114 요구사항 reranker RAG† | 긴 질의의 핵심 근거 선택 | `retrieval·evaluate·ai` / reranker | 요구사항 → 항목별 근거 | 정답 구간·재정렬 전후 순위 기록 |
| EP-115 중복 정리 Hybrid RAG† | 복제본보다 원문 우선 | `retrieval·program·ai` / 융합·reranker | 질문·중복 자료 → 대표 근거 | 복제본 독점 방지, 원문 선택 추적 |
| EP-116 서비스 의존 GraphRAG† | 변경의 관계 경로 확인 | `knowledge·retrieval·agent` / 그래프 | 설계·변경 대상 → 영향 후보 | 실제 간선·경로·원문 근거 일치 |
| EP-117 프로젝트 지식 GraphRAG† | 프로젝트·역할·기술 연결 | `knowledge·retrieval·ai` / 그래프 | 허용 자료·질문 → 관련 지식 | 별칭·동명 구분, 비공개 정보 제외 |
| EP-118 기능·버전 GraphRAG† | 기능과 제약 관계 조회 | `knowledge·retrieval·ai` / 그래프 | 기능·버전 → 지원 관계 | 기준 버전 관계와 출처 일치 |
| EP-119 전체 주제 GraphRAG† | 자료 집합의 주제군 요약 | `knowledge·retrieval·ai·review` / 전역 검색 | 자료 집합 → 주제군·차이 | 커뮤니티 요약의 원문 추적 |
| EP-120 업무 절차 GraphRAG† | 역할·자료·선행 단계 연결 | `knowledge·retrieval·agent` / 그래프 | 업무 목표 → 선행·담당 관계 | 실제 선행 관계, 없는 연결은 확인 필요 |

---

**ER-001~010은 MCP 연결 예제입니다.**

아래 서비스의 MCP 제공 여부와 Studio의 실제 연동 완료는 구분합니다. 공식 연결 정의를 기반으로 검증한 범위만 공개하겠습니다.

| ID·이름 | 목적 | 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-001 [GitHub 연결](https://github.com/github/github-mcp-server) | 저장소 조사·승인된 이슈 등록 | `tool·agent` / GitHub | 저장소·요청 → 근거·이슈 ID | 조회 일치, 변경은 승인 범위만 |
| ER-002 [Notion 연결](https://www.notion.com/help/notion-mcp) | 문서 조회·작성 | `tool·review` / Notion | 페이지·내용 → 문서 결과 | 지정 범위·작성 후 재조회 일치 |
| ER-003 [Atlassian 연결](https://atlassian.github.io/atlassian-mcp-server/) | 업무·지식 자료 취합 | `tool·agent` / Jira·Confluence | 프로젝트·질의 → 이슈·문서 | 실제 ID·상태·권한 범위 대조 |
| ER-004 [Linear 연결](https://linear.app/docs/mcp) | 업무 진행 확인 | `tool·agent` / Linear | 팀·기간 → 진행 현황 | 담당·기한·상태가 원본과 일치 |
| ER-005 [Figma 읽기 연결](https://developers.figma.com/docs/figma-mcp-server/) | 설계 구조 확인 | `tool·agent` / Figma | 파일·노드 → 구조·속성 | 지정 노드·속성과 일치 |
| ER-006 [Supabase 제한 연결](https://supabase.com/docs/guides/ai-tools/mcp) | 스키마·읽기 조회 | `tool` / 제한 프로젝트 | 질의 → 조회 결과 | 허용 프로젝트만 접근, 쓰기 차단 |
| ER-007 [Sentry 연결](https://mcp.sentry.dev/) | 오류 사건 조사 | `tool·agent` / Sentry | 프로젝트·기간 → 오류 정보 | 사건 ID·횟수·시각 대조 |
| ER-008 [Cloudflare 문서 연결](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) | 공식 기술 자료 검색 | `tool·retrieval` / 문서 MCP | 질문 → 문서 근거 | 공식 본문과 인용 일치 |
| ER-009 [Playwright 연결](https://github.com/microsoft/playwright-mcp) | 허용 사이트 관찰 | `tool·agent` / 격리 브라우저 | URL·확인 항목 → 관찰 결과 | 허용 사이트 준수, 실제 화면 대조 |
| ER-010 [Microsoft Learn 연결](https://learn.microsoft.com/en-us/training/support/mcp-developer-reference) | 기술 문서·샘플 조회 | `tool·retrieval` / Learn MCP | 질문 → 문서·샘플 | 검색·본문 조회와 출처 확인 |

---

**ER-011~040은 독립적으로 적용할 수 있는 작업 지침입니다.**

| ID·이름 | 목적 | 사용 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-011 요청 구체화 지침 | 실행 조건 정리 | `agent·form` | 요청 → 목표·질문 | 필수 누락만 질문, 가정 표시 |
| ER-012 완료 조건 지침 | 판정 기준 작성 | `ai·evaluate` | 작업 → 완료 조건 | 대상·검사 방법 존재 |
| ER-013 근거 우선 답변 | 주장·출처 연결 | `retrieval·ai` | 자료·질문 → 인용 답변 | 출처 없는 확정 주장 금지 |
| ER-014 외부 자료 취급 | 문서 속 명령 구분 | `agent·guardrail` | 외부 문서 → 정보 | 외부 문서로 권한 확대 없음 |
| ER-015 최소 도구 사용 | 불필요한 호출 감소 | `agent·tool` | 목표·도구 → 호출 제안 | 허용 목록·변경 범위 준수 |
| ER-016 변경 작업 설명 | 승인 내용을 명확히 전달 | `agent·review` | 변경 제안 → 영향 설명 | 실제 대상·인자와 일치 |
| ER-017 재시도 판단 | 실패와 결과 불명 구분 | `agent` / 작업 상태 | 실패 → 확인·재시도 제안 | 불명확한 변경의 재전송 금지 |
| ER-018 불확실성 표현 | 확인 범위 명시 | `ai·evaluate` | 부분 자료 → 답변 | 사실·추정·미확인 구분 |
| ER-019 긴 문맥 요약 | 제약을 보존해 압축 | `ai·memory` | 긴 기록 → 인계 요약 | 결정·제약·미해결 사항 보존 |
| ER-020 사용자 확인 지침 | 진행 불가 사유 안내 | `agent·form` | 충돌·누락 → 확인 요청 | 필요한 결정만 요청 |
| ER-021 API 전문가 지침 | 계약 검토 관점 제공 | `agent·resource` | 명세 → 점검표 | 인증·오류·버전·경로 근거 |
| ER-022 DB 전문가 지침 | 읽기 중심 조사 | `agent·tool` / 제한 DB | 질문·스키마 → 조회 계획 | 쓰기 제안 없이 필요한 범위만 |
| ER-023 성능 분석 지침 | 측정값 해석 | `agent·program` | 측정값 → 가설·확인안 | 사실과 가설 분리 |
| ER-024 접근성 검토 지침 | 관찰 가능한 문제 정리 | `agent·tool` / 브라우저 | 화면 → 발견 사항 | 위치·영향·확인 방법 존재 |
| ER-025 빌드 오류 분석 | 오류 원인 후보 축소 | `agent·resource` | 로그 → 최초 오류·조치 | 핵심 로그 근거, 무관한 변경 억제 |
| ER-026 초보 사용자 관점 | 안내 이해도 점검 | `ai·evaluate` | 설명 → 혼동·누락 | 용어·다음 행동을 구체 지적 |
| ER-027 운영 담당자 관점 | 우선 조치 보고 | `ai·evaluate` | 사건 → 조치 보고 | 영향·담당·기한·행동 포함 |
| ER-028 비판적 검토 관점 | 주장과 반례 점검 | `ai·evaluate` | 제안 → 반례·부족 근거 | 주장별 근거 연결 |
| ER-029 쉬운 설명 편집 | 전문 표현 변환 | `ai·evaluate` | 전문 문서 → 쉬운 설명 | 사실·수치·제약 보존 |
| ER-030 다국어 독자 관점 | 의미 차이 검토 | `ai·resource` / 용어집 | 원문·언어 → 검토표 | 고유명사·단위·날짜 의미 유지 |
| ER-031 구조화 추출 지침 | 지정 필드 추출 | `ai·evaluate` | 문서·스키마 → 레코드 | 미기재 값 추측 금지 |
| ER-032 정규화 작업 지침 | 날짜·단위 표준화 | `ai·program` | 레코드 → 정규화 결과 | 원본과 적용 규칙 추적 |
| ER-033 출처 위치 지침 | 페이지·구간 인용 | `document_extract·ai` | 본문 → 인용 위치 | 실제 원문 위치 일치 |
| ER-034 정보 가림 지침 | 공개 전 검토 | `guardrail·review` | 문서 → 가림 후보 | 정의한 유형 검출·검토 |
| ER-035 멀티 에이전트 역할 계약 | 역할·산출물 구분 | `agent_team` | 업무 → 역할 계약 | 책임 누락·중복 확인 |
| ER-036 병렬 결과 합의 지침 | 공통점·충돌 보존 | `parallel·merge·ai` | 분기 결과 → 합의·쟁점 | 불일치를 임의 삭제하지 않음 |
| ER-037 Sub Agent 인계 지침 | 최소 입력으로 위임 | `subworkflow·agent` | 부모 작업 → 하위 요청 | 목표·한도·결과 계약 포함 |
| ER-038 재계획 지침 | 실패를 반영해 조정 | `orchestrator` | 계획·결과 → 수정 계획 | 완료 작업 보존, 권한 확대 없음 |
| ER-039 RAG 답변 유보 | 근거 부족 처리 | `retrieval·ai·condition` | 검색 결과 → 답변·유보 | 무관한 근거로 확정 답변하지 않음 |
| ER-040 그래프 근거 설명† | 관계 경로 설명 | `retrieval·ai` / 그래프 | 경로 → 설명·출처 | 관계마다 원문 근거 연결 |

---

**ER-041~060은 실제 내용이 있는 활용 문서와 자료집입니다.**

아래 자료는 빈 양식이나 제목만 있는 문서로 제공하지 않습니다. 샘플 자료라면 샘플임을 표시하고, 실제 검색·추출·작성에 사용할 수 있는 내용을 포함합니다.

| ID·이름 | 목적 | 사용 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-041 에이전트 업무 운영 안내서 | 역할·승인·중단 기준 참고 | `resource·agent` | 업무 조건 → 운영 기준 | 해당 절을 근거로 적용 |
| ER-042 API 계약 읽기 안내서 | 명세 해석 지원 | `resource·agent` | API 명세 → 계약 설명 | 실제 명세 필드에 기준 적용 |
| ER-043 읽기 전용 데이터 사전 | 테이블·관계 이해 | `resource·retrieval` | 질문 → 필드·관계 | 예제 DB 이름·형식과 일치 |
| ER-044 변경 절차 문서 | 준비·승인·확인 순서 | `resource·orchestrator` | 변경 요청 → 절차 | 필수 확인·승인 단계 보존 |
| ER-045 장애 대응 안내서 | 사건 확인·인계 | `resource·agent` | 사건 → 대응 순서 | 허용 접근 범위를 넘지 않음 |
| ER-046 제품 FAQ 지식집 | RAG 원본 제공 | `knowledge·retrieval` | 질문 → 답변 근거 | 정답·답변 불가 질문 구분 |
| ER-047 기능 카탈로그 | 기능 비교 근거 | `knowledge·program` | 조건 → 비교표 | 기능·제약·ID 대조 |
| ER-048 회의 기록 자료집 | 결정·업무 추출 | `document_extract·ai` | 회의록 → 후속 작업 | 원문 담당·기한만 추출 |
| ER-049 규칙 개정 자료집 | 시점별 기준 비교 | `retrieval·ai` | 시점·질문 → 적용 기준 | 올바른 버전·출처 선택 |
| ER-050 한·영 업무 용어집 | 용어·검색 일관성 | `resource·transform` | 문서 → 용어 정리 | 지정 매핑과 의미 보존 |
| ER-051 표 포함 보고서 | 표 추출 입력 | `document_extract·program` | PDF → 표 데이터 | 행·열·필수 셀·페이지 대조 |
| ER-052 스캔 문서 자료집 | OCR 입력 제공 | `document_extract·evaluate` | 스캔 → 본문·필드 | 고정 정답·위치 비교 |
| ER-053 역할·담당 범위표 | 업무 분담 근거 | `resource·agent_team` | 업무 → 역할 배정 | 없는 책임자 생성 금지 |
| ER-054 승인 흐름 정의서 | 분기·검토 설계 | `resource·orchestrator` | 유형 → 승인 계획 | 조건·승인 단계 일치 |
| ER-055 개체 식별 사전† | 안정된 그래프 ID | `knowledge·program` | 명칭 → 개체 ID | 별칭·동명이인 정답 대조 |
| ER-056 관계·출처 온톨로지† | 관계 형식 정의 | `knowledge·program` | 문장 → 관계 레코드 | 타입·방향·출처 준수 |
| ER-057 자료 접근 범위 정의서 | 검색 범위 설명 | `resource·retrieval` | 사용자 범위 → 허용 조건 | 실제 권한 필터와 일치 |
| ER-058 질문·정답·출처 평가집 | RAG 품질 측정 | `retrieval·evaluate` | 질문 → 평가표 | 정답 회수·근거 일치 측정 |
| ER-059 근거 부족 사례집 | 답변 유보 확인 | `retrieval·evaluate` | 질문·무관 자료 → 유보 | 없는 답을 만들지 않음 |
| ER-060 상충 출처 사례집 | 시점·주장 충돌 처리 | `retrieval·ai` | 충돌 자료 → 비교·유보 | 양측 주장·출처 보존 |

---

**ER-061~080은 역할·협업용 Skill입니다.**

지침과 함께 스키마·템플릿·검사 코드를 제공해 단순 작업 지침과 구분합니다.

| ID·이름 | 목적·구성 | 사용 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-061 목표 명세 Skill | 질문 흐름·목표 스키마 | `skill·form·agent` | 요청 → 실행 명세 | 필수값·모호한 조건 검사 |
| ER-062 근거 보드 Skill | 주장·출처 템플릿 | `skill·retrieval·ai` | 자료·주장 → 근거 보드 | 확정 주장에 실제 출처 |
| ER-063 대안 비교 Skill | 비교표·누락 검사 | `skill·ai·evaluate` | 대안·기준 → 비교표 | 동일 기준, 미확인 값 구분 |
| ER-064 API 변경 Skill | 명세 비교 코드·보고서 | `skill·program` | 구·신 명세 → 변경표 | 실제 추가·삭제·변경 일치 |
| ER-065 읽기 SQL Skill | 스키마·질의 검사 코드 | `skill·agent·tool` / 제한 DB | 질문 → 질의·결과 | 쓰기 차단, 실제 조회 검사 |
| ER-066 로그 정리 Skill | 파서·오류 분류표 | `skill·program·agent` | 로그 → 오류 그룹 | 위치·횟수·시각 보존 |
| ER-067 성능 해석 Skill | 집계 코드·보고서 | `skill·program·ai` | 측정값 → 비교·가설 | 계산 재현, 가설 구분 |
| ER-068 접근성 점검 Skill | 관찰·재현 템플릿 | `skill·agent·tool` | 화면 → 발견 사항 | 실제 화면 위치·근거 |
| ER-069 독자별 설명 Skill | 독자 카드·사실 검사 | `skill·ai·evaluate` | 원문·독자 → 설명 | 사실·수치·제약 보존 |
| ER-070 관점별 이견 Skill | 관점 카드·쟁점표 | `skill·agent_team·merge` | 제안 → 이견·쟁점 | 관점·근거 추적 |
| ER-071 레코드 추출 Skill | 스키마·필드 검증 코드 | `skill·document_extract·program` | 문서 → 레코드 | 타입·원문 근거 일치 |
| ER-072 회의 후속 Skill | 결정·담당·기한 템플릿 | `skill·ai·review` | 회의록 → 업무표 | 미지정 정보는 미정 |
| ER-073 페이지 인용 Skill | 페이지·구간 매핑 코드 | `skill·document_extract·program` | 본문·인용 → 위치 | 원본에서 인용 확인 |
| ER-074 문서 품질 Skill | 검토표·점수 산식 | `skill·evaluate·review` | 문서 → 항목별 평가 | 평가 근거·수정 위치 존재 |
| ER-075 공개본 가림 Skill | 규칙·마스킹 코드 | `skill·guardrail·review` | 원문 → 공개 사본 | 기준 유형 검사, 원본 보존 |
| ER-076 역할 분배 Skill | 역할 계약 스키마 | `skill·agent_team` | 업무 → 배정표 | 책임 누락·권한 확대 없음 |
| ER-077 병렬 통합 Skill | 중복·충돌 처리 코드 | `skill·parallel·merge` | 분기 결과 → 통합본 | 순서·출처·충돌 보존 |
| ER-078 Sub Agent 인계 Skill | 요청·응답 계약 검사 | `skill·subworkflow` | 인계 자료 → 검사 결과 | 입출력·자료·완료 조건 검사 |
| ER-079 팀 실행 설계 Skill | 역할·순서 템플릿 | `skill·agent_team` | 목표 → 팀 정의 | 역할별 입력·전달 순서 검증 |
| ER-080 재계획 비교 Skill | 계획 차이 코드 | `skill·orchestrator·review` | 전후 계획 → 차이·영향 | 완료 작업 보존, 추가 권한 표시 |

---

**ER-081~100은 코드·템플릿 기반 파일 처리와 운영 하네스 Skill입니다.**

| ID·이름 | 목적·구성 | 사용 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-081 CSV 정리 Skill | 헤더·빈값·인코딩 코드 | `skill·program·file_output` | CSV → 정리본 | 행 수·변환 내역 추적 |
| ER-082 날짜·단위 Skill | 변환표·검산 코드 | `skill·program` | 레코드·규칙 → 정규화 | 시간대·단위·반올림 대조 |
| ER-083 OCR 필드 Skill | 후처리·필드 스키마 | `skill·document_extract·evaluate` | 스캔 → 필드·불확실 값 | 필수 값 대조, 애매한 값 분리 |
| ER-084 PDF 표 Skill | 표 정리·CSV 코드 | `skill·document_extract·program` | PDF → CSV | 헤더·병합 셀·수치 대조 |
| ER-085 DOCX 보고서 Skill | 문서 템플릿·생성 코드 | `skill·program·file_output` | JSON → DOCX | 필수 절·표 포함, 실제 열기 |
| ER-086 HTML 보고서 Skill | HTML·CSS·이스케이프 | `skill·program·file_output` | JSON → 보고서 | 값 일치, 입력 스크립트 실행 없음 |
| ER-087 파일 이름 Skill | 이름·충돌 처리 코드 | `skill·program·file_output` | 파일 → 복사본·대응표 | 경로 이탈·덮어쓰기 없음 |
| ER-088 파일 분할 Skill | 스트리밍·검증 코드 | `skill·program` | 큰 파일 → 조각·명세 | 재결합 해시 일치, 자원 제한 |
| ER-089 중복 문서 Skill | 파일·본문 지문 코드 | `skill·program·review` | 문서 묶음 → 중복 후보 | 동일본 검출, 자동 삭제 없음 |
| ER-090 문서 개정 Skill | 차이 계산·대비 틀 | `skill·program·ai` | 전후 문서 → 변경 보고 | 추가·삭제·수정 위치 일치 |
| ER-091 실행 계약 Skill | 입출력 스키마 검사 | `skill·program` | 결과·계약 → 오류 목록 | 정상 통과·지정 오류 검출 |
| ER-092 권한 변화 Skill | 명세 차이 코드 | `skill·program·review` | 패키지 두 버전 → 권한 차이 | 도구·경로·도메인 변화 추적 |
| ER-093 실행량 예상 Skill | 호출·토큰 계산표 | `skill·program` | 계획·크기 → 예상 사용량 | 계산 재현, 예상·실제 구분 |
| ER-094 산출물 완전성 Skill | 파일·필드 검사 코드 | `skill·program` | 기대·실제 목록 → 누락 | 필수 파일·필드·참조 검사 |
| ER-095 재시도 상태 Skill | 작업 상태 판정 규칙 | `skill·program·review` | 기록 → 재시도·확인 대상 | 불명확한 변경의 재실행 허용 금지 |
| ER-096 취소 결과 Skill | 상태 대조 코드 | `skill·program` | 취소 기록 → 상태 보고 | 이미 발생한 변경을 취소로 오인하지 않음 |
| ER-097 재개 준비 Skill | 체크포인트 검사 | `skill·program·review` | 중단 기록 → 준비 보고 | 결과·자료 해시 확인, 자동 재개 없음 |
| ER-098 환경 점검 Skill | 기능·연결 검사표 | `skill·program·tool` | 요구사항 → 준비 상태 | 없는 인증·모드 표시, 비밀 비노출 |
| ER-099 결과 변화 Skill | 구조·지표 비교 코드 | `skill·program·evaluate` | 두 실제 결과 → 변화 | 허용 변화·필수값·출처 차이 구분 |
| ER-100 운영 패키지 검사 Skill | 경로·파일·해시 검사 | `skill·program` | ZIP → 검사 보고 | 변조·누락·개발 자료 검출 |

---

**ER-101~120은 RAG 계열 Skill입니다.**

| ID·이름 | 목적·구성 | 사용 블록·연결 | 입력 → 결과 | 실제 사용 검증 기준 |
|---|---|---|---|---|
| ER-101 문서 정제·분할 Skill | 정제 코드·출처 스키마 | `skill·document_extract·program` | 문서 → 청크 | 본문 누락·중복·위치 검사 |
| ER-102 절 구조 분할 Skill | 제목·표 경계 코드 | `skill·program` | 구조 문서 → 계층 청크 | 절·표·상위 제목 보존 |
| ER-103 검색 메타데이터 Skill | 날짜·분류·범위 매핑 | `skill·knowledge·program` | 청크 → 색인 레코드 | 접근 범위 누락 거부 |
| ER-104 키워드 색인 Skill | 어휘·검색 프로필 | `skill·knowledge·retrieval` | 문서·질문 → 검색 결과 | 식별자·정확 용어 회수 |
| ER-105 임베딩 배치 Skill | 배치 코드·모델 잠금 | `skill·knowledge·program` / 임베딩 | 청크 → 벡터 | ID·개수·차원·모델 일치 |
| ER-106 벡터 검색 Skill | 검색 개수·거리 설정 | `skill·retrieval` / 벡터 | 질문 → 후보 | 정답 문서 회수율 측정 |
| ER-107 인용 답변 조립 Skill | 인용·페이지 매핑 | `skill·retrieval·ai` | 후보 → 인용 답변 | 인용이 실제 청크로 연결 |
| ER-108 질의 재작성 Skill | 용어집·제약 검사 | `skill·agent·retrieval` | 질문 → 검색 질의 | 원래 핵심 조건 보존 |
| ER-109 질문 분해 Skill | 하위 질문 스키마 | `skill·agent·subworkflow` | 복합 질문 → 하위 질문 | 원 요청의 요구를 포함 |
| ER-110 검색원 선택 Skill | 검색 범위·분류표 | `skill·classify·retrieval` | 질문 → 검색원·결과 | 허용 검색원만 호출 |
| ER-111 근거 충분성 Skill | 주장·근거 평가표 | `skill·evaluate·condition` | 후보 → 충분·부족 | 부족 사례를 추가 검색·유보로 분리 |
| ER-112 검색 종료 Skill† | 반복·중복 질의 규칙 | `skill·agent·retrieval` | 검색 이력 → 다음 행동 | 무한 반복 없음, 한도 준수 |
| ER-113 Hybrid 결합 Skill† | ID 정규화·RRF 코드 | `skill·retrieval·program` | 두 순위 → 결합 순위 | 계산 재현, 문서 중복 제거 |
| ER-114 reranker Skill† | 모델·API 어댑터 | `skill·program` / 재정렬 | 질문·후보 → 새 순위 | 후보 밖 문서 생성 없음 |
| ER-115 문맥 예산 Skill† | 토큰·중복·출처 배치 코드 | `skill·program` | 후보·한도 → 문맥 | 한도 준수, 선택·제외 추적 |
| ER-116 검색 품질 Skill | Recall·MRR·nDCG 계산 | `skill·retrieval·program` | 질문·정답·결과 → 지표 | 손계산 사례와 값 일치 |
| ER-117 개체 추출 Skill† | 개체·근거 스키마 | `skill·ai·knowledge` / 그래프 | 문서 → 개체·출처 | ID·유형·원문 구간 대조 |
| ER-118 관계·별칭 Skill† | 타입·별칭 정규화 코드 | `skill·program·review` / 그래프 | 문장·개체 → 관계 후보 | 방향·출처 검사, 충돌 자동 병합 금지 |
| ER-119 근거 경로 Skill† | 제한된 그래프 탐색 코드 | `skill·retrieval·program` / 그래프 | 개체·질문 → 경로 | 실제 간선·간선별 출처 확인 |
| ER-120 커뮤니티 검색 Skill† | 계층 요약·전역 질의 구성 | `skill·knowledge·retrieval·ai` | 전체 질문 → 요약·근거 | 요약에서 원문·관계 추적 |

---

**이 목록을 지원하려면 기존 개발 계획에 다음 작업을 추가해야 합니다.**

| 추가 작업 | 주요 대상 영역 | 선행 작업 | 완료 기준 |
|---|---|---|---|
| ☐ **P3-10A 검색 공통 계약 보강** | `knowledge`, `retrieval`, 출처·접근 범위 스키마 | 기존 P3-10 | 청크·자료·색인 버전·출처·권한을 일관되게 추적 |
| ☐ **P3-10B Hybrid·reranker 구현** | 검색 어댑터, 순위 융합, 재정렬 프로필 | P3-10A | 키워드·벡터 후보 결합, 재정렬, 사용량·실패 정책 검사 |
| ☐ **P3-10C GraphRAG 구현** | 그래프 색인 Worker, 개체·관계·커뮤니티, 조회 어댑터 | P3-07, P3-10A | 관계 출처·색인 버전·로컬/전역 검색·삭제 갱신 검증 |
| ☐ **P3-13A Agentic RAG 구현** | 등록 검색 도구, 검색 행동·종료 정책 | P3-13, P3-10A | 제한된 반복 검색, 근거 부족 확인, 허용 범위 밖 호출 차단 |
| ☐ **P3-17A RAG 품질 검사** | 기준 질문·정답·출처와 지표 계산 | 위 검색 기능 | 회수·순위·근거·유보·권한 검사 통과 |
| ☐ **E-01 예제 목록 갱신** | 공식 프로젝트·자료 제작 명세 | 위 목록 확정 | 120개씩 목적·입출력·의존성·검증 기준 등록 |
| ☐ **E-02~04 실제 제작·검수·발행** | 실제 파일·검증 기록·공식 목록 | 해당 실행 기능 | 유효한 공개 프로젝트·자료 각각 100개 이상 |

31개 블록 이름은 유지하되 새 검색 전략과 기능을 스키마·블록 버전·필수 기능 목록에 반영합니다.

GraphRAG 색인 중의 모델·임베딩 호출도 Runner 호출 관리자를 통과하도록 합니다. 검색 결과뿐 아니라 그래프 관계와 커뮤니티 요약에서도 접근 범위를 지켜야 하므로, 조회 후 필터만 붙이는 것으로 권한 처리를 끝내지 않습니다.

---

**각 예제가 공식 목록에 들어가기 위한 조건은 동일합니다.**

- 실제 프로젝트·자료 파일이 존재해야 합니다.
- 필요한 계정·권한·입력·지원 환경·예상 사용량을 설명해야 합니다.
- 실제 모델·파일·서비스 또는 등록 프로그램으로 사용 검증을 해야 합니다.
- 결과 형식뿐 아니라 해당 예제의 목적을 달성했는지 확인해야 합니다.
- 이름·역할·포장만 바꾼 중복은 별도 개수로 계산하지 않습니다.
- 자료 하나마다 실제 활용 프로젝트 또는 검증 시나리오를 연결합니다.
- 공개본과 검증 기록의 버전·해시가 일치해야 합니다.
- 확장 기능이 준비되지 않았거나 검증이 실패한 항목은 사용 가능 수량에서 제외합니다.
- 운영용 평가집과 점검 코드는 실제 활용 자료로 제공할 수 있지만, 가짜 성공을 만드는 모의 제공자는 배포하지 않습니다.

**이 목록은 프로젝트 120개와 도구·자료 120개의 제작 명세이며, 최종 공개 수량은 실제 사용 검증과 검수를 통과한 항목으로만 산정하겠습니다.**

