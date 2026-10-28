# 비공개 가져오기 정리 작업자

2026-10-28 서버 내부 구현 계약. 010 migration의 보존/정리 대기열을 소비하는 함수만 제공한다. 공개 HTTP endpoint, React Server Action, CLI, scheduler, import 시 자동 실행은 없다. 실제 Supabase DB/Storage 계정에서의 삭제는 수행하지 않았으며 운영 배치·실서비스 검증은 **unverified**다.

## 호출과 권한

서버 내부에서 `runConfiguredPrivateImportCleanup({limit?:number,signal?:AbortSignal})`를 호출한다. 기본·최대 limit은 5, 최소 1이며 초과를 조용히 자르지 않고 요청 전에 거부한다. 원래 RPC가 100개까지 허용하더라도 작업자는 5개만 요청한다. 서버의 기존 `authoringServiceClient`가 service credential, 구성된 origin, redirect 금지, HTTP 실제 응답 크기와 취소 신호를 적용한다. 브라우저가 bucket/path/owner/lease/secret을 지정하는 경로는 없다.

순수 경계 로직은 `runPrivateImportCleanup(repository,options)`, 운영 SDK 어댑터는 `configured.ts`다. repository는 서버가 공급하는 신뢰된 DB/Storage 어댑터이며 workflow 또는 사용자 확장 인터페이스가 아니다. 두 모듈은 `server-only`로 표시하고 `use server`를 선언하지 않아 클라이언트 호출용 Server Action으로 노출하지 않는다.

## 임대 레코드

`claim_private_import_cleanup(p_limit)` 반환 전체를 먼저 검사한다. 최대 limit개의 배열이며 다음 일곱 필드만 허용한다.

|필드|검사|
|---|---|
|jobId/importId/leaseId|소문자 UUID; batch 안에서 각각 중복 금지|
|bucket|정확히 `authoring-imports`|
|path|`<owner UUID>/<importId>/<expectedSha256>.zip`의 정확히 세 구간|
|expectedSha256|소문자 64자리 SHA-256|
|attempts|1~2,147,483,647 정수|

계정 삭제 후 owner 행이 없어도 원래 경로의 UUID는 보존된다. 첫 구간을 현재 요청 사용자로 바꾸거나 다른 계정에 재할당하지 않는다. `..`, URL, 인코딩한 슬래시, 추가 구간, 다른 import/hash, 임의 버킷·추가 키는 거부한다. 레코드는 복제·동결하여 await 중 호출자가 경로를 바꿀 수 없게 한다. 하나라도 잘못되면 전체 batch를 처리하지 않고 `claim_invalid`를 반환한다. 신뢰하지 못한 ID로 finish를 호출하지 않으며 임대는 DB 규칙에 따라 만료된다.

보존 기간, staging의 terminal 실패 전환, 아직 참조된 archive 제외, 5분 lease와 이전 lease 거부는 010 SQL의 책임이다. 작업자는 이 규칙을 우회하는 직접 테이블 쓰기를 하지 않는다.

## 객체 검증과 단일 삭제

1. 선택한 한 path를 GET한다. 실제 HTTP 404만 최초 `not_found`의 근거다. 403, 5xx, 부분 응답, 전송 실패, 빈 성공 응답은 부재로 간주하지 않는다.
2. HTTP 200 전체 body를 실제 스트림으로 SHA-256 계산한다. 원문은 1바이트 이상, 최대 32 MiB다. Content-Length만 신뢰하지 않고 실제 청크 합계를 제한한다. 압축 전송 길이와 디코딩된 길이를 구분하며, identity 응답은 선언 길이와도 일치해야 한다. ZIP을 풀거나 내용을 실행하지 않는다.
3. 전체 바이트 hash가 lease의 hash와 같고 취소/시간 한도를 넘지 않았을 때만 `storage.from('authoring-imports').remove([exactPath])`를 한 번 호출한다. 목록 조회·prefix 열거·재귀 삭제·다른 버킷 대체는 없다.
4. remove가 성공을 반환해도 완료로 간주하지 않는다. 같은 한 객체를 다시 GET하여 실제 404를 확인해야 `deleted`가 된다. 여전히 존재하거나 재확인 실패면 `retry`다. remove 결과가 불명인 경우에는 같은 batch에서 자동 재전송하거나 삭제 성공으로 바꾸지 않는다.
5. `finish_private_import_cleanup(p_job,p_lease,p_outcome)`를 한 번 호출한다. outcome은 `deleted`, `not_found`, `retry`뿐이다. DB는 lease 일치·만료·완료 outcome을 다시 검사한다.

설치된 storage-js 2.118.0에서 `StorageApiError.status`는 실제 HTTP 응답에서 오지만 `statusCode/code`는 응답 본문에서도 읽는다. 따라서 403 본문에 `statusCode:"404"`가 있어도 not_found로 처리하지 않는다. 공유 어댑터는 body가 없는 실제 HTTP 오류의 status를 보존한다. SDK는 이 경우 JSON 해석 실패 후에도 실제 status를 유지한다. 성공한 빈 객체는 허용하지 않는다.

작업자는 원래 업로드의 `upsert:false`와 내용 hash가 포함된 불변 경로 정책을 전제로 한다. GET/hash와 DELETE 사이에 Storage 객체 버전을 잠그는 분산 transaction이나 조건부 hash DELETE는 제공하지 않는다. 관리자·다른 privileged writer가 같은 경로를 다른 내용으로 덮어쓰면 이 불변 전제가 깨진다. 이후 404 확인은 객체 부재를 확인하는 것이며 전 세계의 동시 변경을 원자적으로 인증하는 절차가 아니다.

## 시간·취소·불명 결과

전체 invocation은 최대 120초이며 최초 100초만 claim/객체 처리에 사용한다. 남은 최대 20초는 finish에 사용하므로 5분 lease보다 짧다. 모든 작업은 순차 실행한다. 처리 시간이 끝나면 새 GET/DELETE를 시작하지 않고 남은 유효 시간에 해당·미처리 lease를 retry로 마무리한다. 전체 시간 또는 호출자 취소가 끝나면 새 finish도 호출하지 않는다.

SDK 호출에는 AbortSignal을 전달하고 별도 bounded await도 적용한다. 잘못된 transport가 abort를 무시해도 함수는 제한 시간에 반환한다. 이것이 이미 전송한 삭제를 되돌리거나 원격 실행 중단을 증명하지는 않는다. 삭제가 시작된 뒤의 오류/시간 초과는 `storage:"unknown"`으로 남기고 자동 성공·환급·재전송하지 않는다. 늦은 원격 결과가 생길 수 있으며 다음 DB lease가 해당 정확한 객체의 상태를 다시 확인한다.

삭제 확인 뒤 finish가 실패한 경우도 전체 완료가 아니다. 다음 임대에서 객체 GET이 404이면 새 lease로 not_found를 확정할 수 있고 이전 DELETE를 다시 호출할 필요가 없다. DB가 반환한 retry는 한 시간 뒤 재시도 대상이며 작업자가 자체 반복 루프를 만들지 않는다.

## 반환과 관측

`CleanupReport`는 `status,claimed,jobs,code?`다. jobs는 `jobId,outcome,storage,finalization,code?`만 포함한다.

|값|의미|
|---|---|
|completed|모든 객체의 부재를 확인했고 모든 finish 응답을 확인함; 빈 batch도 포함|
|retry_required|하나 이상 retry이며 모든 finish를 확인함|
|attention_required|하나 이상 finish 미확정 또는 미시도; 삭제 여부와 DB 기록을 따로 확인해야 함|
|claim_failed / claim_invalid|claim 결과가 불명 또는 레코드 불일치; 객체 삭제 없음|
|storage=absent / not_deleted / unknown|확인된 부재 / 삭제를 시작하지 않음 / 시작한 삭제의 결과를 확정하지 못함|
|finalization=confirmed / unconfirmed / not_attempted|DB 응답 확인 / 호출했으나 확정 못함 / 총 시간·취소 때문에 호출하지 않음|

raw path, owner ID, source bytes/hash, key, SDK/DB 원문 오류는 반환·로그에 넣지 않는다. 새 로그·모니터·자동 알림은 추가하지 않았으며 후속 운영 호출자는 이 안전한 projection만 기록해야 한다. 상세 실패 코드는 고정된 `CLEANUP_*` 값이다.

## 검증 범위

`tests/security/private-import-cleanup.test.ts`는 실제 SHA-256와 Web ReadableStream을 사용한다. 실제 설치 Supabase SDK를 HTTP 대역에 연결하여 정확한 RPC/GET/단일 DELETE/재GET/finish와 실제 HTTP status 분류를 확인한다. 가짜 운영 키·Storage나 실제 계정의 파일을 사용하지 않는다. 정상 경로, 닫힌 lease, 중복/잘못된 path, 32 MiB 경계, 잘린/오류 스트림, false404, 빈404/200, 해시 불일치, 결과 불명, 100/120초, 취소, finish 실패와 새 lease 복구를 검사한다.

010 DB의 실제 SQL lease/보존/참조 보호 시험 및 기존 개인 복사 HTTP 회귀는 별도로 함께 실행한다. 이 로컬 검증을 실제 Supabase 권한·네트워크·동시 실행·운영 삭제 증거로 표시하지 않는다. 운영 스케줄 연결 전에는 서버 자격증명/버킷 불변성·감사·경보·실서비스 복구 시험이 필요하다.
