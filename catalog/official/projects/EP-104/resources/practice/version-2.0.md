# 가상 북극 문서 API 2.0 — 목록 조회 계약

문서 ID: POLAR-LIST-2.0
API 버전: 2.0
원작 가상 기술 문서입니다. 실제 서버나 호출 가능한 주소는 제공하지 않습니다.

## B1 목록 요청
계약상 목록 경로는 GET /v2/documents입니다. 첫 요청은 cursor를 생략합니다. limit은 1~100이며 기본값은 25입니다. page와 page_size는 지원하지 않으며 함께 보내면 LEGACY_PARAMETER입니다. 실제 서버를 호출하는 예제가 아닙니다.

## B2 응답과 다음 페이지
응답은 items 배열, next_cursor, snapshot_id를 포함합니다. 각 항목에는 id, title, modified_at이 있습니다. next_cursor가 null일 때만 페이지 탐색이 끝납니다. 다음 요청은 받은 cursor를 수정하지 않고 사용하며 같은 snapshot_id를 유지해야 합니다.

## B3 스냅샷 제한
커서가 EXPIRED_CURSOR이면 현재까지 수집한 결과를 완전 목록으로 표시하지 않습니다. 이전 cursor와 새 첫 요청의 결과를 임의로 합치지 않습니다. 스냅샷 만료 시간의 수치는 이 문서에 없습니다.

## B4 권장 이전 점검
1.0 응답의 documents와 updated_at을 사용하는 소비자가 2.0의 items와 modified_at을 읽는지 확인합니다. 페이지 종료 조건은 숫자 비교에서 next_cursor=null 확인으로 달라집니다. cursor는 불투명한 값이며 사용자가 새로 만들어 넣지 않습니다. 인증 방식·할당량·요금·서비스 주소는 명시하지 않습니다.
