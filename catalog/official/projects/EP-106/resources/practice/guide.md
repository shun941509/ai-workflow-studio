# EP-106 운영 자료 사용

1. sample-input.json의 복합 질문을 입력합니다.
2. project-model에 gpt-5.4-mini-2026-03-17 대화·작업 연결을 명시적으로 선택합니다.
3. 파일 선택에서 delivery-policy.md와 return-policy.md를 함께 업로드합니다.
4. research.result의 delivery·returns·integratedAnswer와 research.citations의 서로 다른 원문을 대조합니다.

이 두 원문은 실제 상점 정책이 아닌 원작 가상 자료입니다. 실제 모델 답변·정답 fixture·키·개발 명령은 포함하지 않습니다. 키워드 검색은 로컬이지만 질문·문맥·선택 근거는 각 모델 토큰 확인·생성 요청에 전송됩니다. 외부 서비스 사용 비용이 발생할 수 있습니다. 근거 부족이면 답변을 유보합니다. 추가 질문·웹 검색·벡터·Graph 검색은 이 예제의 기능이 아닙니다.
