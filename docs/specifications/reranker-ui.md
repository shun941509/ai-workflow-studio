# 검색 결과 재정렬과 실행 내용 공개 UI

## 설정 화면

`retrieval.keyword/vector/hybrid`의 `검색 결과 다시 정렬`은 기본 꺼짐이다. 켜면 `reranker: {modelProfile, timeoutMs: 30000, onFailure: fail}`과 후보 수를 명시한다. 검색 채널을 바꿔도 이미 켠 재정렬 설정은 보존한다.

`검색 재정렬용 연결 추가`는 사용하지 않는 `reranker_default`, `reranker_2` 등을 자동 생성한다. 선언은 `kind: reranker, requiredFeatures: [rerank]`이다. 전역 선언과 현재 흐름의 참조가 하나의 실행 취소 단위다. 한글 하위 흐름 이름과 배치는 변경하지 않는다. 기존 chat 연결이나 다른 종류의 선언을 자동 승격·덮어쓰기하지 않는다. 식별자 직접 입력은 선택적인 고급 설정이다.

후보 수 → 재정렬 → 최종 결과 수(topK) → 문맥 예산 순서다. `1 ≤ topK ≤ candidateLimit ≤ 20`을 검사하며 이미 있는 큰 값을 몰래 줄이지 않는다. 혼합 모드의 후보 상한은 같은 `candidateLimit` 값이다. 재정렬을 끄면 keyword/vector의 전용 후보 수를 제거하고 hybrid의 기존 후보 수는 보존한다. 공유 모델 선언은 삭제하지 않는다.

고급 대기시간은 밀리초 단위로 원본 정수를 보존한다(1~120000, 기본30000). 노드·실행 전체 시간 제한을 늘리지 않는다. `onFailure: fail`이 기본이고 `use_original`을 명시적으로 선택할 수 있다. 생성 전 확정된 `RATE_LIMITED`·`MODEL_COUNT_UNAVAILABLE`, 또는 확인된 usage를 가진 `MODEL_REFUSAL`만 원래 순위 사용 대상이다. 인증·권한·무결성·형식·취소·시간·예산·unknown outcome은 우회하지 않는다.

## 연결과 외부 전송

Runner의 세 연결 종류는 대화·작업, 문서 임베딩, 검색 결과 재정렬이다. 재정렬은 `gpt-5.4-mini-2026-03-17` 고정 모델을 사용하며 프로필 저장 요청에는 `name, kind, model, apiKey`만 보낸다. 동일 모델의 chat 연결은 재정렬 연결로 선택할 수 없다. 연결 이름은 한글로 입력할 수 있다.

패키지의 실제 요구 alias만 표시한다. 재정렬 metadata.constraint는 다음 값과 일치해야 한다. 누락·다른 값·알 수 없는 계약은 실행 준비를 열지 않는다.

```json
{
  "contractId": "openai-responses-rerank-v1",
  "provider": "openai",
  "model": "gpt-5.4-mini-2026-03-17",
  "maxCandidates": 20,
  "maxInputBytes": 65536,
  "maxOutputTokens": 4096
}
```

키워드 검색이라도 재정렬을 켜면 검색어와 후보 원문을 OpenAI 토큰 확인 요청과 재정렬 생성 요청에 전달한다. 합계64KiB·20후보 상한과 추가 요금 가능성, 기존 실행의 호출·토큰 예산 공유를 표시한다. 고정 스키마·점수 형식 검사는 실제 모델 접근 권한·서비스 가용성·검색 품질을 검증하지 않는다. 연결 저장과 준비 검사는 모델을 호출하지 않는다.

## 결과 표시

`RunPage`는 실제 `rag.rerank` 이벤트만 읽어 별도 단계 기록을 표시한다. 최종 결과가 `/data/context` 문자열만 담더라도 원래 순위를 사용한 사실을 숨기지 않는다.

| 상태 | 표시 |
|---|---|
| `reranked` | 형식을 검사한 모델 점수로 재정렬한 단계 기록 |
| `fallback` | 원래 검색 순위 사용, 재정렬 점수 없음, public failureCode |
| `skipped_empty` | 후보 없음, 해당 재정렬 단계의 모델 호출 없음 |
| `failed` | 재정렬 중단, 성공·원래 순위 사용으로 표시하지 않음 |
| 알 수 없는 상태 | 확인 필요, 성공으로 표시하지 않음 |

이 이벤트가 기록된 뒤에도 권한·인용 검사에서 실행이 실패할 수 있다. 단계 기록은 최종 결과 공개 승인으로 표현하지 않는다. 원문·검색어·공급자 raw body를 상태 메시지에서 읽거나 HTML로 렌더링하지 않는다.

## 공개 권한 변경

서버의 `disclosure: {allowed:false,code,message}` 또는 구조화된 `RAG_DISCLOSURE_CHANGED/UNAVAILABLE/STATE_REQUIRED/SEALED` 오류를 받으면 결과·대기·파일·하위 작업·이벤트 상태를 비운다. 조회 자체가 실패한 경우도 이전 본문을 유지하지 않는다. 실행 ID·시각·현재 상태·사용량은 남길 수 있다.

상태 응답을 먼저 확인한 뒤 이벤트를 조회한다. 이벤트403이 새 상태의 공개 거부를 가리는 `Promise.all` 경로를 사용하지 않는다. 응답 세대 식별자로 차단 이후 늦게 도착한 이전 요청이 본문을 되살리지 못하게 한다. 한 번 공개가 차단된 현재 화면은 새 실행/화면 초기화 전까지 본문을 다시 요청하지 않는다. 기록 목록 캐시는 처음부터 본문·파일·대기를 저장하지 않는다.

열린 완료 화면도 약5초마다 상태를 다시 확인한다. 서버 거부를 관찰하면 즉시 표시를 비우며, 권한 변경과 모든 클라이언트의 동시 제거를 보장하지 않는다. 이미 내려받거나 복사한 내용·이미 공급자에 전송한 원문은 회수할 수 없다. 후속 AI 전송과 결과 공개는 서버의 [실행 전체 공개 권한 기준](run-disclosure.md)이 같은 root run 전체에 보수적으로 적용한다. 이 UI는 필드별 provenance나 다른 실행으로 수동 복사한 값의 권한 추적을 제공하지 않는다.

새 결과 다운로드는 화면 캐시를 Blob으로 바꾸지 않는다. 사용자 클릭마다 `/api/runs/:id/results`로 현재 공개 권한을 확인한 응답에서만 바이트를 만들고, 응답 세대가 바뀌었거나 공개가 차단되었으면 내려받지 않는다. 관리 파일 다운로드 역시 기존 인증된 artifact 경로를 사용하며 바이트 수신 도중 화면이 바뀌거나 공개가 차단되면 로컬 저장을 시작하지 않는다.

## 검증 경로

- `tests/editor/rerank-authoring.test.ts`: 채널 전환·켜기/끄기·공유 선언·한글 하위 흐름 보존, 후보·시간·닫힌 옵션 검사.
- `tests/contracts/runner-ui-reranker.test.ts`: 역할·고정 계약 필터와 단계 상태 구분.
- `tests/contracts/runner-ui-disclosure.test.ts`: 본문 캐시 제거와 공개 오류 구분.
- `tests/e2e/rerank-authoring.spec.ts`: 실제 Chrome의 자동 alias·undo/redo·21후보 차단·재열기·3종 ZIP 실제 검사.
- `tests/integration/check-runner-reranker-ui.ts`: 운영 UI·실제 로컬 HTTP/SQLite/검색·관리 파일을 사용한다. 공급자·인증 저장소만 내부 대역이며 실제 공급자 요청은0이다. 연결 준비 시 대역 호출0, 실행 후 완료·대체·실패 기록, 완료된 문서 권한 철회 후 이전 화면 내용 제거를 검증한다.

실키/유료 호출·실제 모델 품질·공식 배포·서명은 이 검증에 포함하지 않는다.
