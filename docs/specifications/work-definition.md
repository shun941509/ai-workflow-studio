# 선택한 업무 정의 v1

R-05는 Avatar 업무 파트너의 공유 가능한 업무 정의를 `workflow.workDefinition`에 선택 사항으로 추가한다. Avatar의 목표 구성은 WorkAssets + Harness + AgentCapabilities다. 현재 단계는 Card → Role → Task 하나와 Task가 사용하는 자산·Skill, 기존 실행 블록의 역할을 검증하고 보존한다. 실제 문맥 구성과 소비 증거는 R-07의 별도 구현 범위이며, 이 계약만으로 Avatar 전체가 완성됐다고 표시하지 않는다.

## 원본과 책임

구조의 단일 원본은 `packages/spec/schemas/work-definition.schema.json`이다. Workflow Schema가 이를 참조하고 생성된 Workflow 타입에서 `WorkDefinition`을 유도한다. 손으로 작성한 별도 업무 타입은 만들지 않는다. 기존 워크플로는 필드를 생략할 수 있고 자동으로 업무 정의나 완료 기준을 부여하지 않는다.

| 내용 | 원본 위치 |
| --- | --- |
| 업무 이름·역할·목적·선택된 Task | `workDefinition` |
| 입력·결과 구조 | 기존 `workflow.inputs`, `workflow.outputs` |
| 업무 완료 판정 | 기존 `workflow.completion` 전체 기준 |
| 실행 정책·예산·모델 요구 | 기존 `workflow.policy`, `workflow.modelProfiles` |
| 자료의 종류·원본 ID·revision·해시 | 기존 `workflow.resources[alias]` |
| 실제 처리 순서·바인딩 | 기존 `nodes`, `edges`, `inputBindings` |
| 개인 계정·실제 모델 연결·자격 증명 | Runner/계정의 개인 설정. 공유 업무 정의와 분리 |
| 실행별 사용 문맥·소비 기록 | 후속 실행 manifest. 설계의 `selectedContext`와 분리 |

업무 정의에 입력 스키마, 정책, 모델 연결, 권한 목록 또는 실행 manifest를 복제하면 엄격한 추가 속성 검사에서 거절한다. Skill 연결은 지침 묶음의 사용 의도이며 네트워크·도구·코드 실행 권한을 부여하지 않는다.

## 예시

아래는 루트 블록 `start` → `work` → `finish`와 `completion.criteria`의 `nonempty-result`가 이미 존재하는 경우다. 자료를 연결하지 않은 최소 예시이므로 실제 회의 업무 품질을 보증하는 예제가 아니다.

```json
{
  "version": 1,
  "id": "meeting-followup",
  "revision": 1,
  "card": {
    "id": "meeting-partner",
    "title": "회의 업무 파트너",
    "purpose": "주어진 회의 기록에서 확인한 후속 업무를 정리합니다."
  },
  "role": {
    "id": "followup-editor",
    "title": "후속 업무 정리 담당",
    "responsibility": "원문에 없는 담당자와 기한은 미확인으로 남깁니다."
  },
  "task": {
    "id": "draft-actions",
    "title": "후속 업무 초안",
    "goal": "명시적인 결정과 담당자·기한을 근거와 함께 정리합니다.",
    "criterionIds": ["nonempty-result"],
    "assets": [],
    "skills": []
  },
  "harness": {
    "context": ["start"],
    "perform": ["work"],
    "accept": ["finish"],
    "deliver": ["finish"],
    "selectedContext": []
  }
}
```

자료 연결은 예를 들어 `{ "alias": "meeting_rules", "kind": "instruction", "usage": "instructions", "purpose": "원문 근거와 미확인 항목 표시", "required": true }`다. `alias`는 고정된 `workflow.resources.meeting_rules`를 가리킨다. 계정 자료 ID나 원본 descriptor ID로 대신할 수 없다. 문서는 `reference` 또는 `template`, Skill은 `kind: "skill", usage: "instructions"`만 허용한다.

## 교차 검증

- 선택한 Card·Role·Task는 각각 하나다. 이름·목적·책임·자료 용도는 공백만 허용하지 않는다. ID는 ASCII 영숫자로 시작하는 최대 64자 식별자다.
- `task.criterionIds`는 전체 `completion.criteria` ID 집합과 정확히 일치해야 한다. 일부 기준만 골라 업무 성공을 약하게 만들 수 없다. 업무 정의가 있으면 유효한 완료 기준이 필수다.
- 자산과 Skill 별칭은 합쳐서 중복될 수 없다. 각 참조는 기존 resource pin과 종류가 일치해야 한다. 선택 문맥에는 선언한 별칭만 포함하며 필수 자산은 모두 선택해야 한다. 선택하지 않은 선택 자산은 그대로 남는다.
- Harness는 루트 흐름의 고유한 실제 노드만 참조한다. 하위 흐름에 같은 ID가 있어도 대체할 수 없다. 누락·중복 루트 ID는 거절한다.
- `context`는 입력·자료·문서 처리·변환·병합·메모리·지식·검색 블록을, `perform`은 AI 또는 Agent를, `deliver`는 파일 결과 또는 결과 블록을 참조한다. `deliver`에는 유일한 루트 결과 블록이 반드시 포함된다.
- `accept`는 전체 완료 기준의 실제 근거 노드 집합과 같아야 한다. `result_schema`는 루트 결과 노드, 나머지는 기준의 `nodeId`를 참조한다. 평가·사용자 검토·Agentic 답변·until 반복 같은 모드의 유효성은 기존 completion 검증도 함께 수행한다.
- Harness 매핑은 제어 연결이나 바인딩을 만들지 않는다. 일반 그래프·도달 가능성·입출력·지원 모드 검사를 그대로 적용한다.

자료 최대 64개, Skill 최대 16개, 선택 문맥 최대 80개다. 완료 기준 최대 32개, context/accept/deliver 최대 32개, perform 최대 16개다. 선언은 JSON 데이터로 먼저 검사하며 접근자·비 JSON 값 및 256 KiB 초과를 거절한다.

## capability와 운영용 ZIP

업무 정의가 있으면 `collectRequirements`가 `workflow.work_definition@1`을 추가한다. 이 capability는 업무 정의 v1의 검증과 보존 지원을 뜻한다. 새로운 블록이나 실행 도구를 활성화하지 않으며 실제 문맥 소비를 뜻하지 않는다. 지원 목록의 node/mode capability와 별도 공통 계약으로 드리프트 검사한다.

업무 정의는 `workflow.json` 원본 안에 있으므로 manifest 파일 해시와 `runtime.lock.json.workflowSha256`의 보호 대상이다. Codex·Claude Code·OpenCode ZIP 생성, 검증, authoring 재가져오기 후 전체 선언·완료 기준·정확한 자료 바이트가 유지된다. 업무 목적만 바꾸고 transport 파일 해시만 다시 계산한 ZIP은 기존 runtime lock과 달라 거절한다. 별도 업무 사본 파일이나 두 번째 출처 해시는 만들지 않는다.

## 검증 기록과 다음 작성 화면

2026-10-28 전용 회귀: `work-definition.test.ts` 25개와 `support-inventory.test.ts` 16개, 총 41개 통과(2.12초). 같은 진입점의 strict TypeScript 검사도 통과했다. 3종 ZIP의 실제 바이트 생성·재검증·재가져오기·재생성과 해시 변조 거절을 확인했다. 외부 모델·호스트 실행·실사용·게시 검증은 수행하지 않았고 이 기록으로 대신하지 않는다.

후속 최소 작성 화면은 선택한 Card/Role/Task 이름과 책임, 고정 자료별 용도·필수 여부, 기존 블록의 Harness 역할을 보여 준다. 완료 기준은 기존 전체 기준을 읽어 연결하며 별도의 중복 입력 폼을 만들지 않는다. 폼 변경은 원자적으로 검증하고 undo/redo를 지원해야 한다. 현재 R-05에 이 UI가 구현됐다고 표시하지 않는다. R-07이 실제 선택 문맥 구성과 모델 입력 소비를 연결한 뒤에만 실행 manifest를 제공한다.
