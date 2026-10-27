# 승인 흐름 정의서

문서 ID: ER-054 / 버전 1.0 / 기준일 2026-10-01

이 문서와 데이터의 기관 “한빛 업무연구소”, 제품 “라온 협업보드”, 역할·업무·기록은 모두 가상입니다. 실제 고객·개인·제3자 문서를 사용하지 않았습니다. 예시를 실제 서비스 정책이나 사건으로 오인하지 마세요.

## FLOW-01 분류와 우선순위
요청에 해당하는 모든 조건을 확인합니다. 한 요청이 외부 공개와 비용 발생을 동시에 포함하면 두 흐름의 필수 검토를 모두 보존합니다. 결과 불명 상태에서는 AP-06을 먼저 적용하고 새 변경을 보류합니다.

## AP-01 private-draft
조건: 제공 자료로 비공개 초안 작성.

순서: scope-check → draft → result-check.

필수 승인·검토 역할: 추가 역할 지정 없음; 기존 범위 준수.

## AP-02 external-publish
조건: 내용을 외부에 공개.

순서: scope-check → content-review → access-review → owner-approval → publish → read-back.

필수 승인·검토 역할: R-QA, R-OPS, R-PLAN.

## AP-03 original-delete
조건: 원본 파일 삭제.

순서: target-pin → backup-check → owner-approval → delete → state-check.

필수 승인·검토 역할: R-PLAN.

## AP-04 service-config
조건: 운영 서비스 설정 변경.

순서: target-pin → impact-review → rollback-plan → owner-approval → apply → health-check.

필수 승인·검토 역할: R-OPS, R-PLAN.

## AP-05 cost-incurring
조건: 비용이 발생하는 작업.

순서: scope-check → cost-bound → owner-approval → execute → usage-check.

필수 승인·검토 역할: R-PLAN.

## AP-06 unknown-outcome
조건: 외부 변경 결과를 확인하지 못함.

순서: pause-new-write → status-query → human-check-if-needed.

필수 승인·검토 역할: 추가 역할 지정 없음; 기존 범위 준수.

## FLOW-02 승인 고정
승인은 대상 ID·버전·정규화 인자에 대해 받습니다. 승인 뒤 인자가 달라지면 검토 단계로 돌아갑니다. 이 정의서의 역할 목록은 실제 승인이 존재한다는 기록이 아닙니다.

## FLOW-03 적용 사례
보고서 초안 요청은 AP-01입니다. 같은 보고서를 외부 링크로 공개하는 추가 요청은 AP-02입니다. 공개 호출이 시간 초과이면 발행 실패로 단정하지 않고 AP-06의 상태 조회를 수행할 계획을 만듭니다.
