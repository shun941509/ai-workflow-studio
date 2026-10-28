# 가상 온솔 기록보관함 — 요구사항 검토 근거

출처 ID: RQ-EXPORT-05 / 원작 가상 내보내기 명세 1판
실제 사용자 자료를 사용하지 않은 예제 문서입니다.

## E1 형식
내보내기 형식은 UTF-8 JSON입니다. manifest의 rowCount와 records 배열 길이를 함께 확인합니다. 각 레코드에는 recordId, revision, approvedAt, status가 들어갑니다.

## E2 제외된 기능
이 판본에는 XLSX 내보내기와 이메일 자동 발송 기능이 없습니다. 수신자 승인을 받았다는 이유로 없는 형식을 제공한다고 쓰지 않습니다.
