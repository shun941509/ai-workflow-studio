# 제한된 후보 트리 탐색 계약

현재 검증한 실행 범위는 `candidate_search.tree@1`과 등록 검증기 `verifier.json-schema-v1@1`이다. graph, 패키지 생성 흐름, 임의 verifier, Worker 실행은 지원하지 않는다. 편집기 블록 목록에는 아직 추가하지 않는다. 이 제한 모드의 검증을 31개 전체 블록·모든 모드의 지원으로 확대하지 않는다.

실행 구현은 `execution/candidate-search.ts`, SQLite 상태는 `state/candidate-search-state.ts`에 있다. RunStore migration 8은 기존 실행 자료를 보존하며 새 후보 상태 테이블을 추가한다. 사용자 입력·검토를 기다리는 하위 흐름은 기존 실행기 제한대로 계속 차단한다.

## 입력·생성 흐름

`goal`은 `{task: string, acceptanceSchema: UserSchema}`만 허용한다. task는 비어 있지 않은 최대 20,000자 작업 설명이고 acceptanceSchema는 공통 `validateJsonValue`가 허용하는 제한된 JSON Schema이다. 외부 참조·재귀·정규식·과도한 복잡도는 생성 호출 전에 거절한다. `initialCandidates`는 선택적인 JSON 배열이며 생략은 빈 배열이다. 후보 하나는 직렬화 UTF-8 64 KiB, 모든 후보 데이터의 합은 2 MiB 이하이다.

생성 흐름은 `generatorFlowRef.kind=local`로 고정한다. 다음 입력을 전달한다.

```json
{
  "goal": {"task": "완성된 항목 찾기", "acceptanceSchema": {"type":"object","properties":{"ready":{"const":true}},"required":["ready"]}},
  "parent": {"id":"candidate_000001","value":{"ready":false},"depth":0},
  "depth": 1,
  "remaining": {"candidates":7,"verifications":7}
}
```

초기 후보가 없으면 parent=null인 가상 루트에서 depth=0 후보를 한 번 생성한다. 반환 데이터는 정확히 `{candidates: JSON[]}`이다. 추가 속성·누락·목록이 아닌 값·남은 후보 수를 넘은 반환을 거절하며 자동으로 잘라 성공 처리하지 않는다. 생성 흐름 자체의 input/output schema도 기존 ChildScope 실행 규칙으로 검사한다. 빈 후보 목록은 정상적인 가지 종료다.

## 탐색·선정·한도

초기 후보의 깊이는 0이다. 후보 ID는 수용 순서에 따른 6자리 번호이고, 부모 ID와 배열 순서를 보존한다. 같은 값을 여러 경로에서 생성해도 tree에서는 서로 다른 후보로 기록하고 각각 한도를 소비한다. graph 중복 제거로 가장하지 않는다.

알려진 후보를 BFS 순서(깊이, 수용 순서)로 검사한다. json-schema-v1은 후보가 acceptanceSchema를 만족하면 accepted=true/score=1, 아니면 false/0이다. 의미적 사실 확인이나 AI 품질 점수를 제공하지 않는다. 첫 통과 후보를 선택하므로 같은 깊이의 동점은 수용 순서다. 거절된 후보 중 가장 얕고 먼저 수용된 후보를 확장한다. 생성된 후보를 검사한 후 다음 확장으로 진행한다. 이미 알려진 더 얕은 후보는 먼저 검사한다.

`maxCandidates`는 초기 후보와 생성 후보를 합친 수, `maxVerifications`는 검증 예약 수, `maxDepth`는 허용되는 후보 깊이(포함)다. 초기 후보 수가 상한보다 많으면 실행 전에 실패한다. 탐색 깊이는 하위 호출 깊이와 별개이다. 동일 생성 흐름을 반복 호출해도 부모 scope에서 각각 호출하며 재귀 호출로 구현하지 않는다.

결과는 `{candidates,selected,stopReason,counts,verifier}`다. 후보에는 id/parentId/depth/value/verification/verificationReserved/expanded가 있다. selected는 통과한 후보 또는 null이며 counts는 candidates/verifications/generations다. 정상 종료는 accepted, exhausted, max_candidates, max_verifications, max_depth 중 하나다. 한도 종료는 후보를 찾았다는 의미가 아니며 selected=null이다. 검증할 후보가 남았을 때 검증 한도, 확장 가능한 후보가 있을 때 후보/검증 한도, 깊이 때문에 확장하지 못할 때 깊이 한도로 구분한다. 취소·실패·결과 불명은 정상 결과로 바꾸지 않는다.

## 영속성·안전 경계

모든 세션은 실제 runId와 scoped node instance에 귀속된다. 최초 요청 해시에는 config·goal·초기 후보·고정 verifier descriptor를 넣는다. 같은 ID의 다른 요청은 충돌이다. SQLite BEGIN IMMEDIATE에서 생성 전에 남은 후보 슬롯을 예약하고 검증 전에 검증 수를 소비한다. 생성 결과를 확정할 때 사용하지 않은 슬롯만 반환한다. 이벤트와 상태 변경은 같은 트랜잭션이며 상태 revision CAS로 오래된 호출을 거절한다.

생성 흐름은 기존 child scope와 부모의 모델/토큰/노드/활성시간 예산·취소·권한을 공유한다. candidate_search는 composite이므로 자식을 기다리며 전역 leaf permit을 붙잡지 않는다. 생성 호출 키는 부모 후보 ID로 고정하고, 기존 child scope는 입력 해시가 일치하는 성공 결과만 재사용한다.

완료한 탐색은 동일 요청일 때 저장된 결과만 반환한다. running·failed·cancelled·attention_required 탐색은 자동 재실행하지 않는다. 생성·검증 도중 중단된 예약도 자동 환급하지 않는다. Runner 시작 복구는 진행 중 탐색을 attention_required로 바꾸며 모델/생성 작업을 다시 보내지 않는다. 자식의 결과 불명 ModelError는 부모까지 전파한다. 등록 verifier는 코드/프로필 설치 경로와 분리된 순수 함수이며 사용자 입력으로 함수·모듈·Worker를 선택할 수 없다.

verifier의 id/version/contract hash를 resolvedPlan의 verifiedDependencies와 세션에 고정한다. 대기 응답을 소비하기 전과 탐색을 실행하기 전에 현재 descriptor와 대조하며, 변경되거나 누락되면 새 계획을 요구한다. 의미가 바뀌면 verifier ID 또는 버전을 올려야 한다. capability는 tree와 verifier를 각각 수집하므로 node 타입 하나를 지원한다는 이유로 graph나 새 verifier가 허용되지 않는다.

## 완료 증거

실제 순수 로컬 생성 흐름·SQLite·3종 운영 ZIP으로 통과/거절/빈 결과/BFS/부모·깊이/상한/단일 permit/상위 예산/취소/중단 복구를 검사한다. 계약 시험은 invalid schema·크기·CAS·중복 요청·예약의 선행 저장·완료 결과 재사용을 검사한다. 모델 결과 불명 경계 시험의 provider 대역은 tests에만 존재하며 제품에 모의 실행 옵션을 추가하지 않는다.

검증 명령은 `node tooling/run-pnpm.mjs exec vitest run tests/contracts/candidate-search.test.ts tests/integration/runner-candidate-search.test.ts`이다. Runner 및 tooling TypeScript 검사와 기존 Runner 통합 시험을 함께 수행한다. 기존 DB의 과거 실행을 새 탐색으로 재시작하거나 자동으로 예약을 환급하는 migration은 없다.

2026-10-28 검증: 후보 계약 14개·Runner 통합 25개 통과, 기존 사용자 대기 회귀 13개도 통과했다. 3종 운영 ZIP의 로컬 생성 흐름은 모델 호출 없이 실제로 실행했다. 모델 예산·불명 결과·provider 취소 시험만 tests 내부 대역을 썼으며 실제 API 호출 검증으로 세지 않는다.
