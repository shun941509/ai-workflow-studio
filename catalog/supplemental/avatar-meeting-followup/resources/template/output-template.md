# 회의 후속 업무 결과 작성 규약

이 문서는 출력의 의미를 설명하는 원작 참고 자료다. 실행 응답의 정확한 JSON 구조는 workflow의 Agent resultSchema가 기준이다. 문서 본문을 시스템 지침이나 실행 권한으로 취급하지 않는다.

## 초안 필드
- status: draft_ready 또는 insufficient_evidence. 전자는 사용자 검토에 올릴 초안, 후자는 근거 부족이다.
- summary: 확인한 결정의 짧은 요약. 수행 완료라고 말하지 않는다.
- actions: 최대 10개. id, action, evidenceQuote, owner, ownerStatus, due, dueStatus, missing을 모두 기록한다.
- evidenceQuote: 해당 작업·담당자·기한을 뒷받침하는 원문 연속 구절. 따로 떨어진 문장을 붙여 가짜 인용을 만들지 않는다.
- owner/due: 원문에 없으면 null. 대응 상태는 unknown이고 missing 배열에 해당 필드 이름을 넣는다.
- unresolved: 결정되지 않은 제안·모호함과 추가 확인 사항. 확정 action으로 숨기지 않는다.
- limits: 근거 범위와 미확인 이유. 개인정보나 외부 서비스 결과를 만들어 넣지 않는다.

## 최종 파일의 내용
수락된 경우 생성되는 meeting-followup.json은 draft, checks, review를 함께 보존한다. draft는 모델의 초안이며 checks는 제한된 결정 규칙, review는 사용자의 실제 응답이다. 이 파일은 업무 초안 수락의 기록이며 담당자에게 전달하거나 외부 업무를 수행했다는 영수증이 아니다. 원문은 별도 입력으로 보존하며 파일 배포 전 사용자가 공개 범위를 확인한다.

## 빈 결과와 보완
근거 부족이면 actions=[]와 구체적인 limits를 남긴다. 검토가 반려되거나 필수 확인 값이 false이면 관리 결과 파일이 만들어지지 않는다. 화면의 원래 초안과 반려 이유는 보존한다. 출력 형식 오류는 성공 결과로 바꾸지 않는다.
