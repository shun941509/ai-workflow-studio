# 모델 입력 토큰 확인과 실행 예산

`ModelBroker`는 문자열 바이트 수로 모델 입력 토큰을 추정하지 않는다. `ModelProvider.countInputTokens`가 반환한 입력 토큰 수에 명시적인 `maxOutputTokens`를 더해 SQLite에서 원자적으로 예약한 다음 생성 요청을 보낸다. 입력 토큰 확인에 실패하면 생성 요청을 보내지 않으며 로컬 토크나이저·바이트 수로 대체하지 않는다.

## 외부 전송과 사용자 안내

OpenAI 경로에서는 생성 전에 `POST https://api.openai.com/v1/responses/input_tokens`를 호출한다. 이 요청에도 생성에 사용할 입력 본문·작업 지침·구조화 출력 JSON Schema가 공급자에게 전송된다. 카운트가 끝난 뒤 예산 부족으로 생성을 중단하더라도 카운트 요청의 외부 전송은 이미 일어났을 수 있다. 알려진 출력 한도나 모델 호출 한도가 이미 부족한 경우에는 카운트 요청도 보내지 않는다.

사용자 안내 문구: **“AI 실행 시 입력 내용과 작업 지침을 모델 서비스에 먼저 보내 입력 토큰 수를 확인합니다. 확인 실패 또는 예산 초과 시 답변 생성은 시작하지 않습니다.”** 실행 준비 검사만으로 네트워크 카운트나 모델 생성을 시작하지 않는다. 실제 API 키가 없으면 설정 필요 상태다.

이 동작은 [OpenAI 토큰 카운트 가이드](https://developers.openai.com/api/docs/guides/token-counting)와 [공식 TypeScript SDK의 count 입력 계약](https://github.com/openai/openai-node/blob/master/src/resources/responses/input-tokens.ts)을 기준으로 한다. 현재 구현은 텍스트/JSON 입력과 text.format만 지원하며, 아직 제공하지 않는 도구·멀티모달 입력을 지원한다고 표시하지 않는다. 향후 추가하는 입력 영향 필드도 카운트와 생성의 공유 직렬화에 포함해야 한다.

## 요청 고정과 직렬화

1. credential 조회를 포함한 첫 await 이전에 요청을 JSON 검증·복사하고 중첩 객체까지 freeze한다.
2. 동일 소유 요청의 canonical SHA256을 기록한다. 모델 ID, 지침, 실제 입력, 출력 설정이 이 hash에 포함된다.
3. `serializeOpenAIRequest` 한 곳에서 두 요청의 model/instructions/input/text.format을 만든다. JSON 입력의 문자열화와 JSON Schema도 동일하다.
4. count 요청에는 미지원 생성 옵션인 `max_output_tokens`와 `store`를 넣지 않는다. 생성 요청에만 `max_output_tokens`와 `store:false`를 추가한다.
5. count 뒤 같은 요청 hash를 다시 확인하고 같은 동결 요청으로 generate를 호출한다.

hash는 키/원문 대신 추적용 증거로 저장한다. HTTP Authorization은 일시적인 호출 context에만 존재한다. Count/usage 이벤트에는 원문·지침·스키마·키·공급자 오류 본문을 쓰지 않는다. 생성의 `store:false`는 count 요청의 데이터 보존 정책을 대신 지정하는 옵션이 아니다.

## 카운트·예약·정산 상태

`model.count_requested`는 countId/nodeId/requestHash/maxOutputTokens를 기록한다. count 성공은 `model.counted`, 실패는 고정 오류 코드만 가진 `model.count_failed`로 기록한다. 유효한 count는 0 이상의 safe integer이며 입력+최대출력 합도 safe integer여야 한다. 잘못된 JSON·중복 키·과대 응답·음수·소수·문자열 count를 거절한다.

카운트 요청은 답변 생성 횟수 `modelCalls`를 증가시키지 않는다. 생성의 원자 예약이 성공할 때 증가한다. 두 병렬 작업이 각각 count를 마쳤더라도 남은 토큰을 동시에 사용할 수 없다. 먼저 예약한 작업을 반영한 현재 잔여 예산을 다음 예약이 다시 검사한다. count 이후 취소·예산 부족이면 생성하지 않는다.

`model.reserved`는 실제 inputTokens+maxOutputTokens와 countId/requestHash를 묶는다. 생성 결과의 input/output/total은 각각 0 이상의 safe integer이며 input+output=total이어야 한다.

| 상황 | 처리 |
| --- | --- |
| 생성 전 확정 실패 | 예약을 0 사용량으로 정산. 실제 생성 재시도는 기존 명시 정책에 따름 |
| count 실패·거부·취소 | generate 없음, 생성 예약 없음. count 자체는 자동 재시도하지 않음 |
| 정상 사용량 | 실제 total 정산, 미사용 예약 해제 |
| 실제 input이 count보다 작음 | 실제 total 정산, 차이를 `model.usage_mismatch`에 기록 |
| 실제 input이 count보다 큼 | 실제 total 정산 후 BUDGET_EXCEEDED로 후속 작업 차단 |
| 실제 total이 예약 초과 또는 output이 출력 한도 초과 | 실제 total을 누락 없이 정산하고 mismatch 기록 후 차단 |
| 생성 결과 불명·사용량 누락·내부 불일치 | 예약 유지, attention_required, 후속 작업/자동 재전송 금지 |

정산과 usage/mismatch 이벤트는 같은 SQLite 트랜잭션이다. 이미 정산한 예약은 다시 정산하지 않는다. 공급자 거부·미완성 응답도 확정된 유효 사용량이 있으면 과금 가능한 사용량을 버리지 않고 기록한다. 완성된 텍스트를 받았더라도 사용량을 확정하지 못하면 성공으로 공개하지 않는다.

## 보장 범위와 검증

입력 카운트는 그 시점의 공급자 요청 계약에 대한 결과다. 모델 alias의 변경, 공급자의 카운트/사용량 차이, 별도 도구 비용, 캐시/추론/가격 정책 등으로 금전 비용 전체를 보장하는 기능은 아니다. 이미 발생한 실제 사용량을 사후 취소하거나 환급한다고 표시하지 않는다. 운영 환경에는 공급자 계정의 별도 지출 제한도 필요하다.

RAG의 고정 `o200k_base` 문맥 카운트는 검색 문맥 선택용이다. 모델의 지침·구조화 출력·전체 입력 framing을 포함하는 위 원격 카운트와 서로 대체하지 않는다.

검증은 실제 SQLite/Runner/ZIP 흐름과 테스트 전용 공급자·HTTP 경계 대역을 사용한다. 실제 API 키 생성·확인이나 라이브 모델 요청은 수행하지 않았다. `tests/contracts/model-count-broker.test.ts`, `tests/contracts/provider-budget.test.ts`, `tests/integration/runner-provider.test.ts`가 요청 고정·동일 wire 입력·취소·카운트 실패·유효 정수·예산 경합·실제 사용량 초과·불명 사용량 보존을 검사한다.

2026-10-28 Node24.22.1에서 `vitest run tests/integration tests/contracts/provider-budget.test.ts tests/contracts/model-count-broker.test.ts`는 15개 파일 216개 시험이 통과했다. Runner 및 tooling의 TypeScript 검사도 통과했다. API 계약은 공식 문서/SDK로 확인했으며, 실제 계정·모델의 네트워크 호환성은 아직 검증하지 않았다.
