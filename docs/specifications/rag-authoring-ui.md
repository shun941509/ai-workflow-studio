# RAG 편집·임베딩 연결 UI 계약

## 지원 범위

- 편집기는 현재 실행의 문서 색인 `knowledge.build/open`과 `retrieval.keyword/vector/hybrid`를 제공한다. 혼합 검색은 RRF만 지원한다.
- 지식 색인은 `local-run-keyword-v1` 또는 `local-run-embedding-v1`을 명시한다. 벡터·혼합 색인의 `embeddingProfile`은 프로젝트의 `kind: embedding` 선언을 참조한다.
- 원문은 TXT·Markdown·JSON, 파일당 2 MiB, 색인당 32파일·총 8 MiB이다. 임베딩 색인은 최대 128조각이며 `text-embedding-3-small`, 256차원으로 고정한다. 이 수치는 허용 상한이며 모든 조각 크기의 조합이 실행 가능하다는 약속이 아니다. Runner의 토큰·바이트·전체 예산 검사를 추가로 통과해야 한다.
- 색인 생성 시 원문 조각, 벡터·혼합 검색 시 검색어가 OpenAI로 전송되며 사용 요금이 발생할 수 있음을 편집기와 Runner에 표시한다. 키워드 단계 자체는 임베딩을 호출하지 않는다. 이후 AI 작업의 전송 여부는 별도이다.
- 검색 결과 다시 정렬은 별도 고정 Responses 역할로 선택 제공하며 세부 규격은 `reranker-ui.md`를 따른다. Agentic RAG, 그래프 검색, 외부 색인, 필터 등 아직 편집하지 않는 설정은 닫힌 편집기 검사로 차단한다. Runner가 해당 기능을 추가하더라도 고급 JSON 가져오기를 통해 편집기 지원 범위가 자동 확장되지 않는다.

## 문서 검색용 연결 추가

`문서 검색용 연결 추가` 버튼은 사용하지 않는 `embedding_default`, `embedding_2` 등의 식별자를 정한다. 비전문가가 영문 ID를 입력할 필요가 없다. 고급 설정에서만 선택적으로 직접 지정할 수 있다. 실제 한글 연결 이름과 API 키는 Runner에서 입력한다.

추가 동작은 전역 `modelProfiles` 선언과 현재 흐름의 해당 노드 참조를 한 번의 초안 변경으로 적용한다. 실행 취소·다시 실행도 두 값을 함께 복원한다. 기존 선언·공유 참조를 덮어쓰거나 삭제하지 않는다. 이름 충돌은 명시적인 오류다.

`workflow.json`의 실행 형식과 `editor.json`의 한글 하위 흐름 이름·위치 형식은 변경하지 않는다. 흐름별 노드 ID 격리와 전체 초안의 저장·재열기·3종 ZIP 보존을 그대로 사용한다.

대화·분류·에이전트의 모델 선택에는 `kind: chat` 선언만 표시한다. 임베딩 선택에는 `kind: embedding`만 표시한다. 가져온 참조가 없거나 종류가 다르면 그 원래 값을 오류 옵션으로 남긴다. 화면을 보는 것만으로 다른 연결을 자동 선택하지 않는다.

## 모드 변경과 원본 보존

가져온 미지원 모드·설정은 자동으로 키워드 설정으로 바꾸지 않는다. 미지원 옵션을 보여 주고 다운로드를 차단한다. 일반 수치 수정은 나머지 설정을 보존한다. 사용자가 모드 선택기를 직접 바꿀 때에만 해당 모드의 닫힌 설정으로 변경한다.

혼합 설정은 `keywordTopK`, `vectorTopK`, `candidateLimit`, `fusion: {method: rrf, k}`를 편집한다. 합친 후보 상한은 최종 결과 수 이상이어야 한다. 결과 바인딩은 세 지원 검색 모드 모두 `/data/context`, `/data/citations`, `/data/candidates`, `/data/index`를 사용한다.

## Runner 연결과 패키지 준비

패키지 상세의 `modelRequirements`와 `modelProfiles`에는 모든 포함 흐름에서 실제로 참조하는 alias만 들어간다. 사용하지 않는 선언 때문에 인증정보를 요구하지 않는다. 서비스 소유의 메타데이터 계약은 다음과 같다.

```ts
type ModelRequirement = {
  alias: string;
  kind: 'chat' | 'embedding' | 'reranker' | null;
  requiredFeatures: string[];
  constraint?: {
    contractId: string;
    provider: 'openai';
    model: 'text-embedding-3-small';
    dimensions: 256;
    maxChunks: 128;
  } | {
    contractId: string;
    provider: 'openai';
    model: 'gpt-5.4-mini-2026-03-17';
    maxCandidates: 20;
    maxInputBytes: 65536;
    maxOutputTokens: 4096;
  };
};
```

- 로컬 저장 연결의 `kind` 누락만 이전 버전의 `chat`으로 취급한다. `reranker`와 다른 알 수 없는 종류는 대화 연결로 취급하지 않는다.
- `kind: null`은 선언 누락으로 선택기를 제공하지 않는다. `reranker`는 일치하는 고정 계약과 별도 역할의 저장 연결이 있어야 선택할 수 있다. 알 수 없는 종류·계약은 준비 오류로 차단한다.
- 필요한 메타데이터가 없거나 alias 목록이 불일치하거나 임베딩 규격이 다르면 실행을 열지 않는다. 서비스 준비 검사와 시작 검사가 최종 권한을 가진다.
- 저장 요청은 `name`, `kind`, `model`, `apiKey`만 보낸다. 임베딩의 차원·주소·토크나이저 등 변경 불가능한 값은 전송하지 않는다. 키 저장과 준비 검사는 모델을 호출하지 않는다.
- 패키지 화면은 메뉴 이동 중에도 마운트 상태를 유지하여 선택 패키지·작성 입력·선택 연결을 보존한다. 인증정보와 ZIP 원문을 브라우저 저장소에 추가로 저장하지 않는다. 연결 화면을 벗어나면 저장하지 않은 키 입력은 버린다.
- 연결 편집·새 패키지 선택·프로필 갱신·화면 이동은 준비 결과를 무효화한다. 진행 중인 준비 요청에는 단조 증가하는 식별자를 붙인다. 이전 응답이 늦게 도착하거나 연결을 바꿨다가 원래대로 돌려도 실행 준비가 되살아나지 않는다. 최신 상태로 다시 확인해야 한다.

## 검증

- `tests/editor/rag-authoring.test.ts`: 세 모드 설정, 원본 불변성, 선언·참조의 원자적 변경, 충돌, 결과 위치, 숨은 하위 흐름의 미지원 설정 차단.
- `tests/contracts/runner-ui-connections.test.ts`: 연결 종류·고정 모델 필터, 누락/미지원 메타데이터 차단, 이전 버전 chat 호환, 사용하지 않는 alias 제외, 응답 경쟁 무효화.
- `tests/e2e/rag-authoring.spec.ts`: 실제 Chrome에서 영문 ID 입력 없이 벡터→혼합 설정, 실행 취소/다시 실행, 저장·재열기, 3종 ZIP 실제 검사, 미지원 그래프 설정 보존.
- `tests/integration/check-runner-rag-ui.ts`: 운영 UI 빌드와 실제 로컬 HTTP/SQLite를 사용한다. 3종 ZIP 가져오기, 키 없는 상태, 임베딩 연결 저장, 화면 왕복, 실제 준비 응답을 지연한 경쟁을 확인한다. 인증 저장소와 공급자만 테스트 내부 대역이며 호출 시 실패하도록 구성한다. 모델 호출 0·실행 시작 0을 확인한다.
- 실제 OpenAI 계정·네트워크 성공·검색 품질은 이 UI 검증으로 증명하지 않는다. 정식 배포·서명·라이선스 게이트는 별도로 유지한다.
