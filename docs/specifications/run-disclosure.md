# 실행 전체의 RAG 공개 권한 기준

2026-10-28. 운영 보완 계약이며, 필드별 lineage나 외부에 이미 전달된 데이터 회수를 구현했다는 뜻이 아니다. 실제 OpenAI 호출은 이 검증에 포함하지 않는다.

## 기준과 상태

신뢰된 Runner가 발급한 root run 하나를 공개 단위로 삼는다. 첫 RAG 원문 해석·색인 열기·검색 관찰 전에 `run-rag-v1` authority/scope/subject/epoch와 현재 ACL·그룹 스냅샷의 canonical SHA-256을 RunStore에 고정한다. 빈 검색도 공개 기준을 갖는다. JSON 문자열로 변환되거나 합류·하위 흐름·루프·기억·파일을 거쳐도 같은 run이므로 보호를 잃지 않는다. 사용자가 작성한 workflow.id, index scope, literal metadata는 기준을 선택하거나 바꿀 수 없다.

RunStore v11의 `run_disclosure`는 새 실행 생성과 같은 SQLite transaction에서 `unobserved`를 기록한다. 첫 관찰만 `pinned`로 전이하며 동일 snapshot 재사용은 no-op이다. 권한 변경 또는 조회·형식 실패가 확인되면 `blocked`와 고정 오류 이벤트를 같은 transaction에 저장한다. 변경된 권한으로 다시 pin하거나, 예전 권한이 복원됐다는 이유로 해제하지 않는다. 새 실행을 시작해야 한다.

v10 이하에서 넘어온 실행은 row를 backfill하지 않는다. 저장된 main/child workflow에 knowledge/retrieval이 있는 legacy run은 `RAG_DISCLOSURE_STATE_REQUIRED`로 본문 공개와 재개를 거부한다. RAG가 없는 legacy run은 기존 동작을 유지한다. 손상된 pin JSON·지원하지 않는 기록 형식·없는 authority DB는 `RAG_DISCLOSURE_UNAVAILABLE`로 영구 차단한다. 공개 검사는 authority DB나 scope를 새로 만들지 않는다.

권한 저장소와 RunStore는 별도 SQLite DB다. 첫 등록 transaction → snapshot 읽기 → 원자 pin 저장 → 즉시 현재 snapshot 비교 순서이며, 이후 각 경계에서 다시 비교한다. 두 DB에 걸친 단일 transaction이나 네트워크 요청과 ACL DB의 분산 원자성을 주장하지 않는다. 현재 단일 로컬 Runner의 동기 검사 바로 다음에 공급자 요청/응답 공개를 시작한다. 이미 시작된 요청이나 이미 받은 바이트를 철회할 수 없다. 신뢰된 서비스 외부에서 DB 파일을 바꾸는 공격은 OS 저장소 경계의 별도 문제다.

## 최초 관리 파일 목록

첫 build 전에 현재 root run에 이미 등록된 모든 관리 FileRef의 ID만 ACL inventory에 추가한다. 최대100개 metadata이며 선택하지 않은 PDF·바이너리 바이트를 해석하거나 색인하지 않는다. 각 build의 실제 선택은 여전히 파일32개·원문8MiB·지원 UTF-8 text/plain/markdown/JSON·청크 제한을 적용한다.

이미 존재하는 문서의 revision/ACL/tombstone, 현재 subject와 그룹을 절대 덮어쓰지 않는다. 첫 inventory의 모든 파일 ID는 현재 읽기 권한도 검사한다. 선택하지 않은 파일이라도 기존 tombstone·철회가 있으면 이를 허용된 baseline으로 받아들이지 않고 실행 전체 공개를 차단한다. 같은 파일을 여러 색인에 쓰는 등록은 epoch를 올리지 않는다. pin 후 새로 생성/업로드된 파일을 새 index에 등록하려 하면 `RAG_DISCLOSURE_SEALED`로 해당 실행을 중단한다. 이 거절은 권한 DB를 바꾸지 않으므로 기존 snapshot 자체는 pinned로 남는다. 새 파일을 색인하지 않고 일반 출력 파일로 만드는 것은 허용되며, 그 파일의 공개에는 동일 run gate가 적용된다.

## 전송·공개 경계

| 경계 | 처리 |
|---|---|
| 모든 Responses 모델 입력 count | DPAPI await 뒤, 실제 count 요청 직전에 현재 root run 재검사 |
| 모든 Responses generate | count 완료·원자 예약 뒤, generate 바로 전에 재검사. 실패하면 아직 미전송이므로 예약0 정산 |
| 임베딩 build/query | DPAPI await 뒤 및 예약 뒤 전송 직전에 검사. Responses 계수/예약 계약을 약화하지 않음 |
| 노드/하위 노드 | 시작 및 성공 결과 저장 전에 검사. 오류 경로·fallback으로 보호 중단을 성공으로 바꾸지 않음 |
| 사용자 대기 | status.context 공개, 답변 수락, 비동기 재개 후 답변 소비 전에 검사 |
| status/list/cancel | ID/상태/시간/사용량 등 최소 메타 유지. 거부 시 result:null, 고정 error, disclosure.allowed:false. status의 nodes/edges/waits/children/files는 빈 목록 |
| results/events/artifacts | 본문 전체 거부. HTTP와 MCP가 같은 RunnerService 사용 |

`status.disclosure`는 `{allowed:true}` 또는 `{allowed:false,code,message}`다. CHANGED/UNAVAILABLE/SEALED는403, STATE_REQUIRED는409를 사용한다. UI는 이전 result/waits/files/events를 즉시 지우며 오래 걸린 이전 응답으로 다시 복원하지 않는다. 완료 화면도 현재 권한을 주기적으로 확인한다. 실제 차단 시 run 상태가 이미 succeeded이면 완료 이력은 그대로 두고 공개만 거부한다. 실행 중 검사 실패는 blocked이며, 대기 중 거절은 응답을 소비하지 않는다.

권한이 바뀌지 않은 무관한 literal도 같은 run이면 차단하는 의도적인 과차단이다. 필드별 provenance가 없다는 한계를 성공으로 숨기지 않기 위한 초기 운영 정책이다. 이후 모델 count가 진행 중일 때 최초 RAG pin이 생긴 경우에도 generate는 저장소의 최신 pin을 읽는다. 처음 잡아둔 `no pin` 값을 재사용하지 않는다.

## 결과 불명과 한계

generate/embedding 전송 뒤 통신 유실·사용량 불명·취소가 겹치면 예약 유지와 attention_required가 권한 오류보다 우선한다. 본문은 별도로 가리고 최소 status에서 보류 사용량을 확인할 수 있다. 확인된 usage는 정산하고, 전송 전 차단만0으로 정산한다. 자동 재실행은 없다.

사용자의 수동 복사, 다른 실행에 붙여 넣은 literal, 이미 다운로드한 파일, 외부 AI가 이미 받은 요청, 운영체제 파일 직접 열기까지 통제하지 않는다. 현재 범위는 관리되는 단일 run의 자동 전달과 Runner HTTP/MCP 공개다. 모델의 후속 내부 저장·훈련·재전송 정책이나 원격 삭제를 보장하지 않는다.

## 검증

전용 계약 시험은 단일 pin/영구 차단, epoch 재사용 시 identity/hash 불일치, 손상 JSON, legacy migration, 누락 gate, tombstone/그룹 보존·등록 no-op을 검증한다. 통합 시험은 실제 SQLite·원문 파일·세 호스트 ZIP·HTTP/MCP로 transform→child→memory→file→AI 경로, DPAPI/count/generate 간 권한 철회, unknown 예약 유지, 빈 검색/대기/재시작, legacy 결과, authority DB 누락, 32파일·8MiB를 넘는 비선택 metadata 목록, 뒤늦은 새 파일 색인 거절을 확인한다. 공급자/DPAPI 비밀은 시험 대역이며 라이브 유료 API 검증으로 집계하지 않는다.

2026-10-28 최종 focused 검증: `run-disclosure` 계약15개·통합17개를 포함하여 아래10파일 **215개 통과, skip0**. Runner/tooling TypeScript 검사 통과. 전체 저장소 suite·production bundle·UI 브라우저 검사는 통합 담당자가 별도로 수행한다.

```
vitest run tests/contracts/run-disclosure.test.ts tests/integration/runner-disclosure.test.ts tests/contracts/model-count-broker.test.ts tests/contracts/provider-budget.test.ts tests/contracts/reranker.test.ts tests/contracts/rag-embeddings.test.ts tests/integration/runner-reranker.test.ts tests/integration/runner-rag-embeddings.test.ts tests/integration/runner-rag.test.ts tests/catalog/version-research-rag-project-content.test.ts
```

그룹 탈퇴는 실제 SQLite authority에서 문서 ACL을 그대로 둔 채 membership만 변경하여 검증했다. local child 내부 모델과 첫 pin 이전에 시작된 count의 generate 경계도 별도로 포함한다. EP102/104/105의 기존 다중색인·버전격리 검증은 그대로 통과했다.
