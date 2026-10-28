# 하위 흐름의 사용자 대기와 안전한 재개 — R10

상태: **R10-A 설계·독립 기반 준비, 실행 통합 미구현**. 이 문서와 pending 시험은 capability나 지원 완료 증거가 아니다. 기존 `CHILD_WAIT_UNSUPPORTED` 차단을 유지한다. 서비스/저장소/UI는 R03·R07 및 통합 체크포인트 소유권 인계 뒤 변경한다.

## 첫 구현 범위

R10-A는 루트에서 단일 또는 중첩 `subworkflow`로 호출한 고정 local 흐름에서 `form.request`, `review`, 사용자의 파일 선택이 필요한 `file_input`을 지원한다. root의 기존 대기와 결과·제어 포트를 유지한다. 같은 run 안에서 scope를 구분하며 새 run을 생성하지 않는다.

R10-B의 `parallel.all` 일부 대기, loop/team/candidate generator의 대기, Agentic 추가 질문은 이번 첫 slice의 완료 항목이 아니다. 처음에는 대기가 있는 흐름까지 이르는 호출 경로에 subworkflow 이외의 실행 주체가 있으면 준비 검사에서 거절한다. 직접 자식뿐 아니라 `parallel → subworkflow → 기다리는 흐름`처럼 간접 경로도 검사한다. 기존에 사용자 대기가 없는 병렬/반복/팀/후보 탐색은 유지한다. 추후 각 continuation 계약과 검증을 마친 범위만 차단을 해제한다.

정적 파일 Binding이 비어 있거나 실행 값이 빈 배열이 될 수 있다면 대기 가능 경로로 취급한다. 값이 빈 배열일 때만 실제 선택 대기를 만들고, 잘못된 FileRef/잘못된 입력 형식은 기존 실패 처리로 남긴다. 모델이 반환한 파일 경로를 사용자 선택으로 취급하지 않는다.

## 기존 코드의 공백

- 서비스 준비 검사와 child executor가 사용자 대기를 명시적으로 차단한다.
- child executor는 `Promise<NodeOutput>` 또는 예외만 반환한다. 기존 scope가 성공하지 않았으면 `CHILD_NOT_REPLAYABLE`이다.
- `createWait`는 root run 전체를 waiting으로 바꾸고 활성 시간을 멈춘다. 병렬 일부 대기에 사용할 수 없다.
- 응답 소비/접수/파일 업로드는 run 상태 waiting을 전제로 하며, 재개와 파일 설정 조회는 root 노드에서만 찾는다.
- 현재 root는 저장된 성공 결과를 재사용하지만 child executor는 outputs를 빈 map으로 시작한다.
- 현재 runId별 resumptions map은 작업 중 들어온 다른 wake를 버릴 수 있으므로 다중 대기에서는 알림 합치기와 drain이 필요하다.
- 부모의 timeout AbortSignal은 자식 호출 전체에 걸쳐 한 번 생성된다. 인간 대기를 그대로 await하면 timeout이 지나고, 재개할 때 새 timeout으로 바꾸면 한도가 초기화된다.

## 불변식

1. wait는 `runId + nodeInstanceId + scopeId + localNodeId + planHash`에 묶는다. 기존 DB의 node_instance_id와 scopedKey를 권위 있는 원본으로 검증하며 HTTP 입력이 scope를 정하지 않는다.
2. `review`는 업무 내용의 수락/거절이다. R11의 파일/서비스 변경 권한 승인이 아니며 승인 토큰이나 EffectRef를 발행하지 않는다.
3. 하위 review는 R03의 명시적 root 완료 근거로 자동 승격되지 않는다. 최종 업무 판정이 필요하면 root review/evaluate 등 기존 완료 계약을 따른다.
4. 대기는 성공 결과도 실패도 아니다. `ScopeProgress = completed(output) | suspended(waitIds)`를 사용하고, 보호 실패/결과 불명은 기존 오류 경계를 유지한다.
5. 부모 노드의 제어 edge와 결과는 자식 완료 전 확정하지 않는다. A에서 부모는 waiting_children, 기다리는 자식은 waiting이며 root는 안전한 idle 체크포인트 후 waiting이 된다.
6. 완료된 모델/파일/메모리 노드는 다시 실행하지 않는다. 재개는 기존 scope/node/attempt/operation identity를 유지한다.
7. 성공 자식은 기존 결과를 재사용한다. waiting 체크포인트와 일치하는 자식만 재개하며 running/failed/blocked/cancelled/attention_required를 일반 재실행 대상으로 바꾸지 않는다.
8. 입력/모델/자료/도구/색인/검증기/계획 해시와 현재 RAG 권한을 기존 재개 정책대로 다시 확인한다. plan 변경 후 과거 승인을 재사용하지 않는다.
9. 응답은 requestId+정확한 본문 해시로 한 번만 접수한다. 같은 ID의 다른 응답, 서로 다른 ID의 경합, 만료/취소 뒤의 응답은 거절한다.
10. 응답 소비, 대기 노드 결과, 선택된 edge, 부모 wake 체크포인트는 한 트랜잭션이다. 응답을 소비했지만 부모가 다시 깨어날 근거가 없는 상태를 만들지 않는다.
11. root의 노드/모델/토큰/활성 시간/자식 깊이 예산을 유지한다. 재개가 새로운 예산을 만들지 않는다. 기존 node_claims의 동일 인스턴스 재계수 방지를 사용한다.
12. wait TTL은 UTC 절대 만료 시각이며 실제 대기 시간 동안 계속 흐른다. 활성 실행 시간과 구분한다.
13. 부모 timeout은 누적 활성 시간 기준으로 남은 시간을 계산한다. 인간 대기로 멈춘 시간을 timeout에 넣지 않으며 재개 시 전체 timeout을 다시 주지 않는다.
14. root 활성 시간은 실제 활동이 있는 시간의 합집합이다. 이후 B에서 분기마다 같은 root 시간을 더해 중복 계수하지 않는다.
15. 실제 외부 호출 중 프로세스가 중단되면 결과 불명 예약을 보존하고 attention_required다. 사용자 응답이 있다는 이유로 중단된 호출을 다시 보내지 않는다.
16. 새로고침/Runner 재시작은 질문에 자동 응답하거나 검토를 자동 수락하지 않는다. 이미 저장한 응답의 안전한 continuation만 재개할 수 있다.
17. 취소/만료/보호 실패는 모든 관련 대기와 자식에 전파한다. 활동 중 호출을 drain한 뒤 결과 불명이 있으면 단순 cancelled/failed로 덮지 않는다.
18. 파일 업로드는 기존 쿠키+CSRF 사용자 경로에서만 받는다. run·wait별 소유권과 고정 노드의 MIME/개수/바이트 제한을 검사한다. 다른 wait의 파일이나 다른 run의 FileRef를 섞지 않는다.
19. 상태/대기 문맥/이벤트/파일 공개는 run 전체 disclosure gate를 유지한다. 하위 scope로 이동하여 RAG 권한 검사를 우회하지 않는다.
20. 다중 대기에 대비해 저장 개수·문맥/응답 바이트 한도를 정하고 초과 시 명시적 오류를 낸다. 첫 A는 순차 대기지만 B 전에는 합계 한도까지 갖춰야 한다. 원문을 조용히 잘라 의미를 바꾸지 않는다.

## 실행 프레임과 재개 조정자

공통 Workflow/Node config schema는 바꾸지 않는다. runtime 전용 프레임은 owner node instance, 기존 attemptId, planHash, input hash, revision, 누적 activeMs, continuation 상태를 저장한다. root/child의 기존 PK와 stable scope_key(`call`)를 유지한다.

DB 확장은 통합 담당자와 조율한다. R07 문맥 원장 migration14가 예정되어 있으므로 **R10은 migration15 후보**이며 실제 인계 시 현재 버전을 확인한다. 이전 root 대기 데이터는 main scope로 해석할 수 있어야 하고 미래 DB 버전은 기존처럼 fail-closed한다.

실행기는 실패 예외를 유지하면서 대기 상태만 별도 반환한다. 대기 노드를 실행할 때 실제 wait와 프레임을 먼저 저장하고 부모까지 suspended를 반환한다. 살아 있는 Promise를 인간 응답까지 붙잡아 두는 방식으로 durable continuation을 대체하지 않는다.

`RunWakeCoordinator`는 root run당 하나의 drain만 실행한다. drain 진행 중 들어온 wake는 dirty/revision에 반영하고, 종료 전에 다시 처리한다. 정지 여부 판단과 coordinator 등록 제거 사이에 새 wake를 잃는 틈이 없어야 한다. 이는 DB 체크포인트의 대체가 아니며 메모리 조정자 재시작 시 미소비 응답/ready continuation은 DB에서 다시 읽는다.

### 재시작 지점별 정책

|중단 지점|동작|
|---|---|
|사용자 응답 전 안전 idle|같은 wait·만료 시각·scope·기존 결과를 복원, 호출 없음|
|응답 저장 후 미소비|검증 후 같은 응답을 한 번 소비|
|응답 소비 후 후속 실제 작업 시작 전|원자적으로 저장한 safe continuation만 진행|
|후속 작업의 실제 호출 의도/attempt를 시작한 뒤 완료 기록 전|불명 상태를 보존, 자동 재전송 금지|
|완료한 자식 뒤 부모 wake 전|저장된 자식 결과로 부모 continuation 재구성, 자식 호출 없음|

성공했다는 추측이나 예약 잔액이 0이라는 이유만으로 안전 체크포인트를 만들어서는 안 된다. 실제 호출 의도/완료/대기 전이의 기록이 기준이다.

## API·화면과 capability

기존 `POST /api/runs/:runId/waits/:waitId/responses`와 파일 업로드 경로를 유지한다. 사용자가 scopeId/flowId/actor/승인권을 body에 추가할 수 없다. 서버가 정확한 wait instance를 해석한다.

status의 wait DTO에는 계산된 scopeId/flowId/localNodeId와 부모 경로를 추가할 수 있다. root wait의 기존 nodeId는 호환성을 유지하고, 같은 제목/노드 ID가 여러 하위 실행에 있어도 사용자가 대상 작업을 구분할 수 있어야 한다. 기존 UI는 wait 배열을 렌더링하므로 새 endpoint보다 대상 정보와 상태 의미를 먼저 보완한다.

실제 실행 통합과 검증 전에는 `wait.child` 등의 신규 capability를 광고하지 않는다. 최종 capability 명칭은 core 요구 수집과 Runner를 함께 변경할 때 고정한다. 하위 대기가 포함된 ZIP을 이전 Runner가 묵시적으로 받지 않도록 요구 capability를 계산한다. 편집기의 하위 대기 차단 해제도 해당 지원 경로만 적용한다.

## 구현 순서·대상

|순서|대상|완료 조건|
|---|---|---|
|A0|pending 실제 통합 시험, 이 문서|현재 CHILD_WAIT_UNSUPPORTED를 실제 ZIP/SQLite 경계에서 확인|
|A1|신규 execution/scope-waits.ts, wake helper|대기 판별·정확한 scope 해석·비지원 호출 경로 차단·wake 유실 방지의 독립 검사|
|A2|state 프레임/대기 원자 전이, service, child-scopes, DurableGraph|단일/중첩 local form/review/file wait와 부모 재개|
|A3|restart·시간·예산·파일/권한·취소/만료|기존 작업 재실행0, 안전 체크포인트 복원, unknown 보존|
|A4|API DTO·Runner UI·core 요구·편집 지원|실제 사용자가 정확한 하위 질문에 응답하고 3호스트 ZIP 실행. 이후에만 지원 선언|
|B|parallel.all wake/aggregate·다중 대기|활동하는 형제는 계속 실행, 모든 대기 때만 idle, 동시 응답·보호 종료 우선순위 유지|

## 필수 회귀 목록

- 단일/중첩 흐름의 form.request, review accepted/rejected, file_input 실제 bytes 업로드.
- 부모/자식이 동일한 local node ID를 사용해도 정확한 scope에만 응답 적용.
- 응답 전·저장 후·소비 후·자식 완료 직후 실제 SQLite close/reopen과 값/순서 유지.
- 이전 모델/파일/메모리 작업 재실행0 및 root 공유 모델/토큰/노드/활성 시간 한도 미초기화.
- 오래 기다린 뒤에도 남은 parent timeout만 사용, 만료/취소/재개 경합, 중복 응답/본문 충돌.
- 불명 호출 예약 유지와 자동 재전송0, 완료 result를 만들지 않은 상태의 올바른 R03 판정.
- root 기존 form/review/file waits, child scopes/loop/parallel/team/candidate의 기존 비대기 경로 회귀.
- 미지원 parallel/loop/team/candidate 경로의 직접/간접 대기 준비 거절.
- HTTP 사용자 응답과 MCP bearer 거부, 다른 wait/run FileRef 거부, RAG 권한 철회·상태/파일 공개 차단.

## 현재 검증 기록

2026-10-28 23:12 KST, Node24.22.1. 명시 실행한 pending 통합 시험 **1개 실패**: readiness의 `CHILD_WAIT_UNSUPPORTED`, 위치 `/subworkflows/child/nodes/question`. 실행 통합은 아직 없으며 이 실패는 완료/통과 수에 넣지 않는다. skip/expected-failure로 통과시키지 않는다.

```powershell
& ./.tools/node/node-v24.22.1-win-x64/node.exe tooling/run-pnpm.mjs exec vitest run --config tests/integration/child-waits.pending.config.ts
```

기본 Vitest는 `.pending.ts`를 검색하지 않는다. 구현 통합 후 정식 `.test.ts`로 옮기며 전체 gate에 포함한다. 운영용 ZIP/모델/호스트 성공으로 주장하지 않는다.

2026-10-28 23:22 KST: 새 `scope-waits.ts`와 `run-wake-coordinator.ts`의 **독립 pending 검사 10개 통과**(2.26초). 실제 대기 판별과 정적 잠재 대기를 구분하고, 비지원 호출자의 간접 도달, 중첩 범위/부모/plan/instance 변조, 같은 local ID, 진행 중 wake 합치기와 실패 drain 자동 반복 금지를 확인했다. 아직 서비스에서 이 helper를 호출하지 않는다. 실행 통합 pending 1건은 계속 미완이며 해당 10개 통과로 대체하지 않는다.

```powershell
& ./.tools/node/node-v24.22.1-win-x64/node.exe tooling/run-pnpm.mjs exec vitest run --config tests/integration/child-waits.pending.config.ts tests/contracts/scope-waits.pending.ts
```

독립 파일 저장 후 Runner 패키지 타입 검사에서 선택적 flow map 값과 never 함수의 제어 흐름 축소 오류를 발견해 해당 신규 helper 안에서 수정했고, `--filter @studio/runner typecheck`가 통과했다. 기존 서비스/저장소는 변경하지 않았다.

## R10-A 실행부 준비 패치와 연결 계약

2026-10-28 23:49 KST 기준 `child-scopes.ts`, `durable-graph.ts`, `concurrency.ts`에 다음 준비 패치를 추가했다. 서비스·스토어·capability 등록은 아직 연결하지 않았다. 현재 운영 readiness의 `CHILD_WAIT_UNSUPPORTED`는 유지된다.

| API | 계약 |
|---|---|
| `ChildScopeExecutor.advance(...)` | `completed(output)` 또는 `suspended(waitIds)`를 반환한다. 명시적인 local subworkflow 호출만 suspend할 수 있다. 기존 `execute()`는 결과 전용 API이고 대기를 허용하지 않는다. |
| `ChildWaitLifecycle.create(node, inputs, scope)` | 서비스가 실제 wait와 attempt를 동기 DB 작업으로 저장한 뒤 ID를 돌려준다. 원문 workflow가 이 콜백을 공급할 수 없다. |
| `ChildWaitLifecycle.suspend(scope, waitIds)` | 자식 scope/frame의 대기 전이를 저장한다. 결과·선택 edge·완료 attempt를 만들지 않는다. 부모까지 전파한 뒤 root idle을 확정해야 한다. |
| `ChildWaitLifecycle.restore(record, scope)` | 저장된 frame과 계획·입력을 확인하여 `ready` 또는 동일한 `suspended`를 반환한다. 일반 running 기록을 ready로 추정하면 안 된다. 결과 불명/실패/취소는 재실행 대상이 아니다. |
| `ChildWaitLifecycle.canResumeOwner(scope, node)` | durable journal의 안전한 ready frame을 스케줄러에 알린다. 실행 전 실제 CAS claim은 별도로 수행한다. |
| `DurableGraph`의 선택적 continuation | `subworkflow`의 `waiting_children` 상태만 선택할 수 있다. running leaf, 다른 composite 또는 완료 노드는 선택하지 않는다. |
| `ActiveExecutionDeadline(maximumMs, previousActiveMs, parentSignal)` | 누적 활성 시간을 전달받아 남은 시간만 타이머로 제한한다. `close()`로 인간 대기 전 구간을 닫고 반환된 누적 시간을 DB에 저장한다. 재개는 저장된 값을 받는 새 구간이다. |

`ExecutionScope.waitsAllowed`는 실행기가 만든 내부 값이다. 상위 loop/parallel/team/candidate 경로가 false이면 중첩 subworkflow가 progress API를 호출해도 대기를 다시 허용하지 않는다. 신규 API를 부르는 것만으로 준비 검사나 권한 검사를 우회하지 못한다.

재개 시 저장된 `succeeded` 노드의 `NodeOutput`을 복구한다. 이미 완료한 input/모델/파일/메모리를 다시 호출하지 않는다. 성공 결과가 정상 `NodeOutput`이 아니거나 running/ready/retry_wait/reconciling/failed/blocked/cancelled leaf가 남으면 재개를 거절한다. 안전한 frame 확인 전에는 저장된 최종 output만으로 성공을 추측하지 않는다.

### 스토어 인계 후 예정된 DB15 변경

아래 명칭은 서비스/스토어 인계 시 확정한다. R07의 DB14 `working_contexts`와 분리한다.

| 대상 | 필수 원자 전이/검사 |
|---|---|
| `child_continuations` 또는 동등한 frame 테이블 | owner node instance PK/FK, root run, 기존 attemptId, planHash, inputHash, phase, revision, activeMs, ready wait identity. 사용자 응답과 무관한 interrupted frame을 ready로 복구하지 않는다. |
| `beginOrResumeChildFrame` | 새 실행만 attempt를 만들고, 재개는 같은 attempt·plan·input·revision을 CAS로 claim한다. 남은 timeout을 돌려준다. |
| `suspendChildFrame` / `finishChildFrame` | 누적 활성 시간을 저장하면서 각각 suspended/terminal로 전이한다. 이미 진행한 revision이나 다른 attempt의 호출을 거절한다. |
| `childScopeWakeState` | 성공 결과 재사용, 같은 pending wait 반환, 명시적 ready continuation만 구분한다. running을 일반 재실행하지 않는다. |
| `completeScopedWait` | 응답 소비, 정확한 scoped node 결과, 선택 edge, 모든 조상 frame wake를 한 트랜잭션으로 기록한다. 기존 root 응답도 호환한다. |
| `parkRunAtChildWait` | 모든 A 호출 체인이 suspended이고 활동 중 leaf/unknown 작업이 없음을 확인한 뒤 root waiting과 활성 구간 종료를 저장한다. |
| `listReadyChildContinuations` | 응답 소비 후 실제 후속 작업 시작 전 중단된 안전 구간을 복원한다. paid 호출 시작 이후 불명 결과의 자동 재전송 경로로 사용하지 않는다. |

추가 연결 지점은 service의 readiness, `attemptNode` stable attempt/remaining timeout, root execute의 suspension 처리, scoped wait 노드 해석/파일 검사, 응답 소비/재개 coordinator, 재시작/만료/취소 처리다. 기존 `node_claims`, `child_scopes`, graph, model/token reservations, artifact ownership, disclosure gate는 계속 사용한다. review는 보안 승인으로 바뀌지 않는다.

### 준비 패치 검증 결과

- `scope-waits.pending.ts`와 `child-execution.pending.ts`: **20개 통과**, 6.49초. 실제 SQLite graph/대기 기록을 사용하여 직접·중첩 suspension 전파, 이전 결과 재사용, 이미 완료한 input 재실행 0, 안전하지 않은 running leaf 거절, 상위 비지원 경로 우회 차단, 남은 parent deadline을 확인했다.
- 이 중 lifecycle hook은 시험 경계다. DB15 frame·서비스 재시작은 아직 구현하지 않았으므로 위 검사를 실제 재시작/운영 capability 증거로 세지 않는다.
- 기존 `runner-child-scopes.test.ts`, `runner-candidate-search.test.ts`, `runner-agents.test.ts`: **77개 통과**, 11.51초. 현재 비대기 실행의 회귀를 확인했다.
- Runner 패키지 타입 검사와 `tsconfig.tooling.json` 타입 검사 통과.
- 전체 suite/build는 통합 담당자의 소유이며 이번 준비 패치에서 실행하지 않았다. 앞의 실제 ZIP 통합 pending 1건은 계속 미연결 상태다.

## 서비스 인계 전 통합 시험 초안 확장

2026-10-29, `runner-child-waits.pending.ts`를 현재 공개 메소드 계약에 맞춰 **31개 예정 시험**으로 확장했다. 아래는 준비한 시나리오이며 아직 실행하지 않았다. 기존 실패 1건을 반복해서 실행하거나 새 초안을 통과 수로 집계하지 않는다. `tsc --noEmit -p tsconfig.tooling.json`만 실행해 타입 검사 통과를 확인했다.

| 묶음 | 실제 경계/기대 결과 |
|---|---|
| 첫 수직 연결 | 3호스트 ZIP의 단일 form + 중첩 form. 같은 local ID라도 정확한 scope를 유지하고 부모 결과는 응답 전 비어 있다. |
| 업무 검토 | 단일·중첩 review의 수락/거절. 해당 제어 edge만 활성화하며 비선택 경로는 skipped, 보안 권한/effect를 발행하지 않는다. |
| 파일 | 3호스트 ZIP × 단일·중첩 선택. 실제 UTF-8 bytes를 업로드·복사·읽기하고 바이트 동일성을 확인한다. 같은 upload ID는 하나의 자료다. |
| 소유권/응답 | 같은 local ID의 다른 wait/run FileRef, 원본 SHA 변조, 임의 scope/actor, 잘못된 응답 schema를 거절한다. 동일 requestId+본문은 한 번 소비하며 충돌은 거절한다. |
| 종료 | 중첩 form/file 취소, TTL 만료, 늦은 응답/업로드를 거절하고 부모 scope가 runnable 상태로 남지 않는다. |
| SQLite 재시작 | pending 질문, 저장했으나 미소비한 응답, 업로드된 파일을 실제 DB close/reopen으로 복원한다. 같은 scope/wait/만료와 이미 완료한 모델 사용량·결과를 유지한다. |
| 시간/공유 예산 | 인간 대기 시간은 root/부모 활성 시간에서 제외한다. 부모 활성 시간 1,000 ms 중 앞선 count가 650 ms를 쓰면 재개 후 다음 650 ms count는 남은 시간만 받고 생성 전 차단된다. 모델 호출/토큰/노드 예산도 재개 때 초기화하지 않는다. |
| 결과 불명 | 응답 후 실제 provider 경계의 통신 유실/취소를 unknown으로 돌려 예약을 보존한다. 재시작 뒤 전송 횟수가 늘지 않는다. 별도 SQLite 중단 상태 fixture도 waiting_children를 안전한 사용자 대기로 오인하지 않는지 확인한다. |
| HTTP | 중첩 질문은 기존 cookie+CSRF 경로만 응답 가능하고 MCP bearer는 거절한다. |
| R10-B 차단 | parallel→subworkflow→질문 같은 간접 경로도 A에서는 readiness에서 명시 거절한다. 기존 비대기 병렬 동작을 바꾸지 않는다. |

서비스 연결 후 처음에는 다음 필터로 단일·중첩 form만 실행한다. 이 연결이 통과한 뒤 review/file, 취소·재시작, 예산·불명 결과 순으로 넓힌다. 짧은 통합 gate를 닫기 전에는 parallel suspension을 추가하지 않는다.

```powershell
& ./.tools/node/node-v24.22.1-win-x64/node.exe tooling/run-pnpm.mjs exec vitest run --config tests/integration/child-waits.pending.config.ts tests/integration/runner-child-waits.pending.ts -t 'single form|nested form'
```

다음 시험은 DB15의 실제 원자 메소드가 확정된 뒤 추가한다. 존재하지 않는 메소드나 임의 SQL로 안전 전이를 가장한 초안을 작성하지 않는다.

- 응답 소비+조상 wake를 저장한 직후, 실제 후속 dispatch 전에 중단된 continuation 복구.
- 자식 output 저장 후 부모 완료 직전 중단, 같은 부모 attempt·activeMs·revision의 재사용.
- frame revision 충돌·다른 plan/input·잘못된 attemptId에 대한 CAS 거절.
- 실제 하위 대기 중 RAG disclosure 철회와 wait 문맥/파일/후속 모델 전송 차단.

중단 상태 fixture는 실제 프로세스 강제 종료나 실제 공급자 호출 실증이 아니다. provider 대역은 tests 안에만 있으며 공개 UI/ZIP에는 포함하지 않는다. 부모 시간 검사는 단순 wall-time 대기 성공만으로 대체하지 않고 앞선 활성 구간 소비 후 남은 한도의 강제 차단까지 확인한다.
