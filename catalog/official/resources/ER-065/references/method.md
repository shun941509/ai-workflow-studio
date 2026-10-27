# 읽기 SQL Skill: 판단·처리 기준

SQLite의 readOnly 연결이 쓰기 금지의 실제 경계입니다. 이 Skill은 테이블별 ACL을 제공하지 않습니다. 승인된 로컬 파일에서 필요한 최소 SELECT만 실행하세요. Node.js 24 내장 node:sqlite를 사용하는 호스트 실행용 도우미이며 Studio native Worker 격리를 보장하지 않습니다. references/schema.sql은 설명 자료로만 읽습니다.

## 입력 예의 사용

example-input.json은 가상 한빛팀 상황을 위해 새로 작성한 자료입니다. 예제 값은 실제 사용자 결과가 아닙니다. 실제 자료로 바꿀 때 원문 ID·버전·허용 범위를 보존하세요. 필수 입력을 제거하거나 근거를 바꾸면 성공 결과를 그대로 유지하지 말고 실패·미확인 처리를 적용합니다.
