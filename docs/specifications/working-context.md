# R-07 업무 문맥 구성

상태: 설계 검토 중. `selectedContext`만으로 문맥이 실제 전달되었다고 판정하지 않는다. 아래 계약을 구현·검증한 뒤 지원 목록과 운영 capability를 함께 활성화한다.

## 범위

A-01은 새 블록 종류 대신 기존 `merge`와 AI 작업/단일 작업 에이전트의 명시적 자료 첨부를 조합한다. 사용자가 선택한 한 Card/Role/Task를 대상으로 하며, 다른 Task를 추측하거나 계정 자료 전체를 검색하지 않는다. 기존 31개 종류와 공식 120+120 목록을 유지한다.

- 업무 정의에는 공유 가능한 목적·책임·절차·자료의 고정 참조만 둔다.
- 이번 실행의 원문과 요청은 기존 workflow 입력/Binding으로 전달한다.
- 모델 연결과 비밀정보는 개인 Runner 설정에 남긴다.
- 문서의 `reference`는 낮은 신뢰 데이터다. Skill/작업 지침도 도구 실행 권한을 만들지 않는다.

## 작성 규격 제안

`workDefinition.harness.workingContext`를 선택 사항으로 추가한다. 선언하면 별도 `workflow.working_context@1` capability가 필요하며, 기존 `workflow.work_definition@1`의 메타데이터 보존과 구별한다.

```json
{
  "version": 1,
  "maxBytes": 262144,
  "bindings": [{ "nodeId": "draft", "contextNodeId": "context_draft" }]
}
```

각 루트 perform 노드 앞에 `merge(object, namespace)`를 넣는다. `businessTask`에는 고정 Card/Role/Task 식별자·목적·책임·전체 기준 ID를 literal로 넣고, `request`에는 원래 context Binding을 보존한다. AI/Agent의 context는 이 merge의 `/data`만 참조한다. 작업 입력(content/task)과 기존 작업 지침은 그대로 둔다. 자료 본문은 기존 명시적 첨부 경로를 사용하여 merge에 복제하지 않는다.

초기 preset은 루트 AI 또는 `agent.task` 단일 단계만 지원한다. 수행 블록마다 정확히 하나의 문맥 구성 노드를 지정하고, 기존 단일 선행 연결 사이에 삽입한다. 다중 입력·child·Agentic 등의 복잡한 경우를 조용히 다시 연결하지 않는다. 선택된 Task 자산/Skill과 첨부의 별칭·역할이 정확히 일치해야 한다. 필수 자료 미선택, 잘못된 역할, 오래된 업무 메타데이터, 중복 매핑은 실행 준비 전에 거부한다.

## 실행 증거 제안

모델 callback의 최종 요청을 고정한 뒤, 공급자 계수 호출 전에 실제 요청 hash와 문맥 manifest를 기록한다. 원본 해시가 검증된 자료만 출처가 된다. manifest에는 run/plan/업무 정의 revision, 노드 instance/attempt, 문맥과 요청 hash, 바이트 수·상한, 선택 자료의 고정 ID/revision/hash/용도·선택 이유, 미선택 자료의 제외 이유를 담는다. 원문·자격증명·모델 응답은 이 manifest에 복사하지 않는다.

`prepared`는 실제 공급자 사용 성공을 뜻하지 않는다. 동일 requestHash의 계수·예약·정산 기록으로 전송 시도와 결과를 구분한다. 실제 모델 의미 이해나 답변 품질은 내부 대역 시험으로 증명하지 않는다. 실패/취소/불명 결과에서 실행이나 과금 상태를 성공으로 바꾸지 않는다.

문맥 선택 검사는 명시적 자산 첨부와 생성된 업무 문맥 경로를 검증한다. 전체 워크플로에 대한 정보 흐름 추적이나 악성 문서의 의미적 격리를 보장한다고 표현하지 않는다. 기존 run 전체 RAG 공개 권한 검사도 그대로 적용한다.

## 완료 기준

- Schema→타입, core 의미 검사, preset의 원본 불변·연결 보존·중복 방지 검증.
- 3종 ZIP의 선언/고정 자료/런타임 capability 왕복과 오래된 Runner 거절.
- 실제 SQLite와 내부 provider 경계에서 요청 바이트·해시·선택/제외 자료·역할 검증.
- 최대 크기 초과·pin/선택 불일치·자료 누락 시 계수/생성 호출 0회.
- 대기/재시작 후 기존 요청·manifest 보존, 불명 호출 재전송 금지.
- 실제 모델/호스트 사용은 별도 unverified로 유지하고 회의 예제에 적용한다.

## R07 Runner 구현 계약

실제 경로는 `context/working-context.ts` → `ModelBroker.invoke` → `state/working-context.ts`다. root AI 또는 단일 task Agent에 opt-in한 경우에만 적용한다. 기존 모델 요청의 지침·content 구조와 실제 첨부 역할을 재사용하며, `businessTask`는 JSON 문맥 데이터다. 작업 지침 문자열을 자동 수정하지 않으므로 기존 `context.sourceText` 같은 작성자 경로는 preset 적용 후 `context.request.sourceText`에 맞춰 별도로 검토해야 한다.

`VerifiedMaterials`가 검증한 자료의 본문 없는 목록을 새 실행의 `plan.workingContextAssets`에 고정한다. 목록은 task에 선언한 자산/Skill 전체의 alias, 원본 ID/revision/descriptor hash, 용도·목적·필수/선택 여부와 파일별 원본 hash/bytes/전송·제외 이유다. Skill의 SKILL.md 지침과 실제 텍스트 references/assets만 전송 출처로 표시한다. 별도 라이선스 파일, 바이너리 메타데이터, scripts 및 미선택 파일은 제외 이유를 보존한다. entrypoint 자체가 이용 조건 파일인 특수 자료는 실제 entrypoint 소비가 우선하며, 라이선스라는 이름만으로 그 파일을 전송하지 않았다고 표시하지 않는다.

공급자 중계기는 최종 요청을 한 번 소유·복제·동결한 뒤 그 동일 객체를 count와 generate에 전달한다. `maxBytes`는 이 최종 ModelRequest 전체를 canonical JSON으로 표현한 UTF-8 바이트 수다. 모델명·출력 schema·지침·원문·첨부가 모두 포함된다. JSON 객체 키 정렬은 바이트 수에 영향을 주지 않는다. 상한 초과는 키 조회와 원격 계수 이전에 거절한다. manifest 자체도 256 KiB 이하이며 본문·키·원래 모델 응답은 저장하지 않는다.

SQLite migration 14의 `working_contexts`는 실제 run/nodeInstance/attempt에 귀속된다. 준비 시 고정 plan hash, 업무 정의 hash, 실제 성공한 문맥 merge 결과 hash, 검증된 자료 pins, 공급자·모델, request hash/bytes를 확인한다. 같은 attempt의 동일 준비는 멱등이고 다른 hash는 충돌이다. 준비·이벤트는 원자 저장하며 기존 count 요청/확인·reservation 트랜잭션 안에서 같은 request hash와 문맥 ID를 연결한다.

|필드|가능한 기록|해석|
|---|---|---|
|준비 레코드 존재|prepared|실제 요청 바이트와 출처를 고정함. 공급자 전송 성공 아님|
|countState|not_started, invocation_intent, confirmed, failed, unknown|원격 입력 계수 경계의 시도·확인 상태. 계수도 원문을 외부로 보냄|
|generationState|not_started, invocation_intent, response_confirmed, failed_confirmed, unknown|생성 경계의 시도·반환/사용량 기록. 결과 schema 통과나 업무 수락과 별개|

`invocation_intent`는 공급자 호출 직전의 영속 의도이며 실제 외부 서비스가 수락했다는 독립 증거가 아니다. `response_confirmed` 역시 현재 등록된 provider 경계가 응답·유효 사용량을 반환한 기록이다. 내부 대역 검증을 실제 OpenAI 성공으로 승격하지 않는다. 원장 생성 의도를 저장하지 못하면 생성 요청을 보내지 않는다. 공급자 응답 후 원장 확정에 실패하면 `attention_required`/unknown을 유지하고 자동 재호출하지 않는다. 이미 확인된 사용량을 미사용으로 환급하지 않는다.

재시작은 진행 중 count/generation 의도만 unknown으로 낮추고 `context.recovered`를 같은 복구 트랜잭션에 남긴다. manifest로 모델 요청을 복원하거나 재전송하지 않는다. 읽을 때도 closed runtime schema와 고정 plan/자료 pins/실제 attempt/merge 결과, 별도 count·reservation·generation 이벤트를 교차 확인한다. `settled` 예약만으로 응답 확인을 주장하지 않는다. 환급된 미시작 예약도 settled일 수 있기 때문이다.

status/results 응답에 `workingContexts`와 전체 `workingContextCount`가 추가된다. 반환 목록은 최대 100개 및 합계 512 KiB로 제한되고 전체 수는 유지된다. 실행의 현재 RAG 공개 권한을 잃으면 status는 빈 배열/0, results는 기존 403/409 정책대로 차단한다. 공개 클라우드나 ZIP에 개인 원장을 넣지 않는다. UI의 이전 metadata 캐시도 같은 공개 권한 정책으로 제거해야 한다.

검증은 `tests/integration/runner-working-context.test.ts`의 실제 ZIP/SQLite/HTTP 경로에서 수행한다. 3개 호스트 아카이브 보존, 준비 검사 중 호출 0회, 선택 자산 전달/미선택 제외, 지침과 참고 문서 구분, Skill 파일 출처, 크기 초과의 키 접근·호출 0회, 원장 변조·부분 실패·취소·재시작·권한철회를 검사한다. 실제 외부 API·호스트 실행·답변 품질은 별도 unverified다. 이 구현은 전체 워크플로의 간접 정보 흐름 차단을 보증하지 않는다.
