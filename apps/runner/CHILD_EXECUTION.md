# 로컬 하위 흐름 실행 계약

현재 지원은 `subworkflow + flow.local`, `loop.foreach`, `loop.until`, `parallel.all`이다. `flow.package`, `parallel.first_match`, 하위 흐름 내부 `form.request/review`는 실행 전 검사에서 거절한다. 루트의 사용자 대기는 기존 영속 대기 계약을 유지한다.

## 입력과 결과

| 블록 | 하위 흐름 입력 | 노드 출력의 data |
|---|---|---|
| subworkflow | `inputBindings.input`의 값 그대로 | 하위 output 블록의 data. 최종 NodeOutput 전체를 반환한다. |
| loop.foreach | `{item,index,context}`; index는 0부터, context 기본값 null | `{results,iterations,reason:"completed"}`; 원본 목록 순서 |
| loop.until | `{state,iteration,context}`; iteration은 1부터 | `{results,finalState,iterations,reason:"condition_met" 또는 "max_iterations"}` |
| parallel.all | `{input: branches[id],branchId:id,context}` | `{branches:[{id,status:"succeeded",result} 또는 {id,status:"failed",error}]}`; 선언 순서 |

foreach는 입력 목록을 복제하며 maxIterations를 초과하면 첫 항목 실행 전 차단한다. 빈 목록은 결과 빈 배열과 iterations=0이다. until은 body.data를 새 state로 삼은 뒤 `{state,iteration,context}`를 대상으로 조건을 검사한다. 종료 조건 불충족의 최대 반복 도달은 명시적 종료 이유로 반환한다. 병렬 입력 객체는 선언된 모든 분기 ID를 정확하게 포함해야 한다.

## 실행·저장 경계

- 모든 child scope는 하나의 root run·고정 plan·자료·모델 연결·권한·예산을 공유한다. 새 예산이나 권한을 생성하지 않는다.
- SQLite v4의 child_scopes는 root run, 부모 scope, 소유 node instance, call/분기/반복 key, flowId, 실제 깊이, 입력 hash, 상태, 결과를 보관한다. node/edge key는 `scope_uuid/localId`이므로 같은 로컬 ID가 충돌하지 않는다.
- node_claims는 루트·하위 노드 모두 원자적으로 1회 청구한다. 모델 예약은 기존 루트 트랜잭션으로 호출/토큰 한도를 공유한다. active 시간은 중첩 시간의 합이 아니라 루트 벽시계 활성 구간 1회로 계산한다.
- 병렬 pool은 maxConcurrency를 적용하고 모든 leaf 작업은 root maxConcurrentNodes 세마포어를 통과한다. 부모는 자식을 기다리는 동안 leaf 슬롯을 점유하지 않는다.
- collect는 확인된 복구 가능 데이터 오류만 실패 항목으로 수집한다. 보호 검사·권한·예산·취소·불확실한 외부 결과는 성공에 포함할 수 없다. fail_fast는 새 분기를 막고 시작된 분기의 종료를 모두 기다린다. 하나라도 외부 결과가 불확실하면 root는 attention_required이다.
- 중단 복구는 진행 중 scope를 attention_required로 바꾸며 provider 또는 child를 자동 재호출하지 않는다. 완료된 결과는 보존한다. 동일 owner/key의 다른 입력은 충돌이며, 완료 child만 저장 결과 재사용이 가능하다.
- 로컬 호출의 순환·깊이를 정적 검사와 실행 시 실제 lineage에서 다시 검사한다. child 입력과 child output schema를 각각 검사한다. 누적 child 결과는 8 MiB를 초과할 수 없다.
- 상태 API는 최근 200개의 scope 메타데이터와 childScopeCount를 반환한다. 입력/결과를 매번 로드하지 않는다. 모든 상태 변경은 기존 이벤트 API에 남는다.

검증은 tests/integration/runner-child-scopes.test.ts의 실제 SQLite·운영 ZIP·Runner 서비스 경로를 사용한다. 모델 대역은 시험 파일에만 존재하며 실제 외부 API의 성공이나 품질을 증명하지 않는다.
