# 공개 배포·검수·신고 저장 규칙

P4-01의 데이터베이스 기반이다. 실제 scanner, 서명·Storage 업로드, 검수 UI, 사용자 공개·복사 경로와 연결되기 전에는 P4 완료가 아니다.

## 소유권과 불변 대상

`publication_submissions`는 소유자가 명시적으로 제출한 불변 프로젝트·자료 버전의 사본을 보존한다. 원본의 ID는 추적 정보이고, 비공개 원본 삭제가 제출 사본이나 이미 검수한 배포물을 바꾸지 않는다. 비공개 Storage 파일과 전이 자료까지 검수 후보에 고정하는 것은 scanner의 책임이다. 파일을 고정할 수 없으면 검사 실패로 처리한다.

검수자는 제출한 후보만 볼 수 있다. 관리 역할을 가진다는 이유로 모든 비공개 프로젝트·자료에 접근하지 않는다. 역할은 `studio_roles`에 운영자가 부여하며 일반 사용자에게 역할 쓰기 권한이 없다.

## 상태와 권한

| 전이 | 주체 | 필수 조건 |
|---|---|---|
| private revision → submitted | 소유자 | 자신의 불변 버전, 제출 시 사본 고정 |
| submitted → scanned 또는 changes_requested | 검사 작업 서비스 | 정확한 ZIP·manifest 해시, 이용 조건·의존성·비밀정보 검사 증거 |
| scanned → approved/rejected | reviewer/administrator | 현재 검사한 ZIP 해시와 일치하는 결정·사유 |
| approved → published | 배포 작업 서비스 | 검수·검사·업로드 ZIP 해시 일치, 별도 서명·업로드 완료 |
| published → suspended/revoked | moderator/administrator | 조치 사유와 감사 기록 |
| suspended → published | moderator/administrator | 원본 배포물 유지, 복구 사유 |
| revoked → published | 허용하지 않음 | 새 제출·검사·검수 필요 |

서비스 전용 RPC를 사용자 인증 토큰으로 호출할 수 없다. 배포자의 클라이언트가 `passed: true`를 제출하는 것만으로 검사를 통과하지 못한다. 검사 서비스의 자격증명은 브라우저에 전달하지 않는다. 공식 표시에는 administrator가 검수한 동일 배포물이 필요하며, 공식 예제의 실제 사용 증거는 카탈로그 gate에서도 별도로 확인한다.

`public_releases`는 공개 상태의 메타데이터만 익명 조회를 허용한다. 다운로드 서비스는 요청할 때마다 현재 공개/철회 상태를 다시 검사하고, 정확한 artifact hash에 대응하는 파일만 전달해야 한다. 현재 SQL 기반은 다운로드·서명 자체를 수행하지 않는다.

신고는 특정 release ID에 연결한다. 접수만으로 자동 숨김/삭제하지 않으며 신고자는 자기 신고만 볼 수 있다. 조치 기록은 추가형 감사 테이블에 남는다. 이의 신청·보존 만료·탈퇴 익명화·검수 큐 재처리는 후속 P4 운영 작업이다. Auth 사용자 참조가 있는 감사/배포 기록을 삭제 없이 보존할지 익명화할지는 그 작업에서 완성한다.

## 실제 검증 범위

`tests/database/publications.test.ts`는 PGlite의 실제 PostgreSQL에 001/002 migration을 적용한다. 타인 버전 제출·역할 상승·클라이언트 검사/게시를 거절하고, 검수 후 해시 교체·공식 표시 권한·철회 후 재게시 우회·비공개 원본 삭제 독립성을 검사한다.

Auth 사용자 주입과 scanner 결과만 테스트 경계 대역이다. 이 시험을 Supabase Auth/Storage HTTP 연결, 악성코드 검사, 서명 발급 또는 실제 서비스 게시의 성공 증거로 사용하지 않는다. PostgreSQL WASM 사용 방식은 [PGlite 공식 API](https://pglite.dev/docs/api)를 따른다.
