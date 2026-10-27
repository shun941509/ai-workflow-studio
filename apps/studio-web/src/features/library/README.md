# 공개 자료실 경계

4개 목록은 community/official × project/resource의 서로 다른 조회이다. 브라우저는 게시된 제목·설명·종류·공개 시각·해시만 받는다. source_snapshot, owner_id, submission_id, storage_path는 API와 직접 DB 조회 양쪽에서 차단한다. 마이그레이션003의 column grants와004의 SECURITY INVOKER 검색 RPC를 함께 적용해야 한다.

`GET /api/publications?kind=project|resource&collection=community|official&q=...&cursor=...`는 최대24개와 다음 cursor를 반환한다. 검색은100자 이하 제목의 대소문자 무시 부분 일치이며 `%`, `_`, 인용부호도 일반 문자로 처리한다. cursor는 검색 조건 digest와 정확한 UTC microsecond 시각·UUID 쌍에 고정된다. DB도 최대25개 lookahead, query 길이, cursor 쌍을 독립 검증한다.

`GET /api/publications/:id`는 같은 kind/collection을 요구하고 현재 published 상태를 다시 확인한다. 조회는 anonymous RLS client를 사용하여 관리자의 비공개 검수 권한이 공개 목록으로 섞이지 않는다. 모든 응답은 no-store이고 화면은 새로고침·다시보기·visible focus·60초 주기마다 재확인한다. 조회 실패 때 이전 항목을 계속 표시하지 않는다.

`POST /api/publications/:id/reports`는 동일 Origin,20,000 bytes 이하 JSON, reason10~4,000 Unicode code points, 실제 검증된 로그인과 기존 report_release RPC를 사용한다. reporter ID는 요청에서 받지 않는다. 브라우저는 실제201 응답 이후에만 접수 사실을 표시한다. 신고는 자동 숨김이나 검수 완료를 의미하지 않는다.

공개 파일 전달·이용 권한·개인 복사 파이프라인은 아직 연결하지 않았다. 따라서 복사/다운로드 버튼을 제공하지 않는다. Supabase 미설정은 공개 항목0개 성공으로 표시하지 않고 연결 준비 상태로 표시한다. 서비스 역할 키나 외부 계정 생성은 필요하지 않으며 추가하지 않았다.

검증: `tests/database/discovery.test.ts`는 실제 PostgreSQL(PGlite)에001~004 마이그레이션을 적용하여 검색, cursor, RLS, column grants, 신고 본인성, 공개 중단을 검증한다. 이 테스트 DB의 seed는 외부 검수·업로드 성공을 뜻하지 않는다. `tests/e2e/publications.spec.ts`는 별도3101 Chrome에서 실제 로컬 API의 미설정·출처·요청 경계와 화면을 검사한다. 일부 카드/인증 오류 화면은 테스트 파일 안의 transport fixture이며 실제 Supabase 연동 성공 증거로 집계하지 않는다.
