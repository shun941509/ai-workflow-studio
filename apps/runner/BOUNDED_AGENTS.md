# 제한된 에이전트·팀·계획 실행 계약

이 문서는 실제 처리기가 있는 모드만 설명한다. Codex·Claude Code·OpenCode ZIP은 같은 Runner 서비스와 SQLite 실행 상태를 사용한다. 외부 모델 연결 성공이나 생성 결과 품질은 테스트 대역 검증으로 대신 주장하지 않는다.

## 지원 모드와 사전 검사

| 블록 | 지원 범위 | 차단하는 구성 |
| --- | --- | --- |
| agent | `strategy=task`, `maxSteps=1`, 빈 `toolAllowlist` | 다중 단계, 도구 호출, `indexes` 입력, `retrievalPolicy`, Agentic RAG |
| agent_team | 고정 로컬 작업자 1~32명, sequential/parallel, 선택적 고정 로컬 통합 흐름 | 중복 작업자 ID, 빈 역할, 외부 패키지 흐름, 모델이 바꾸는 배정 |
| orchestrator | `mode=plan`, `maxReplans=0`, 허용 로컬 흐름 1~32개, 최대100개 작업 제안 | adaptive/dynamic, 재계획, 작업 실행, 권한 승인 |

위 모드의 capability만 광고한다. 각 블록의 타입 capability만으로 모든 모드를 지원한다고 해석하지 않는다. 하위 흐름 안의 사용자 대기는 기존 지원 범위와 같이 사전 차단한다.

## agent.task

입력 `task`, 선택적 `context`를 한 번의 제한된 결과 생성에 사용한다. 모델 응답의 닫힌 구조는 `{resultJson:string}`이며 내부 JSON 값을 다시 안전하게 파싱하고 `resultSchema`로 검증한다. 최종 출력은 `{data:{result,stopReason:'completed',steps:1}}`이다. 데이터 안의 권한·도구 문자열은 실행 효과가 아니다. 공급자 요청에 도구 인터페이스를 주지 않는다.

명시적으로 첨부한 instruction 및 Skill 본문만 지침에 추가한다. 참고 문서·Skill supporting text는 낮은 신뢰의 참고 데이터로 전달한다. 자동 자료 선택이나 Skill 스크립트 실행은 없다. 기본 출력 예약은4096 tokens이며 기존 모델 프로필·root budget·취소·unknown outcome 경계를 그대로 적용한다. 확실히 시작하지 않은 전송만 설정된 retry 정책으로 재시도할 수 있으며 결과가 불명확한 호출은 재시도하지 않는다.

## 고정 agent_team

각 작업자는 선언된 flowRef를 durable child scope로 호출한다. 입력은 다음과 같다.

```json
{"task":"사용자 작업","context":null,"member":{"id":"writer","role":"작성자"},"previousResults":[]}
```

sequential은 앞 작업자의 확정된 `{id,role,result}` 목록을 전달한다. parallel은 시작 전에 입력을 고정하며 모든 작업자의 `previousResults`가 빈 목록이다. 결과는 완료 시각에 관계없이 선언 순서로 배열에 들어간다. 통합 흐름이 있으면 모든 작업자가 성공한 뒤 `{task,context,members}`로 한 번 호출한다. 없으면 integratedResult는 null이다.

```json
{"data":{"members":[{"id":"writer","role":"작성자","result":{"draft":"..."}}],"integratedResult":null,"stopReason":"completed"}}
```

`member:<id>` 및 `integration`이 scope의 안정된 호출 키이다. 전체 root의 node instance·token·모델 호출·활성 시간·깊이·동시성 한도를 공유한다. 팀은 자식이 끝날 때까지 leaf 실행 슬롯을 점유하지 않는다. 보호 중단이나 실패 시 새 작업자를 시작하지 않으며 이미 시작한 작업을 취소하고 결과를 모두 확인한다. 불명확한 외부 호출은 attention_required가 우선하고 통합 흐름을 실행하지 않는다. 완료된 자식은 중복 실행하지 않으며 중단된 호출은 자동 재실행하지 않는다.

## orchestrator.plan

허용된 각 흐름의 ID·입출력 스키마와 goal/constraints를 모델에 전달한다. 모델의 응답은 닫힌 `{tasks:[{id,flowId,inputJson,dependsOn,purpose}]}` 형식이다. 저장 전에 다음을 모두 검증한다.

- 고유하고 안전한 ASCII 작업 ID, 허용 목록의 실제 로컬 flowId, 비어 있지 않은 목적.
- 각 inputJson의 안전한 JSON 파싱과 해당 흐름의 input schema. 입력은 구체적인 데이터이며 미래 작업 결과를 자동 참조하지 않는다.
- dependsOn은 중복 없는 앞선 작업 ID만 참조한다. 자기 참조·전방 참조·순환은 허용하지 않는다.
- 최대 작업 수, 개별 입력100,000자, 전체 계획4MiB, 예약 출력8192 tokens.

SQLite `plan_proposals`에 node instance별 불변 제안과 hash를 저장한다. 이벤트와 저장은 같은 transaction이다. 같은 제안을 재기록하면 멱등이고 다른 제안으로 바꾸려 하면 충돌한다. 실행 중인 resolved plan과 grant는 변경하지 않는다. 출력은 다음과 같다.

```json
{"data":{"planHistory":[{"revision":1,"planHash":"sha256","tasks":[{"id":"draft","flowRef":{"kind":"local","flowId":"draft_flow"},"input":{"text":"내용"},"dependsOn":[],"purpose":"초안"}]}],"taskResults":[],"stopReason":"planned"}}
```

이 모드는 child scope를 하나도 만들지 않는다. Runner 화면은 계획 내 작업이 실행되지 않았음을 표시한다. 모델 거부, 불완전 응답, 구조 위반, 입력 위반 및 unknown outcome을 성공으로 변환하지 않는다.

## 검증 위치

`tests/integration/runner-agents.test.ts`는 실제 ZIP·SQLite·서비스를 통해 단일 작업, 역할 전달, 팀 동시성·순서·공유 예산·취소, 계획 graph 검증·불변 저장·재시작, 세 호스트 ZIP을 검증한다. 모델은 이 테스트 파일 안에서만 대역을 사용하며 실제 유료 호출은 하지 않는다. 기존 child scope·HTTP·모델 예산 회귀를 함께 실행한다.
