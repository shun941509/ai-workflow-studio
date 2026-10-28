# Runner 업무 문맥 표시

실행 상세의 **업무 문맥과 전달 상태**는 R07 원장에 실제로 기록한 업무 문맥만 표시한다. 준비 기록, 계량 호출 의도/응답, 생성 호출 의도/응답/불명을 구분한다. 이 카드는 업무 완료 판정이나 외부 서비스의 독립 수신 증명이 아니다. 내용의 정확성과 사용자 검토는 별도 완료 기준에서 확인한다.

## 표시 범위

- 기본 보기: 해당 수행 블록, 선택/제외 자료 수, 계량/생성 상태, 결과 불명 경고.
- 펼친 보기: 자료 목적·용도·필수 여부, 고정 ID/revision/resource.json 원본 해시, 파일별 포함/제외 이유·바이트 크기·원본 해시, 요청 및 출처 기록 해시, 모델명, 준비/갱신 시각, 실행 시도 ID.
- 요청/응답 본문, 사용자 원문, 문서 본문, 키, 전체 manifest JSON은 표시하지 않는다. 문맥 카드에는 내려받기 기능이 없다. 사용자가 작성한 자료 목적과 파일 이름 등 출처 메타데이터는 표시 대상이며 익명화된 데이터라고 주장하지 않는다.
- 현재 범위는 `task_fixed_attachments`다. 검색 문서와 다른 블록의 전체 입력을 모두 추적한다고 해석하지 않는다. Skill의 코드 실행은 이 화면의 포함 표시만으로 승인되지 않는다.
- 없거나 아직 준비되지 않은 기록은 카드를 생성하지 않는다. 응답이 일부만 반환되면 `workingContextCount` 전체 수와 표시 수를 함께 안내한다.

## HTTP 및 개인정보 경계

`status/results`의 `workingContexts: unknown`, `workingContextCount: unknown`을 검증 전 데이터로 취급한다. 아직 공통 Schema가 없는 서버 runtime DTO를 앱간 import로 참조하지 않는다. `working-context-presentation.ts`가 정확 키, 버전, 열거 상태, 양의 revision, SHA-256, run/nodeInstance 연결, 상태별 count/reservation 연결, 중복 ID/alias/path, 자료·파일 선택 관계, 기록 최대 100개, manifest 256 KiB, 합계 512 KiB를 검증한다. 순환·getter·숨은 속성·잘못된 Unicode·크기/깊이 초과도 거부한다. 실패하면 전체 metadata를 숨기고 확인 필요를 표시한다.

이는 클라이언트 형식 검사다. 원본 바이트·계획·SQLite·실제 공급자 원장과의 대조는 서버 책임이다. 클라이언트가 해시 문자열만으로 암호학적 출처를 새로 인증한다고 주장하지 않는다. 향후 runtime DTO를 공통 Schema로 승격하면 서버/클라이언트 검사를 함께 단일화한다. 현재 브라우저 코드는 정적 검사만 사용하므로 CSP에 `unsafe-eval`이 필요하지 않다.

기존 disclosure epoch를 유지한다. 권한 철회/확인 불가 응답, 결과 내려받기의 권한 거절, 페이지 이동 뒤 늦은 응답은 기존 내용을 다시 표시하지 못한다. `withoutRunContent`는 history와 현재 캐시에서 문맥 배열/건수도 `[]/0`으로 제거한다. 해당 페이지에서 카드·이전 결과·다운로드 동작을 숨긴다. 이미 사용자가 저장한 외부 파일을 원격 삭제한다는 의미는 아니다.

## 전용 검증

- `tests/contracts/runner-ui-working-context.test.ts`: 준비/계량/생성 상태 구분, unknown 입력, 본문 필드 추가, 링크/해시/중복/크기 불일치, getter/순환, 캐시 제거.
- `tests/integration/check-runner-working-context-ui.ts`: 실제 production UI + 엄격 CSP + HTTP + SQLite + 3종 ZIP을 사용한다. 테스트 디렉터리의 공급자/키 저장 경계만 내부 대역이며 외부 모델 요청은 0회다. 준비·계량 중, 계량 실패, 생성 불명, 응답 확인, 자료 펼침, 본문 부재, 내려받기/폴링/재방문의 권한 차단을 Chrome에서 확인한다.
- 운영 예제나 120+120 공식 카탈로그, 실제 호스트·실제 모델 검증 상태는 이 작업으로 변경하지 않는다.
