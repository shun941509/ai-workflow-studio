# 현재 실행의 고정 Responses 재순위 중계

2026-10-28 구현 계약. 운영 백엔드의 선택 기능이며 편집기의 재순위 설정·연결 생성 UI는 이 범위에 포함하지 않는다. 실키·유료 API 호출·실제 검색 품질은 **unverified**다. 공급자 대역을 사용하는 시험은 실제 공급자의 가용성·모델 품질 검증이 아니다.

## 공식 근거와 모델 선택

- [GPT-5.4 Mini 모델 문서](https://developers.openai.com/api/docs/models/gpt-5.4-mini)는 `gpt-5.4-mini-2026-03-17` snapshot, Responses, Structured Outputs 및 reasoning effort `none` 지원을 명시한다. 이 snapshot만 이번 중계에 허용한다.
- [지원 종료 안내](https://developers.openai.com/api/docs/deprecations)에 GPT-4.1 mini가 2027-01-14 종료 예정으로 기재되어 새 고정 계약에 채택하지 않았다.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)의 닫힌 객체·필수 속성·enum·정수 범위와 거절 응답 구분을 사용한다. 형식 준수가 의미적 정확성이나 후보별 점수의 품질을 보장하지는 않는다.
- [입력 토큰 확인](https://developers.openai.com/api/docs/guides/token-counting)의 `POST /v1/responses/input_tokens` 뒤에 `POST /v1/responses`를 호출한다. 별도 OpenAI `/rerank` API를 가정하거나 호출하지 않는다.
- [OpenAI Retrieval의 ranker 옵션](https://developers.openai.com/api/docs/guides/retrieval)은 OpenAI vector store 검색에 속한다. 현재 run의 로컬 후보를 재순위하는 이 구현과 같다고 취급하지 않으며 원문을 OpenAI vector store에 업로드하지 않는다.

Snapshot 이름, 요청·지침·스키마·결정 규칙을 고정한다. 공급자 내부 가중치의 영구 불변성, 계정별 모델 접근 권한, 서비스 가용성, 비용 상한을 보증하지 않는다.

## 프로필·불변 실행 계획

`kind:'reranker'`는 `chat`·`embedding`과 별개의 역할이다. 같은 모델 ID의 기존 chat 연결을 자동으로 승격하지 않는다. API 프로필 생성은 `name,kind,model,apiKey`만 받으며 endpoint·prompt·출력 상한·reasoning override를 거부한다. 키는 기존 Windows DPAPI에 저장하고 ZIP·계획·이벤트·연결 조회에 넣지 않는다.

```json
{
  "modelProfiles": { "rank": { "kind": "reranker", "requiredFeatures": ["rerank"] } },
  "config": {
    "mode": "keyword",
    "topK": 3,
    "candidateLimit": 10,
    "maxContextTokens": 2000,
    "reranker": { "modelProfile": "rank", "timeoutMs": 30000, "onFailure": "fail" }
  }
}
```

Resolved plan은 profile ID/alias/kind/provider/model, `openai-responses-rerank-v1` 전체 계약 및 그 SHA-256을 고정한다. 시작·대기 재개·전송 직전 현재 연결과 비교한다. snapshot 교체는 새 계약과 새 실행이며, 오래된 계획을 묵시적으로 업그레이드하지 않는다. 요구 capability는 `retrieval.rerank@1`, `reranker.openai_responses_v1@1`이다.

상태 DB v10은 profiles 테이블의 CHECK를 원자적으로 넓힌다. v9의 chat/embedding 및 더 오래된 legacy chat 기록, profile ID, DPAPI 참조는 그대로 복사한다. 모델명으로 종류를 추론하지 않는다. 미래 DB 버전은 열기 전에 거부한다.

## 후보와 점수 계약

1. 현재 run의 관리 원문·불변 corpus/index를 기존 경로로 검증한다.
2. 현재 subject/group/ACL/tombstone을 적용해 keyword/vector 검색을 수행한다. hybrid는 기존 RRF를 사용한다.
3. **candidateLimit → 재순위 → topK → 문맥 예산** 순서를 지킨다. 재순위 지정 시 세 모드 모두 `1 ≤ topK ≤ candidateLimit ≤ 20`을 요구한다. 후보를 이미 topK로 잘라 놓고 재순위하는 구현은 허용하지 않는다.
4. query+후보 원문 합계는 UTF-8 65,536바이트까지다. 한도를 넘으면 전송 전에 실패하며 원문을 자르거나 일부 후보를 몰래 빼지 않는다. 빈 검색 결과는 `skipped_empty`로 기록하고 모델을 호출하지 않는다.
5. 내부 candidateId는 원문 generation·청크와 묶인다. 외부에는 candidateId 정렬 순서로 발급한 `c1..c20`과 원문만 보낸다. 내부 run/문서 식별자·기존 순위·원시 점수는 보내지 않는다. query와 후보 내용은 명령이 아닌 불신 데이터다. 도구 호출·검색·답변 생성은 요청하지 않는다.
6. 응답은 `{"items":[{"id":"c1","score":0}]}` 형태다. 모든 후보가 정확히 한 번 필요하다. score는 0..100 정수의 관련성 판단이며 확률이 아니다. 초과·누락·중복·알 수 없는 ID, 추가 속성, 잘못된 JSON, 다른/없는 실제 response model을 거부한다.
7. 검증 후 내부 ID로 복원하고 순수 `applyRerank`를 적용한다. score 내림차순, 동점은 내부 candidateId 코드 단위 순서다. keyword/vector 원시 점수와 RRF·reranker 점수를 서로 더하지 않는다. `stages.reranker`에 score/fingerprint를 추가한다.

## 전송 권한 경계

토큰 확인 요청도 검색어와 후보 원문을 외부 OpenAI에 전송한다. 생성 요청에서 같은 내용을 한 번 더 전송한다. 요청은 await 전에 복제·동결하고 해시를 비교한다. `reasoning.effort:'none'`, 닫힌 response schema는 count/generate에 동일하게 직렬화한다. `max_output_tokens:4096`, `store:false`는 생성 요청에만 붙인다.

현재 SQLite 권한 epoch는 subject의 현재 그룹과 문서 ACL/tombstone을 함께 버전 관리한다. 검색에서 검증한 후보 inventory의 epoch를 유지하고, DPAPI await 이후 count 직전과 count 완료 이후 generate 직전 **동기** callback으로 현재 epoch를 다시 확인한다. 이 사이 변경은 관련 없는 권한 변경이어도 보수적으로 전체 중단하며, 동결한 요청에서 후보만 조용히 삭제하지 않는다. 모델 응답 뒤와 인용 생성 뒤 반환 직전에도 확인한다. callback은 서비스 코드만 제공하고 workflow나 모델 응답이 이를 설정할 수 없다.

전송 이후 발생한 철회로 이미 보낸 원문을 공급자에서 회수할 수는 없다. 검사 시점 권한과 이후 결과 공개 차단을 제공하며 외부 전송 전체에 걸친 분산 트랜잭션을 주장하지 않는다.

**후속 AI 경계 보완:** Binding은 여전히 문자열/값만 전달하며 필드별 provenance는 없다. 후속 구현인 [실행 전체 공개 권한 기준](run-disclosure.md)은 첫 RAG 관찰 이후 같은 root run의 모든 일반 AI·Agent·모델 평가·임베딩 전송과 결과/파일/대기 공개를 보수적으로 재검사한다. 권한 변경 시 무관한 값도 같은 실행이면 차단한다. 사용자가 다른 실행에 수동 복사한 값이나 이미 반환·다운로드·외부 전송한 데이터를 회수한다고 주장하지 않는다.

## 예산·취소·실패·대체 결과

- 기존 Responses 입력 실측 → 원자적 `inputTokens + 4096` 예약 → 생성 → 확인된 실제 usage 정산을 그대로 사용한다. 임베딩·대화·재순위는 같은 run 모델 호출/토큰 한도를 공유한다. count 실패에 generate는 없다.
- 입력/출력 사용량이 예약보다 많으면 실제량을 기록하고 후속 작업을 중단한다. usage 누락/불완전, 전송 후 연결 유실, 생성 중 타임아웃은 예약을 유지한다. 재시작으로 이 예약을 환급하거나 자동 재전송하지 않는다.
- reranker timeout은 node/run 취소 신호와 결합하며 시간·노드·호출·토큰 제한을 확대하지 않는다. 생성 전에 권한 검사 실패가 확인되면 그 생성 예약은 0으로 정산한다. 호출 시도 수를 되돌려 재시도 한도를 늘리지 않는다.
- 기본 `onFailure:'fail'`이다. `use_original`은 오직 생성 미시작이 확정된 `RATE_LIMITED`, `MODEL_COUNT_UNAVAILABLE`, 또는 유효한 완료 usage가 있는 `MODEL_REFUSAL`에만 적용한다. 대체 직전에도 동일한 권한 검사를 한다.
- 인증/프로필 오류, malformed count, response identity·schema·candidate ID 오류, 권한/무결성 오류, 취소/시간/예산, unknown outcome/usage는 fallback 대상이 아니다. 실패한 provider raw body는 출력·이벤트에 넣지 않는다.
- fallback 결과는 `data.rerank.status:'fallback'`과 failureCode를 반환하며 원래 검색 순위라는 사실을 숨기지 않는다. 원래 순위의 후보에는 reranker 점수가 생기지 않는다.
- 외부 임베딩/재순위가 포함된 완료 검색은 keyword 모드라도 같은 operationId로 자동 replay할 수 없다. 실패 intent 역시 기존 durable ledger가 재실행을 막는다. 같은 start request는 원래 run을 반환한다.

## 순위 기록과 검증

`rag.rerank` 이벤트는 profile fingerprint, candidate inventory hash, 상태/실패 코드, 내부 ID별 before/after rank와 검증된 점수를 기록한다. 원문·query·API 키·공급자 raw body는 이벤트에 넣지 않는다. 실제 검색 결과는 기존 후보·인용·문맥과 별도 `data.rerank` 메타데이터를 담는다. rank 이벤트 자체는 결과 공개 승인이 아니며 최종 인용 검사 후에도 실패할 수 있다.

검증은 고정 공급자 대역과 실제 SQLite/관리 파일 바이트/loopback HTTP/MCP를 사용한다. 3종 운영 ZIP, candidateLimit→topK 순서, raw/RRF/reranker 분리, 모델/ID 변조, DPAPI 이후·count 이후·generate 이후 tombstone, 문서 ACL이 그대로인 그룹 탈퇴, budget/unknown/cancel, fallback no-retry, durable restart, profile pin 변경, v9 migration 및 실제 Responses 직렬화 경계를 다룬다. 실제 모델 품질·가용성 확인은 별도 외부 검증 전까지 unverified로 남는다.

2026-10-28 로컬 검증 기록:

- `tests/contracts/reranker.test.ts`: 14개 통과.
- `tests/integration/runner-reranker.test.ts`: 30개 통과. 전송 전 취소(예약0), 완료 usage 확인 후 취소(실측 정산), 전송 후 unknown 취소(예약 유지·attention_required)를 구분하고 재시작 자동 호출0을 검증한다.
- 위 두 파일과 기존 provider-budget/rag-embeddings/runner-rag-embeddings/runner-rag/package-model-requirements/workflow-core를 함께 실행한 최종 focused 검증: **8파일 146개 통과**.
- Runner 및 workflow-core TypeScript 검사 통과. 마지막 전체 tooling TypeScript 검사는 병행 카탈로그 작업 파일의 타입 오류가 남아 통합 담당자에게 전달했다. 이 결과를 전체 저장소 타입 검사 통과로 세지 않는다.
- 새로운 실제 OpenAI 요청은0회다. Windows DPAPI 실키·고정 snapshot의 실제 응답·검색 품질은 미검증이다.
