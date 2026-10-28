# R03: 실행 상태와 업무 완료 기준

`run.status`는 엔진이 실행을 끝냈는지, `run.outcome`은 작성자가 명시한 업무 완료 기준을 모두 충족했는지 나타낸다. `NodeOutput`과 원래 결과는 바꾸지 않는다. `succeeded`만으로 업무가 완료되었다고 표시하지 않는다. `outcome: "complete"` 같은 모델 생성 문자열에도 판정 권한이 없다.

## 실행 정의

JSON Schema 원본은 `completion.schema.json`, `run-outcome.schema.json`이다. Workflow 루트에만 선택적 `completion`을 선언한다. 하위 흐름에 별도 기준을 넣거나 하위 노드 ID를 루트 근거처럼 참조할 수 없다. 선언이 있으면 `workflow.completion@1` capability가 manifest와 requirements lock에 고정된다. Codex·Claude Code·OpenCode ZIP은 같은 선언을 보존한다.

```json
{
  "completion": {
    "version": 1,
    "criteria": [
      {
        "id": "required_sections",
        "label": "최종 결과에 요약과 근거가 있음",
        "kind": "result_schema",
        "schema": {
          "type": "object",
          "required": ["summary", "evidence"],
          "properties": {
            "summary": { "type": "string", "minLength": 1 },
            "evidence": { "type": "array", "minItems": 1 }
          }
        }
      },
      {
        "id": "final_review",
        "label": "최종 사용자 검토에서 수락",
        "kind": "review_accepted",
        "nodeId": "final_review"
      }
    ]
  }
}
```

이 예시의 `final_review`는 실제 루트 review 블록이어야 한다. 모든 1~32개 기준이 필수이며, 선언 전체는 실제 UTF-8 256 KiB 이하이다. ID는 고유하고 label은 비어 있을 수 없다. 미지원 정규식·외부 스키마 참조 등은 공통 사용자 스키마 정책으로 거절한다. `workflow.outputs`는 실행 결과 형식이며 자동 업무 기준으로 복사하지 않는다. 명시한 `schema: true`는 허용하지만 형식 기준만 충족한다는 의미다. 사실 정확성이나 업무 품질 전체를 보증하지 않는다.

|기준|실제 지정 대상|충족 조건|검사 방법|
|---|---|---|---|
|`result_schema`|루트 최종 output의 `NodeOutput.data`|추가로 명시한 schema 통과|`json_schema`|
|`review_accepted`|루트 review|`data.decision === "accepted"`|`human_review`|
|`evaluate_passed`|루트 evaluate|`data.passed === true`|rules는 `rule_evaluation`, model은 `model_evaluation`|
|`agentic_answered`|루트 agent의 `strategy: agentic_rag`|`data.status === "answered"`|`agentic_protocol`|
|`loop_condition_met`|루트 loop의 `mode: until`|`data.reason === "condition_met"`|`loop_control`|

반려, 평가 실패, insufficient/conflicting evidence, 반복 한도 도달은 해당 기준을 충족하지 못한다. 미실행·비활성·누락·손상된 근거는 `unavailable`이며 성공으로 간주하지 않는다. `needs_clarification`으로 대기 중이면 최종 판정 전이다. 모델 평가 방법은 UI에서 규칙/사용자 검토와 구분하며 사실 인증을 보장하지 않는다고 안내한다. review는 업무 검토이고 보안 권한 승인이 아니다.

작성자가 지정한 **최종** 근거가 우선한다. 이전 검토가 반려였더라도 보완 뒤 별도 최종 검토가 수락되었고 그 노드를 지정했다면 충족할 수 있다. 과거 반려를 영구 veto로 바꾸지 않는다. 반대로 모든 거절/불충분 값을 임의의 전역 자동 규칙으로 해석하지 않는다. 업무상 필요한 거절·근거 부족·한도 조건은 해당 기준이나 명시한 결과 schema에 포함해야 한다.

## 판정 저장과 조회

`RunOutcome`의 상태는 `unassessed | complete | incomplete`다. UI는 각각 ‘업무 완료 미평가’, ‘업무 기준 충족’, ‘업무 기준 미충족’으로 표시한다. 엔진 성공은 ‘실행 완료’로 별도 표시한다.

- 기준 없는 새 실행과 legacy 실행은 엔진 상태에 관계없이 `unassessed / criteria_missing`이다.
- 기준이 있는 created/running/waiting/attention_required는 `unassessed / not_assessed`다.
- succeeded에서는 명시한 모든 기준을 검사한다. 전부 passed여야 complete이며 하나라도 failed/unavailable이면 incomplete다.
- failed/blocked/cancelled는 `incomplete / execution_incomplete`이며 최종 기준 checks는 비운다.
- `planHash`, `criteriaHash`, 최종 `resultHash`, `assessedAt`, 기준별 ID·label·종류·방법·상태·사유·root nodeInstance/result hash를 기록한다. 본문 결과를 판정 레코드에 복사하지 않는다.

SQLite migration 13은 `run_outcomes`를 추가하며 기존 실행을 소급 평가하지 않는다. 실행 생성 시 미평가 레코드를 만들고, terminal 상태·판정·`outcome.assessed` 이벤트는 같은 트랜잭션에 기록한다. 취소와 대기 만료도 같은 경계를 사용한다. 쓰기 실패는 엔진 상태 전이도 rollback한다. terminal 상태 재전이, 동일 start 재호출, 두 번째 취소/만료는 판정을 중복 발행하지 않는다. 이전 DB 버전만 지원하는 바이너리로 migration 13 DB를 열어 쓰는 다운그레이드는 거절한다.

조회 시 기존 판정이 고정된 plan/criteriaHash, 원래 결과, 실제 root node 근거와 일치하는지 확인한다. 기준의 순서·ID·label·방법·source instance/hash도 대조한다. 순수 JSON/프로토콜 검사만 사용하며 모델·도구를 재실행하지 않는다. 없는 레코드는 미평가로 반환한다. 오염/불일치/손상은 `outcome_record_invalid`로 미평가 처리하고 저장값을 성공으로 복구하거나 덮어쓰지 않는다.

API `status`, `listRuns`, `results`, MCP의 동일 서비스 응답에는 `outcome`이 동급 필드로 추가된다. 기존 `result`와 `status`는 원문 그대로다. RAG 현재 공개 권한을 확인할 수 없거나 철회되면 status/list/cancel은 `outcome: null`과 최소 메타데이터만 반환하며 results/events는 기존 정책대로 거절한다. Runner UI는 이전 판정·근거·결과 캐시도 즉시 비운다.

## 브라우저와 검증

Runner의 CSP를 완화하지 않는다. UI는 Schema에서 생성한 Ajv standalone shape validator를 `@studio/spec/browser`로 사용하고, 서버와 같은 의미 검증 함수를 공유한다. 브라우저에서 동적 Ajv 컴파일·eval을 실행하지 않는다. 기준 설명/근거는 React의 escaped text로 표시한다.

검증 파일: `tests/contracts/completion.test.ts`, `tests/contracts/runner-ui-outcome.test.ts`, `tests/integration/runner-completion.test.ts`, 실제 Chrome/운영 UI 검사는 `tests/integration/check-runner-outcome-ui.ts`다. 테스트 대역은 tests에만 있으며 실제 모델·키·외부 호스트 실행을 대신한 완료 증거로 사용하지 않는다. 이 단계는 JSON 선언·Runner 판정·UI·운영 ZIP 보존의 수직 구현이며 완료 기준 편집 폼, 기존 120개 프로젝트의 기준 보완, 실제 모델 품질·업무 수용 검증을 자동 완료로 세지 않는다.
