# 고정 자료 선택과 편집기 보존

자료 목록은 `GET /api/resources?cursor=...`의 메타데이터만 사용하며 페이지당 최대 40개를 명시적 ‘더 보기’로 불러온다. 검색은 불러온 항목에만 적용된다고 표시한다. 각 항목에는 최근 100개 버전까지만 선택지가 있고 `versionsTruncated`가 참이면 잘린 이력을 안내한다. 고정한 이전 버전을 최신 버전으로 자동 교체하지 않는다.

내용 확인·연결은 선택한 계정 자료 ID와 정확한 계정 버전 UUID의 detail을 읽는다. 요청 세대와 AbortController, 블록·흐름별 컴포넌트 key로 이전 요청이 다른 버전이나 블록에 적용되지 않도록 한다. 중복 클릭은 동기 잠금으로 막는다. 실패 응답은 본문이나 ZIP 성공으로 표시하지 않는다.

## 서로 다른 세 가지 식별자

- 자료 별칭은 workflow.resources의 키와 블록의 연결 값이다.
- ResourceRef.id는 불변 원본 descriptor의 ID다. 복사한 자료에서는 별칭과 다를 수 있다.
- 계정 자료 ID·버전 UUID는 소유권 조회용이다. `resourceBindings[원본 별칭] = 계정 버전 UUID`로 서버에 전달한다.

계정에서 직접 작성한 text 형식은 자료 ID·별칭·descriptor ID가 계정 자료 UUID인 기존 규격을 유지한다. 복사한 자료는 의존 자료 유무와 관계없이 archive_v1이다. 브라우저가 목록 메타데이터로 ResourceRef나 원본 해시를 새로 만들지 않는다.

detail의 `refs`, `resourceBindings`, `resourceDependencies` 전체를 첨부한다. 선택한 루트는 버전 UUID와 정확한 ResourceRef가 함께 일치하는 별칭으로 결정한다. 같은 별칭의 다른 원본·계정 버전·의존 관계는 충돌 오류다. 현재 연결 UI는 instruction/document만 소비한다. Skill·MCP는 파일 목록과 이용 조건을 읽고 원본 자료 ZIP으로 활용하며 이 화면에서 실행하지 않는다. HTML·코드·바이너리는 미리 실행하거나 렌더링하지 않는다.

## 제거, 이력, 저장

직접 사용된 루트의 이전 전이 의존 집합에서 변경 후 사용 집합을 뺀 자료만 정리한다. 다른 흐름에서 공유하는 의존 자료와 의도적으로 남겨 둔 미참조 pin은 보존한다. 마지막 사용 루트가 해제되면 함께 들여온 의존 자료와 계정 binding도 정리한다. 의존 그래프 없는 기존 초안에서는 직접 사용만 계산하고 관계를 추측하지 않는다.

고정 부모가 계속 사용하는 자식 자료를 같은 별칭의 다른 원본으로 교체하면 거절한다. 설계 JSON 적용 오류는 창 안에 표시하고 이전 초안을 보존한다. undo/redo·브라우저 저장·계정 프로젝트 재열기는 자료 binding과 의존 그래프를 같은 초안 스냅샷으로 보존한다.

계정 저장, workflow ZIP, materials ZIP 요청에는 `resourceBindings`를 보낸다. 서버는 이를 권한 증명으로 신뢰하지 않고 계정 소유권·불변 descriptor·원본 bytes를 다시 검사한다. `resourceDependencies`는 서버가 원본 descriptor로부터 만든 UI용 메타데이터다. 계정 UUID binding·의존 그래프·복사 origin은 workflow.json이나 editor.json에 삽입하지 않는다. 원본 ZIP의 자료 descriptor와 본문 bytes는 유지한다.

복사 origin은 packageId/version·파일 SHA-256·복사 시각만 허용 목록으로 표시한다. storage_path와 알 수 없는 내부 필드는 표시하지 않는다. 복사본 소유권과 원본 게시 상태, 실제 실행 준비 상태는 별개다.

## 검증 범위

`tests/editor/resource-state.test.ts`는 전체 흐름 참조·공유 의존성·마지막 해제·충돌·JSON 변경·브라우저 저장과 실제 세 호스트 ZIP의 원본 bytes를 검사한다. `resource-client.test.ts`는 페이지 상한·고정 버전·잘못된 preview·서버 거절을 검사한다.

`tests/e2e/resource-authoring.spec.ts`는 실제 제품 React 구성요소를 Chrome으로 조작한다. 테스트 전용 서버만 외부 계정 HTTP를 대체하며 실제 descriptor와 package-kit으로 ZIP을 만든다. 123개 명시적 페이지, 늦은 응답, 블록 전환, 이력·저장·재열기, 세 호스트 ZIP, Skill 읽기 전용, 100개 버전 제한, 미설정 상태를 검증한다. 이 시험은 실제 Supabase Auth/RLS 또는 실제 외부 계정 연결 성공을 주장하지 않는다. 제품 설정은 바꾸지 않으며 모델 호출은 없다.
