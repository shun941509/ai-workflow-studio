# 공개 ZIP 전달 계약

이 범위는 기존 게시물의 검증된 ZIP 전달 API다. 게시·서명 발급·키 생성·외부 업로드·프로젝트 복사를 수행하지 않는다. 실제 공개 파일이나 서버 연결이 없으면 성공 자료를 만들지 않는다.

## 고정 원본과 권한

다운로드는 로그인한 사용자의 명시적 GET `/api/publications/:id/download` 요청에 제공한다. 공개 목록은 기존 익명 metadata 조회를 유지한다. 사용자 ID는 Auth `getUser`로 확인하며 browser가 보낸 경로·해시·공개키·passed flag는 받지 않는다. query·Range·호스트 재생성 옵션은 거절한다.

최종 `manifest.sig`를 포함한 ZIP의 원본 SHA-256을 candidate→scan→rights→review→release→delivery에서 유지한다. 서명 추가나 호스트 변환으로 바이트를 바꾸려면 새 검사·검수가 필요하다. 하나의 delivery는 원래 호스트 ZIP 하나다. 서명은 작성 주체의 증거이며 승인이나 완전한 안전성 증거가 아니다.

008의 `publication_signing_keys`는 패키지 밖에서 운영자가 관리하는 별도 신뢰 목록이다. key ID·Ed25519 공개키 PEM·DER SHA-256·유효 시작/종료·철회를 기록한다. 공개키/기간은 등록 뒤 바꾸지 않으며 철회는 되돌리지 않는다. 교체는 새 key ID를 사용한다. 일반 사용자/reviewer는 조회·변경할 수 없다. 비밀 서명키는 저장하지 않는다.

`publication_delivery_artifacts`는 release·원본 ZIP/manifest 해시·크기·서명 key ID/hash·호스트·private Storage 경로를 고정한다. 등록 RPC는 service-only이며 현재 게시/후보/검사/검수/권리와의 일치를 검사한다. 실제 파일 검증을 대신하지 않으며 브라우저의 검증 주장도 받지 않는다.

## 실제 전달 순서

1. 서버 전용 Supabase secret 설정과 Auth 세션을 확인한다. 미설정은503, 미인증은401이다. 비밀키는 서버 환경에만 두며 공개 NEXT_PUBLIC 변수·ZIP·응답·로그에 넣지 않는다.
2. service-only `resolve_publication_delivery`가 현재 published 상태,007의 현재 권리 근거, 고정 candidate/scan/review/release/delivery 해시, 유효한 서명키를 다시 검사한다. Storage 경로와 신뢰키는 서버 내부에만 전달한다.
3. private `publication-releases` bucket에서 등록된 원본 파일만 읽는다. 경로는 `releases/<submission UUID>/<artifact SHA-256>.zip`이다. 임의 URL·redirect·OS 경로를 사용하지 않는다. 긴 signed URL이나 공개 bucket을 제공하지 않는다.
4. 실제 읽은 바이트를 최대32MiB로 제한하고 등록 크기·원본 ZIP SHA-256·원본 manifest SHA-256을 대조한다. `inspectPackage(requireSignature: true)`로 외부 신뢰키 서명·고정 파일·운영 구성·capability·의존을 검사한다. 압축 해제는 메모리 검사이며 파일이나 코드를 실행하지 않는다.
5. 파일 읽기·검사 후 service-only 조회를 다시 수행한다. 게시 상태/현재 권리/현재 서명키를 재검사하며 경로·해시·크기·호스트·키·보고서가 최초 조회와 같아야 한다. 검사 중 철회·만료·키 변경은 전달을 차단한다.
6. 그 뒤 원본 ZIP을 attachment로 반환한다. `Cache-Control: private, no-store`, `Content-Type: application/zip`, `X-Content-Type-Options: nosniff`, 안전한 release ID 기반 파일명을 적용한다. Storage 경로·인증정보·원본 snapshot은 노출하지 않는다.

HTTP 압축 응답은 Fetch가 해제한 실제 stream을 제한한다. `Content-Encoding`이 있으면 원래 `Content-Length`가 압축 바이트 길이일 수 있으므로 해제된 길이와 같다고 가정하지 않는다. Identity 응답은 선언 길이도 대조한다. 실제 로컬 gzip HTTP 응답으로 정상 수신과 해제 후 초과를 확인한다.

상세 화면의 ‘운영 ZIP 다운로드’는 준비 상태·인증/철회 오류를 표시하고 중복 요청을 막는다. 브라우저도 받은 바이트의32MiB 상한과 표시한 공개 버전 SHA-256을 대조한 뒤 고정된 파일명으로 저장한다. API 오류나 해시가 다른 파일은 ZIP 다운로드 성공으로 표시하지 않는다. 페이지를 떠나면 진행 중인 요청을 취소한다.

마지막 현재 상태 조회가 이번 전달의 권한 확인 시점이다. 그 전에 발생한 철회는 차단한다. 이미 클라이언트로 전달된 바이트를 원격 삭제하거나 마지막 확인 직후 시작된 네트워크 전송을 완전히 회수한다고 주장하지 않는다. 새 요청은 다시 확인한다. 이 단계는 Range/304/CDN 캐시 없이 전체 바이트를 검증한다.

## 한도와 오류

원본 ZIP32MiB, 파일2000개, 개별 해제8MiB, 총 해제64MiB, manifest1MiB를 제한한다. DB/Storage 요청과 전체 전달 준비에 timeout/cancellation을 적용하고 한 서버 프로세스의 동시 준비 수를 제한한다. 공급자 오류의 URL·응답·secret은 사용자에게 반환하지 않는다. 검사 실패/현재 상태 불일치/알 수 없는 결과를 다운로드 성공으로 바꾸지 않는다.

## 검증 범위

실제 PostgreSQL migration 권한·키 기간/철회·원본 고정과 실제 로컬 서명 ZIP 검사·변조·읽는 도중 철회·마지막 조회 경쟁을 시험한다. 외부 네트워크/계정은 테스트 대역 경계이며 실제 Supabase Auth/Storage 연결 및 실제 공개 파일 다운로드 완료를 주장하지 않는다. 공식 runtime resolved lock과 실제 호스트 사용 증거는 별도 출시 gate다.
