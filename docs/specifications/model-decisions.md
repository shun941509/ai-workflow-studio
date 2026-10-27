# 모델 분류·평가 경계

`executeModelDecision(node, inputs, invoke)`는 공통 ModelBroker 콜백만 사용한다. 직접 인증정보·DB·도구에 접근하지 않으며 `{output,port}`를 반환한다. 외부 서비스 계정이 없는 시험은 이 콜백 경계에서 응답을 제공하며 실제 모델 품질이나 비용 검증을 대신하지 않는다.

분류는 선언된 라벨 또는 unclassified와 간단한 관측 근거만 받는다. 모호한 결과는 unclassified로 요청하지만 JSON 오류나 미등록 라벨을 성공한 미분류로 숨기지 않는다. 라벨 ID의 중복·예약 이름과 임의 effects 필드를 거절한다.

모델 평가는 점수 `{id,value}` 배열과 점수별 근거 `{id,reason}` 배열을 요청한다. 안전한 고유 ID, 유한 수치, 정확한 근거 매핑을 확인한 뒤 `{scores:{id:number},passed,evidence:[{ruleId,reason}]}`를 만든다. passed는 모델 응답으로 받지 않고 선언한 passRule을 `{scores,evidence,value}` 문맥에서 평가한다. 최종 resultSchema 검사 후에도 이동 포트는 next다. 분기는 별도 condition이 담당한다.

외부 응답 JSON Schema는 모든 필드를 required로 선언하고 각 객체의 additionalProperties를 false로 고정한다. 이는 [OpenAI Structured Outputs 규격](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)의 지원 형태를 따른다. 공급자의 형식 보장과 실제 내용의 정확성은 별개이므로 로컬 스키마·ID·값 검사도 유지한다. 실제 계정과 고정 모델 조합의 성공은 별도 검증해야 한다.
