# 대안 비교표 작성

사용자가 정한 대안과 기준을 모두 대조하고, 제공되지 않은 값은 미확인으로 남기는 운영 프로젝트입니다.

## 실행

1. Studio Runner에서 agent.task/single_step, form.initial, transform.pick을 지원하는 버전을 준비합니다.
2. Codex·Claude Code·OpenCode 중 사용할 호스트용 운영 ZIP을 가져옵니다. 실제 JSON 응답을 지원하는 모델을 comparison-model에 연결하세요.
3. goal, options, criteria, facts를 입력하고 실행합니다. ID는 항목마다 고유하게 지정하며 사실의 optionId/criterionId가 존재하는지 확인하세요.
4. matrix의 행 수와 ID 조합을 입력의 모든 대안×기준과 대조하세요. provided는 입력 자료를 사용했다는 뜻이며 사실 검증 인증이 아닙니다.

## 입력과 결과

- sample-input.json은 가상 행사 비교 연습 입력이며 실제 업체·가격 정보가 아닙니다.
- matrix: 대안 ID·기준 ID·값·provided/unconfirmed·근거 출처
- unknowns: 누락·충돌하여 추가 확인이 필요한 내용
- summary: 확인 가능한 차이와 결정할 수 없는 이유

## 확인 기준

모든 기준 반영, 미확인 값 구분. 연습 입력의 네 조합이 한 번씩 등장하고 b/travel은 null/unconfirmed여야 합니다. facts=[]면 모든 값이 미확인이어야 합니다. 서로 다른 비용 사실을 넣으면 충돌을 표시해야 합니다. 모델의 의미적 정확성은 사람이 원문과 비교해야 합니다.

실행은 모델 호출1회·총12000토큰·활성5분 한도입니다. 모델 연결 누락·잘못된 JSON·예산 초과 시 성공 결과를 대신 만들지 않습니다. 외부 조회·선정·구매·발송을 수행하지 않습니다.

## 현재 검증 상태

규격과 3종 ZIP 구성은 검사했습니다. 실제 모델 호출, 세 호스트의 실제 사용, 관리자 검수·공식 게시는 아직 검증하지 않았습니다. 기본 편집기의 agent 설정 화면 지원 전에는 이 파일을 임의 변환하지 말고 해당 기능을 지원하는 Runner에서 사용하세요.
