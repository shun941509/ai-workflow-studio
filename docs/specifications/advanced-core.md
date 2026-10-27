# P3 순수 자료 변환·분기·평가 계약

이 문서는 `@studio/workflow-core`의 순수 계산과 Runner 연결 규칙이다. JSON Schema가 노드의 공통 구조와 연산 이름을 정의하며, 아래 규칙은 `options`/`parameters`의 폐쇄된 의미와 실행 중 오류를 정의한다. 순수 함수만 존재하는 것은 Runner handler 설치, OS 격리 또는 해당 capability 지원을 뜻하지 않는다.

## 공개 함수와 입력 경계

- `applyTransform(value, steps, resultSchema?) → unknown`
- `evaluateExpression(expression, context) → unknown`
- `evaluateCondition(expression, context) → boolean`
- `evaluateRules(value, rules, passRule, resultSchema?) → {scores, passed, evidence}`
- `classifyByRules(content, rules, onUnmatched?) → {label, matchedRuleIds, reason}`
- `mergeValues(values, config) → unknown`
- `selectControlEdges(nodeId, selectedPort, edges) → Record<edgeId, active|inactive>`
- `propagateInactiveEdges(flow, initialStates) → {edgeStates, skippedNodeIds}`
- `resolveNodeActivation(input) → {state, activeEdgeIds, reason?}`

원시 입력은 유한 JSON이며 중복 키·프로토타입 관련 키·접근자·순환·sparse array를 허용하지 않는다. 반환 자료는 원본을 변형하지 않는다. 계산 실패는 안정된 `CoreOperationError.code`와 `instancePath`로 구분한다. 엄격 JSON 파싱에서 생긴 `StrictJsonError`는 원래 코드로 전달된다. 잘못된 설정과 자료를 성공 결과로 바꾸지 않는다.

## Expression

표현식은 `{literal: JSON}`, `{var: JSONPointer}`, `{op, args}` 중 하나다. `var`는 호출자가 넘긴 context 안에서만 RFC 6901 포인터로 접근한다. 빈 포인터는 context 전체다. 상속 프로퍼티·프로토타입 키·코드 호출은 허용하지 않는다.

| 연산 | 인수 | 의미 |
| --- | --- | --- |
| eq, ne | 2개 | 객체 키 순서와 무관한 JSON 구조 비교. 숫자와 문자열을 변환하지 않음 |
| gt, gte, lt, lte | 2개 | 같은 타입의 숫자 또는 문자열. 문자열은 UTF-16 순서이며 로케일 정렬 아님 |
| in | 2개 | 오른쪽 JSON 배열에 왼쪽과 구조적으로 같은 값이 존재하는지 검사 |
| exists | 1개 | 포인터 값의 존재 검사. null은 존재하고 missing은 존재하지 않음 |
| not | 1개 | boolean 반전 |
| and, or | 2~64개 | boolean만 받아 단축 평가 |

단축 평가 전에 전체 AST를 검증한다. 실행되지 않는 분기에 미지원 연산이 있어도 오류다. 없는 값은 `exists` 또는 단축 평가로 피한 경우 외에는 오류다. AST는 256노드·깊이32 이내이며 공통 JSON 한도도 적용된다. 조건 노드는 결과가 반드시 boolean이어야 한다.

Runner의 condition context는 해석한 입력 객체다. 기본 입력 이름이 `value`이므로 해당 자료는 `/value`로 접근한다. `evaluateRules`의 개별 규칙 context는 첫 번째 value 인수이며, Runner는 `{value: inputs.value, ...inputs}`를 전달한다. 함수 자체가 자료를 자동으로 감싸거나 풀지 않는다.

## Transform DSL

| op | 허용 options | 동작과 오류 |
| --- | --- | --- |
| pick | `{keys: string[], missing?: "error"|"omit"}` | 최상위 필드 선택. 기본 missing=error. 중복 keys 오류 |
| omit | `{keys: string[]}` | 최상위 필드 제외. 원래 없는 필드는 무시 |
| rename | `{mapping: {원래이름: 새이름}}` | 원본을 기준으로 동시에 변경. 명시적 a↔b 교환 허용. 없는 원본·중복 대상·기존 필드 덮어쓰기 오류 |
| map | `{steps: TransformStep[]}` | 배열 원소마다 하위 pipeline 적용. 원소 순서 보존 |
| format | `{template: string}` | `{{/name}}` 같은 JSON Pointer 자리만 치환. scalar만 허용하며 null은 `null` 문자열. 객체는 먼저 stringify 필요 |
| parse_json | `{}` 또는 생략 | 문자열을 중복 키까지 검사하는 엄격 JSON parser로 변환 |
| stringify_json | `{indent?: 0..8 정수}` | JSON 문자열로 변환. 기본 indent=0 |

미지원 option은 무시하지 않고 오류다. pipeline은 1~64 steps, 중첩 map 최대8, 전체 실제 연산 최대10000이다. map 입력 최대10000원소, keys/mapping 최대1000개, template 최대100000자, 각 단계 결과 UTF-8 직렬화 크기 최대8MiB다. 공통 JSON 복잡도 제한도 적용한다. 결과 schema를 제공하면 마지막 자료가 반드시 일치해야 한다.

예: JSON 문자열 → `parse_json` → `map[{pick:{keys:["name"]}}, {format:{template:"제목: {{/name}}"}}]`는 문자열 배열을 만든다. 이 표의 간략 표기와 달리 실제 step JSON은 `{op:"pick",options:{keys:["name"]}}` 형식이다. 템플릿이나 expression에 JavaScript·셸·eval 문법은 없다.

## 규칙 평가와 분류

`evaluateRules(value, [{id, expression}], passRule)`는 1~100개 유일 ID의 규칙을 계산한다. 각 결과는 boolean 또는 유한 숫자다. boolean은 명시적으로 1/0 점수가 되고 숫자는 그대로 유지한다. 임의 평균·가중치·확률을 만들지 않는다. `evidence`는 입력 규칙 순서대로 `{ruleId, result}`를 기록한다.

`passRule` context는 `{scores, evidence, value}`이며 결과는 boolean이다. 예: `{op:"gte",args:[{var:"/scores/quality"},{literal:3}]}`. 선언한 resultSchema가 있으면 `{scores,passed,evidence}` 전체를 검증한다. schema가 구조상 빈 rules를 허용해도 실제 rules 실행에서는 `EVALUATION_RULES_REQUIRED` 오류다.

요구 기능에는 `node.evaluate@1`과 함께 `evaluate.rules@1` 또는 `evaluate.model@1`이 포함된다. rules 처리기만 설치한 Runner는 model 모드를 실행 전에 차단해야 한다.

`classifyByRules`는 내부 순수 helper다. 정확히 한 규칙만 맞으면 label=id, 하나도 안 맞으면 `unclassified` 또는 명시한 error 정책, 여러 개가 맞으면 모호성 오류다. 우선순위·신뢰 점수를 만들어내지 않는다. canonical classify 노드는 여전히 모델 기반이며 이 helper가 새 mode를 추가하지 않는다.

## 활성 제어 흐름과 Merge

edge 상태는 pending/active/inactive다. `selectControlEdges`는 현재 노드의 선택 포트에 연결된 정확히 한 edge를 active로, 나머지를 inactive로 만든다. 같은 포트의 암묵적 fanout은 오류다. terminal output은 이 함수를 호출하지 않는다. 병렬 실행은 별도 블록 계약이다.

`propagateInactiveEdges`는 모든 incoming edge가 inactive인 노드만 skipped로 계산하고, 그 노드의 outgoing pending edge를 inactive로 전파한다. 공통 join에 active 또는 pending 경로가 하나라도 남으면 그 join을 건너뛰지 않는다. 이미 active인 edge를 뒤늦게 inactive로 덮어쓰는 것은 상태 충돌이다. 함수는 이미 의미 검증된 flow를 전제로 하며 Runner의 저장·재개·보호 중단을 대신하지 않는다.

`resolveNodeActivation` 입력은 `{nodeId,entryNodeId,incoming:[{edgeId,state,outcome?}],waitFor?:"single"|"all_active",acceptRecoverableError?:boolean}`다. 기본 single은 incoming 하나만 허용한다. all_active는 모든 pending 경로의 결정 및 active 선행 작업의 성공을 기다리고 inactive를 제외한다. 전부 inactive이면 skipped다. active의 failed/blocked/cancelled는 다른 경로의 pending보다 우선한다. handled_error는 명시적으로 오류를 받는 handler만 허용한다. Runner는 보호·예산·권한·취소 실패가 오류 경로를 통해 우회되지 않도록 실행 전체 상태도 관리해야 한다.

merge binding의 missing과 null은 다르다. 건너뛴 선행 노드를 참조하는 binding은 `onMissing:omit`을 통해서만 제외하고, 남은 자료를 `mergeValues`에 전달한다. active 자료가 하나도 없으면 scheduler가 노드를 skipped 처리해야 하며 빈 성공 값을 생성하지 않는다.

- `combine:array`: binding alias의 오름차순으로 값 배열을 만든다. 완료 시각과 무관하다.
- `combine:object, collision:error`: 각 입력 객체를 합치며 같은 키는 값이 같아도 오류다.
- `combine:object, collision:namespace`: `{alias: value}`로 보존한다.
- `combine:select`: selectKey가 있으면 해당 alias가 반드시 존재해야 한다. 없으면 active 값이 정확히 하나여야 한다.

waitFor는 all_active다. selectKey는 select에만, namespace는 object에만 유효하다. 무관한 option도 오류다.

## Guardrail parameters — Runner 연결 규격

guardrail의 canonical rules는 expression이 아니라 `{id,kind,parameters}`다. 다음은 Runner 구현이 따를 폐쇄된 parameters 계약이다. 이 문서가 순수 core에 guardrail handler가 있다는 뜻은 아니다.

| kind | parameters | 검사 |
| --- | --- | --- |
| schema | `{schema: JSONSchema}` | spec.validateJsonValue 공통 제한으로 검사 |
| length | `{min?: 0이상 정수,max?: 0이상 정수}` | 하나 이상 필요, min≤max. 문자열 Unicode code point 수 또는 배열 원소 수. 다른 타입 오류 |
| allowed_values | `{values: JSON[]}` | 구조적으로 같은 값이 배열에 존재하는지 검사 |
| required_fields | `{fields: string[]}` | 객체의 최상위 own field 존재 검사. null도 존재로 취급 |

ID는 유일해야 하며, 알려지지 않은 parameters나 프로토타입 키를 허용하지 않는다. 암묵적 경로 탐색·자료 타입 변환은 하지 않는다. guardrail 위반은 onViolation=block이며 일반 업무 실패처럼 오류 경로로 보내지 않는다. 실제 handler·영속 상태·모드별 preflight 시험은 Runner에서 별도로 통과해야 한다.

## 검증 경계

contracts 시험은 구조 비교, missing/null, 잘못된 AST, 프로토타입 접근, DSL 옵션과 한도, 실제 변환 pipeline, 분기 diamond의 공통 join, all_active, 보호 상태 전파, merge 충돌, 규칙 증거, mode 요구 기능을 확인한다. 이 시험은 OS sandbox, 네트워크 차단, Windows 배포물, 3종 AI 호스트, 모델 기반 평가 또는 31개 처리기 전체 완료의 증거가 아니다.
