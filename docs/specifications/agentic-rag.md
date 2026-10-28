# 현재 실행의 제한된 Agentic RAG

2026-10-28 운영 백엔드 계약. `agent.strategy="agentic_rag"`의 **키워드 검색 + 근거 부족 시 유보** 모드를 구현한다. 기존 canonical agent 스키마를 사용하며 새 노드 타입을 추가하지 않는다. 웹 편집기의 Agentic 작성 폼·공식 예제 게시·실제 공급자 호출 품질은 이번 구현에 포함하지 않는다. 실키·유료 API 호출은 수행하지 않았고 계정 접근 권한·가용성·답변 품질은 **unverified**다.

## 고정 모델과 전송 경계

기존 재순위 계약에서 확인한 [GPT-5.4 Mini 공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-5.4-mini)의 `gpt-5.4-mini-2026-03-17` snapshot, Responses, Structured Outputs, reasoning `none`을 사용한다. 별도 Agentic API나 공급자의 검색 도구를 가정하지 않는다. 일반 `chat` 프로필 중 이 모델을 사용자가 명시적으로 연결해야 한다. 같은 이름의 `reranker`·`embedding` 연결은 사용할 수 없으며 기존 일반 대화 기본 모델도 바꾸지 않는다.

작업·추가 문맥·블록 지침·현재 수집한 원문 근거는 **각 결정마다** [입력 토큰 확인](https://developers.openai.com/api/docs/guides/token-counting)과 응답 생성 요청에서 OpenAI로 전송된다. 로컬 키워드 검색 자체에는 외부 호출이 없다. DPAPI에서 읽은 키는 기존 broker 안에서만 사용하며 ZIP·실행 계획·이벤트에 넣지 않는다. 공급자 snapshot 이름은 고정하지만 공급자 내부 가중치의 영구 불변성·실제 비용 상한을 보증하지 않는다.

불변 계획의 `verifiedDependencies.agenticContract`는 고정 모델·지침·응답 스키마 해시·모든 운영 상한·검색/유보 방식·문맥 측정 의미를 포함한다. 시작, 대기 재개, 각 모델 호출 전에 계획과 현재 프로필을 대조한다. HTTP package metadata에는 사용되는 alias의 `kind:"chat"`와 `openai-agentic-keyword-abstain-v1` constraint만 반환한다. 일반 chat alias에는 이 제약을 붙이지 않는다. Runner 연결 화면은 정확히 맞는 모델만 선택하게 하고 별도 전송 안내를 표시한다.

## 입력과 상한

```json
{
  "inputBindings": {
    "task": { "from": "literal", "value": "배송 정책의 근거를 찾아 답하세요." },
    "indexes": { "from": "node", "nodeId": "index_list", "pointer": "/data", "onMissing": "error" }
  },
  "config": {
    "strategy": "agentic_rag",
    "modelProfile": "planner",
    "instructions": "근거가 없으면 답변을 유보하세요.",
    "toolAllowlist": [],
    "maxSteps": 12,
    "resultSchema": { "type": "string" },
    "retrievalPolicy": {
      "maxRounds": 3,
      "maxQueriesPerRound": 2,
      "maxRetrievedChunks": 30,
      "maxContextTokens": 3000,
      "onInsufficient": "abstain"
    }
  }
}
```

이 예시는 노드의 일부다. 공통 `id/type/typeVersion/label/attachments/execution`도 필요하다. `indexes`는 같은 root run에서 `knowledge.build`가 만든 키워드 IndexRef의 배열이며, merge `combine:"array"`로 만들 수 있다. 선택 입력 `context`를 제외한 다른 입력은 거부한다.

|항목|운영 한도와 의미|
|---|---|
|색인|중복 없는 1~4개, root run 소유, 활성 불변 generation과 manifest hash 일치, keyword만|
|작업/지침|각 16,000 JavaScript 문자열 단위까지; 추가 문맥 JSON은 UTF-8 16 KiB까지|
|전체 모델 입력|직렬화한 요청 128 KiB까지; 초과 시 전송 전에 오류|
|모델 응답|출력 예약 4,096토큰; 수신 본문 32 KiB까지; resultJson 16,000자까지|
|단계|3~32; 계획/답변 모델 결정 1회와 실제 검색 질의 1회가 각각 1단계|
|검색 라운드|최대 4회, 회당 최대 3질의; 모델이 제안한 한 질의 묶음이 한 라운드|
|검색 청크|누적 최대 100; 질의당 최대 8; 같은 청크를 재검색해도 다시 소비|
|검색 문맥|누적 20~12,000 `o200k_base` 토큰; 질의당 최대 4,000; 고정 prefix 포함 실제 기존 tokenizer 적용|
|실행 예산|기존 root 모델 호출 수·총 토큰·노드/전체 활성 시간·자식 깊이·동시성 제한을 함께 적용|
|재시도/오류 처리|`maxAttempts=1`, `onError="fail"`; 자동 반복 호출과 오류 경로를 통한 성공 전환 금지|

검색 문맥 토큰은 **검색 시 선택한 문맥의 누적 측정값**이다. 모델에 반복 전달하는 프롬프트 전체·framing·결과 스키마의 과금 토큰이 아니다. 모델 토큰은 매번 기존 Responses 입력 count → 원자 예약 → generate → 확인된 usage 정산을 별도로 거친다. 두 숫자를 서로 더하거나 실제 비용 보장으로 표시하지 않는다. 기존 tokenizer의 전체 입력/정규식 piece 상한도 그대로 적용한다.

## 결정·검색·근거

1. 사용자 데이터의 scope가 아니라 설치/run이 발급한 principal로 모든 IndexRef 소유권·활성 세대·원본 바이트를 검사한다. 모델에 전달하는 색인 이름은 `i1..i4`다.
2. 모델 결정을 영속 예약한 뒤 토큰 확인/생성을 호출한다. 외부 검색·도구·코드 실행 권한은 제공하지 않는다. 응답은 닫힌 객체 `action,queries,resultJson,evidenceIds`만 허용한다.
3. `search`는 허용 alias와 1~8192자 검색어를 제안한다. 알 수 없는 alias·중복 질의·한도 초과는 오류다. 한 묶음을 몰래 자르지 않는다. 검색 뒤 최종 결정을 위한 1단계와 각 질의의 최소 문맥 예산을 남길 수 없으면 전송 없이 유보한다.
4. 질의를 순서대로 사전 예약하고 기존 `searchRunIndex`를 호출한다. 실제 BM25 검색·현재 ACL·UTF-8 출처 검증·문맥 tokenizer를 일반 검색과 공유한다. 지워진 문서나 다른 generation을 예전 근거로 바꾸어 반환하지 않는다.
5. 근거 ID는 index reference + candidate ID의 SHA-256이다. 검색마다 바뀌는 `source-1` 순위 이름만 안정 ID로 바꾼다. 같은 청크의 quote, 원본/추출 hash, UTF-8 위치, ACL epoch 등 나머지 값이 다르면 실패한다. 근거 목록은 중복 제거하되 반복 검색 예산은 환급하지 않는다.
6. `answer`는 현재 수집한 근거 ID 1개 이상과 사용자 `resultSchema`를 통과한 resultJson이 필요하다. `conflict`는 서로 다른 검증 근거 2개 이상, `abstain`은 근거 없는 유보다. 다른 필드 조합·unknown ID·누락 실제 response model·잘못된 JSON·스키마 위반은 성공 유보로 숨기지 않는다.

**기계적으로 확인하는 것은 원본 출처·권한·ID·응답 형식이다.** 답변이 근거에 의해 논리적으로 뒷받침되는지, 실제로 두 근거가 충돌하는지는 모델의 판단이며 이 검증만으로 보증되지 않는다. 악성 원문은 불신 데이터로 전달하지만 프롬프트 안내가 의미적 정확성을 보장하지는 않는다.

## 결과와 중단

`NodeOutput.data`는 `{status,result,citations,stopReason,usage}`다. `status`는 `answered`, `insufficient_evidence`, `conflicting_evidence` 중 하나다. 뒤의 둘은 `result:null`이며 완성된 답변인 것처럼 표시하지 않는다. sources는 선택한 citation이고 문자열 답변일 때만 text를 함께 제공한다. 유보 사유는 `model_abstained`, `max_steps`, `max_rounds`, `retrieval_budget`로 구분한다. 업무 결과가 유보여도 정상적으로 그 결과를 만든 run은 succeeded일 수 있다.

DB v12의 `agentic_sessions`는 root run + scoped node instance에 묶인다. 매 라운드/모델/질의의 operation ID·요청/확인된 결과 해시·예산·근거·revision을 같은 SQLite 트랜잭션과 CAS로 저장한다. 세션 본문은 2 MiB, 기록은 최대 32단계다. 이벤트에는 상태·한도/사용량·해시만 기록하고 원문·검색어·답변을 넣지 않는다. 원문 citation은 로컬 사설 상태에 보관하며 암호화 저장이나 원격 감사 로그라고 주장하지 않는다.

생성 응답의 사용량을 정산하고 응답 해시를 저장한 뒤 응답을 해석한다. 잘못된 응답 때문에 동일 유료 호출을 재시도하지 않는다. count 실패에는 generate가 없다. 전송 전 취소, 사용량 확인 후 취소, 전송 후 결과 불명을 구분하며 마지막 경우는 취소 요청이 겹쳐도 `attention_required`와 토큰 예약을 보존한다. 미확인 저장 결과도 reconciliation 상태다. 재시작은 진행 중 세션을 attention으로 기록할 뿐 재검색·재계획·모델 호출을 시작하지 않는다. 완료/실패/취소 세션을 같은 node identity로 재실행하는 것도 거부한다.

하위 흐름의 Agentic 세션도 root 모델 예산·RAG disclosure epoch를 공유한다. 각 scoped node에는 별도 단계 예산이 있으나 root 총 사용량을 늘리지 못한다. 내부 질의는 순차 실행하고 자식 작업을 기다리는 composite permit을 만들지 않는다.

## 권한과 공개

첫 RAG 관찰에 고정한 run 전체 disclosure epoch가 모든 모델 count/generate·근거 검색·후속 출력 공개에 적용된다. 권한/그룹/삭제 변경 시 일부 근거만 빼고 이미 만든 답변을 계속 쓰지 않고 전체 공개를 막는다. HTTP/MCP 결과·이벤트·파일·대기 문맥은 기존 공통 service의 gate를 그대로 사용한다. 본문 없는 최소 상태/사용량은 확인할 수 있다. 수동으로 복사한 문자열이나 이미 내려받은 자료의 회수까지 보장하지 않는다.

## 미지원 범위와 검증

이번 capability는 `agent.agentic_rag@1`, `agentic_rag.keyword@1`, `agentic_rag.abstain@1`뿐이다. `ask`/clarification child wait, Agentic vector/hybrid/reranker/Graph 검색, 외부 도구, 임의 색인, 이전 run 검색, 사용자 verifier/code/worker는 지원하지 않는다. 실제 추가 질문 기능을 유보 결과로 가장하지 않고 준비 검사에서 차단한다.

전용 시험은 실제 SQLite·현재 실행 파일 업로드·불변 corpus/index·BM25·UTF-8 인용·세 호스트 운영 ZIP을 사용한다. 모델/인증정보 공급자만 tests 내부 대역이며 제품 fallback은 없다. 검사 대상에는 반복 검색의 순위 변경/근거 중복·단계/회당/전체 사용량·고정 모델/허용 ID·외부 run 거부·권한 철회·취소/결과 불명·CAS/변조·재시작/no-autostart·하위 흐름을 포함한다. 실제 모델 응답 품질과 실제 Codex/Claude Code/OpenCode 앱에서의 호스트 구동은 이 ZIP/service 시험과 구분한다.

소스: `agentic/{contracts,runtime}.ts`, `state/agentic-state.ts`, `rag/search-kernel.ts`, `profiles/package-requirements.ts`; 계약과 실행 시험: `agentic-rag.test.ts`, `runner-agentic.test.ts`. 검증 명령·결과는 최종 인계 기록에 남긴다.

2026-10-28 focused 검증: 전용 Agentic/모델 연결 계약 4파일 **50시험 통과**, 실제 capability 활성화 후 공유 검색·임베딩·재순위·disclosure·하위 흐름·candidate 실행까지 **10파일 181시험 통과, skip 0**. Node 24.22.1의 `vitest run`으로 수행했다. Runner와 Runner UI `tsc --noEmit`, 의존 경계 검사도 통과했다. 새 연결 버튼의 브라우저 시각 검증과 배포 번들 smoke는 별도 통합 단계이며 이 기록에 포함하지 않는다.
