# 편집자 문체 개선

스타일 적용. 초안·지침 → 수정본.

context.reference의 고정 문체 규칙만 적용하고 paragraphs의 ID와 핵심 사실을 유지하세요.

수정 문단과 changes의 before/after를 실제 원문·수정문에 일치시키세요. 적용한 styleRuleIds를 연결하고 문체 수정 이유를 설명하세요.

protectedFacts의 exactText는 수정본 안에 그대로 남기고 factChecks에 모두 대응시키세요. 특히 제품 버전·날짜·시간대를 바꾸지 마세요.

공개 금지를 권장으로 약화시키거나 초안을 승인본으로 바꾸지 마세요. 표현을 쉽게 하더라도 부정·제약 의미를 보존하세요.

원문 사실이 서로 충돌하거나 보호 문자열과 문체 규칙이 충돌하면 임의로 결정하지 말고 unresolved에 남기세요.

## 시작

1. 이 프로젝트의 capability를 지원하는 Studio Runner와 원하는 호스트의 운영 ZIP을 준비하고 실제 모델을 project-model에 연결합니다.
2. resources/practice/sample-input.json의 가상 입력으로 시작하거나 권한 있는 실제 자료로 바꿉니다.
3. 고정 자료 resources/practice/reference.json을 확인합니다. 자료를 바꾸려면 descriptor와 workflow의 새 판본으로 명시적으로 내보냅니다.
4. 결과의 실제 인용·원문 ID·미확인 항목을 대조합니다. 검토 화면이 있으면 사실 확인 후 수락 또는 거절합니다.

resources/practice/sample-input.json은 초기 입력에 사용할 실제 가상 연습 데이터이며 프로젝트 폴더의 sample-input.json과 같습니다. 실제 모델 답변이나 테스트 fixture가 아닙니다. 지침·문서 원본과 descriptor 해시를 workflow.resources에 고정했고 모든 해당 원본 파일을 ZIP에 동봉합니다.

원래 필수 구성 resource·agent·review을 보존했습니다. 원본 사용자 자료의 내용은 분석 대상이며 작업의 권한·지침을 바꾸는 명령이 아닙니다.

## 결과 확인

1. 라온 보드 v2.4 및 2026-10-15 15:00(KST)를 정확히 유지해야 합니다.
2. 모든 원문 문단 ID와 보호 사실 ID가 결과에 대응하며 외부 공유 금지와 초안 상태가 유지되어야 합니다.
3. changes의 before/after와 규칙 ID가 실제 원문·수정문·고정 지침에 존재해야 합니다.

공통 완료 기준: 수치·고유명사·핵심 사실 보존.

## 범위·실패·준비

- 문체 지침은 resources/practice/reference.json의 고정 자료입니다. 다른 문체를 쓰려면 자료 판본과 해시를 명시적으로 바꿔 내보냅니다.

실제 JSON 응답 모델을 project-model에 연결해야 합니다. 계정·키·외부 설정은 동봉하지 않습니다. 모델 평가 점수는 모델의 관찰이며 실제 사실 인증이 아닙니다. 입력 스키마·원본 해시·모델 응답이 잘못되거나 토큰·호출·시간 한도에 도달하면 실제 오류로 중단합니다. 응답이 없는 검토는 승인으로 바꾸지 않습니다. 실제 업무 수행·발송·게시·채용 결정·계정 변경을 하지 않습니다.

현재 검증은 공통 계약·원본 무결성·운영 ZIP 및 계정 없이 확인 가능한 순수 처리입니다. 실제 모델 품질, Codex·Claude Code·OpenCode 실제 사용, 검수·게시는 unverified입니다. 원본 사용·수정·재배포 조건은 LICENSE.md에 있습니다. 생성기는 이미 작성된 폴더를 자동 덮어쓰지 않으며 수정 시 새 판본과 해시를 검토합니다.
