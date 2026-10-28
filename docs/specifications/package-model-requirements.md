# 패키지의 모델 연결 요구

Runner의 import와 inspect는 같은 `packageDetail` 함수로 응답한다. `modelRequirements`는 `collectRequirements`가 찾은 참조 모델 별칭만 담고, 기존 `modelProfiles`도 같은 별칭 집합을 반환한다. 선언만 있고 쓰지 않는 모델에 인증정보를 요구하지 않는다. 포함된 모든 하위 흐름을 보수적으로 확인하므로 이 목록은 실제 호출 횟수나 특정 조건 분기의 실행 예측이 아니다.

```json
{
  "modelProfiles": ["embed"],
  "modelRequirements": [{
    "alias": "embed",
    "kind": "embedding",
    "requiredFeatures": ["embedding"],
    "constraint": {
      "contractId": "openai-small-256-cl100k-v1",
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 256,
      "maxChunks": 128
    }
  }]
}
```

`kind`는 선언된 chat/embedding/reranker이며 없는 선언을 임의로 추정하지 않고 null로 표시한다. UI가 지원하지 않는 종류는 선택할 수 없다. 기존에 저장된 로컬 프로필만 kind 누락을 chat으로 취급하며, 모델 이름만 보고 임베딩으로 승격하지 않는다. 요구 정보에는 로컬 프로필 ID·credential reference·비밀정보가 없다.

재순위 연결의 `constraint`는 다음처럼 별도 고정 계약을 담는다. 임베딩의 차원 필드와 혼합하지 않으며, 같은 모델 이름의 chat 연결을 대신 사용하지 않는다. 출력 토큰 상한은 예약 정책이며 실제 요금이나 검색 품질의 보장이 아니다.

```json
{
  "alias": "rank",
  "kind": "reranker",
  "requiredFeatures": ["rerank"],
  "constraint": {
    "contractId": "openai-responses-rerank-v1",
    "provider": "openai",
    "model": "gpt-5.4-mini-2026-03-17",
    "maxCandidates": 20,
    "maxInputBytes": 65536,
    "maxOutputTokens": 4096
  }
}
```

실행 준비는 같은 참조 집합과 실제 저장된 연결의 종류·고정 계약·키 존재를 확인한다. start는 호환상 오래된 클라이언트가 함께 보낸 미사용 연결을 실행 계획과 재개 데이터에서 제외한다. 요청 ID의 멱등 비교는 원래 요청 전체의 해시를 유지한다. 같은 요청 ID에 다른 미사용 연결만 보냈더라도 다른 요청이므로 충돌한다. 완료·대기 실행이 관련 없는 연결의 삭제 때문에 재개하지 못하는 일을 막는다.

검증은 요구 정보4개 및 실제3호스트 ZIP/SQLite/입출력/멱등 처리7개를 포함해11개 시험으로 확인했다. 별도 기존 Runner·임베딩·HTTP 영향32개도 통과했다. 연결 목록 표시와 준비 검사는 실제 공급자의 인증·요금·품질 검증을 대신하지 않는다.
