# Studio 웹 편집기

운영 설계를 작성하고 Codex·Claude Code·OpenCode용 개인 ZIP을 생성한다. 실제 실행, 모델 인증정보, 사용자 질문·검토 응답은 Studio Runner에서 처리한다. 웹에 모의 실행 또는 개발용 다운로드 모드는 없다.

현재 편집 범위는 input, form, ai, classify, output, resource, transform, condition, merge, guardrail, evaluate, error, review의 13개 타입이다. `src/features/editor/editor-contract.ts`가 브라우저와 서버 ZIP의 범위를 함께 검사하며 Registry의 입력·제어 포트를 사용한다. evaluate는 규칙 모드, output은 text/json을 제공한다. 중첩 흐름·subworkflow/loop/parallel, 모델 평가 편집, 파일 결과 편집은 명시적으로 차단한다. 이 제한은 Runner 전체의 capability를 뜻하지 않는다.

## 작성 흐름

- 왼쪽 분류별 블록 추가 → 가운데 연결점 또는 오른쪽 다음 작업 선택 → 기본 설정과 입력·결과 선택.
- 입력·응답 형식은 항목 폼, 조건은 비교·논리 트리, 변환은 순서가 있는 7종 DSL 폼으로 작성한다. 원문 JSON은 접힌 고급 설정에서 선택적으로 편집한다.
- 합류는 활성 경로를 기다린다. 비활성 경로의 참조는 누락 시 제외로 설정한다. 검토의 accepted/rejected와 분류 라벨은 서로 다른 연결점이다.
- AI의 지침/문서 첨부와 자료 읽기는 고정 자료 버전을 공유한다. 자료 읽기는 config.resource를 사용하고 AI 첨부로 가장하지 않는다. 마지막 사용을 해제하면 ZIP 의존성에서도 제거한다.
- 초안 저장은 브라우저 복구 사본과 실제 계정 저장을 구분한다. JSON·스키마·의미·모드 검사와 실제 자료 본문 해석이 실패하면 ZIP 성공으로 표시하지 않는다.

## 검증 경계

`tests/editor/editor-contract.test.ts`는 Registry 일치, 제어 포트, 부분 모드 차단, AST/DSL/보호 규칙 검사, 고정 자료 교체/해제 경계를 검증한다.

`tests/e2e/studio-web.spec.ts`는 실제 Chrome으로 기존 메뉴/편집/복구/3종 ZIP 회귀, JSON 없이 조건 diamond 및 합류 작성, 질문 및 사용자 검토, 분류·보호·평가·오류 복원, 서버 우회 모드 차단을 검사한다. ZIP 바이트와 workflow.json을 실제 서버 응답으로 확인한다. 테스트 대역을 제품에 포함하지 않는다.

실계정이 없는 로컬 환경에서는 자료 목록·본문 다운로드의 성공 E2E를 주장하지 않는다. 준비 차단을 검증하고, 실제 본문 물질화/해시 검사는 서버 모듈 시험에서 별도로 다룬다. 모델 실행·사용자 검토 재개·외부 호스트 연결의 증거는 Runner 및 호스트 시험에서 제공해야 한다.

로컬 검증 예: 고정 Node24로 `tooling/run-pnpm.mjs --filter @studio/web dev --port 3101`, 다른 터미널에서 `STUDIO_WEB_TEST_URL=http://127.0.0.1:3101`을 설정하고 `tooling/run-pnpm.mjs exec playwright test -c tests/e2e/studio-web.config.ts`. 기존 3100 운영 미리보기와 별도로 실행하며 자신이 시작한 서버만 종료한다.
