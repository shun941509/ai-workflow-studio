# 공개 프로젝트·자료의 독립 복사 계약

2026-10-28 단계별 구현 계약. 원본 보존 스냅샷, 별도 복사·수정 권리 서명, 현재 권리 조회, private staging/read-back, 원자 commit SQL, 복사 API·상태 조회·버튼을 구현했다. 복사한 자료의 원본 재검증·프로젝트 저장/내보내기 서버 연결을 추가했으며 계정 자료 선택 UI는 통합 중이다. 실제 Supabase 계정·Storage 검증은 별도 미완료다.

## 해결할 저장 구조

현재 개인 자료는 UUID 별칭과 `format:text` 콘텐츠를 사용한다. 공개 ZIP에는 원작자가 정한 자료 별칭, 여러 파일을 가진 Skill, 바이너리 문서, 전이 의존성, 라이선스 원문이 있다. 이를 텍스트 자료로 변환하거나 UUID로 단순 치환하면 원본 해시·Skill 경로·고정 의존성이 깨진다.

복사 시 워크플로와 실행 노드·자료 별칭은 그대로 유지한다. 새 계정 프로젝트 ID와 새 워크플로 ID·revision 1을 부여하고, **계정의 저장 위치와 패키지의 자료 식별자를 분리**한다. 원본 ResourceRef/descriptor/본문 bytes/라이선스는 재작성하지 않는다. 재배포·수정 권한은 원본 라이선스와 현재 검수 증거를 확인하며 다운로드 가능 상태만으로 복사 권한을 추정하지 않는다.

## 저장 대상

|대상|저장 내용·경계|
|---|---|
|`private_imports`|owner, 요청 ID, `staging/committed/failed` 상태, 원본 release·artifact·manifest·snapshot hash, 검수한 복사 권리 ID/만료, 저장된 객체의 경로/bytes/hash. owner+요청 ID 유일성|
|private `authoring-imports` Storage|검증한 원본 ZIP의 바이트. 서버가 정한 owner/import/hash 경로, 덮어쓰기 금지. 원본 ZIP을 보존해 나중에 다시 검증 가능|
|개인 자료 버전 `archive_v1`|원본 import ID, ZIP 내 자료 별칭, ResourceRef, 원본 descriptor hash. 임의 URL·파일 경로·사용자 선택 Storage 경로를 받지 않음|
|초안의 `private_resource_bindings`|워크플로 alias → 계정 소유 자료 version UUID. 정규 Workflow Schema와 분리한 계정 저장 메타데이터. 납품 ZIP에는 넣지 않음|
|`project_origins`/`resource_origins`|원작 release ID, 버전·hash, 원래 제목, 라이선스·저작자 고지, 복사 시각. 서버가 기록하고 일반 초안 수정으로 삭제·변조하지 못함|

원본 파일은 한 import에 보관하고 여러 자료의 파일 바이트를 DB JSON/base64로 중복 저장하지 않는다. 목록 API는 제목·kind·version·준비 조건만 보내며 전체 아카이브·비밀 경로를 미리 내려주지 않는다. 개인 자료 편집 기능이 없으면 읽기 전용 고정 버전으로 표시한다.

## 구현한 원본·권리 경계

`@studio/package-kit.prepareAuthoringImport`는 32 MiB 이하 ZIP, 압축 해제 64 MiB, 2,000파일, 파일당 8 MiB, Manifest/editor 각 1 MiB로 한정한다. 입력을 소유한 바이트로 복제하며 공유 메모리 입력은 거부한다. `inspectPackage`·서명 정책·`verifyResources`를 먼저 통과하고, 워크플로와 별칭·ResourceRef·descriptor 원문·원문/바이너리·이용 조건·코드·템플릿을 보존한다. editor는 strict UTF-8 JSON 객체로 검사하지만 실제 편집기 지원 형식 확인은 이후 계층의 책임이다. 코드·템플릿을 실행하거나 사용자 계정 저장소에 쓰지 않는다.

`jobs/publication-scan/copy-rights.ts`의 권리 증거는 `whole-package`, `privateCopy:true`, `modification:true`, 원본 artifact·source snapshot·검수 근거 hash, 검수자, 유효 기간을 고정한다. `AI-WORKFLOW-STUDIO/PRIVATE-AUTHORING-COPY/1` 서명 문맥과 별도 목적의 운영 신뢰 키를 사용한다. 키의 DER hash·활성 시각·만료·철회도 현재 상태로 검사한다. ZIP 안의 키, 배포 서명, 재배포 증거, 라이선스 파일명만으로 복사·수정 권리를 승인하지 않는다. 원본의 법적 권리를 코드가 자동 판정한다고 주장하지 않으며 운영자가 확인한 권리 증거를 검증한다.

`009-publication-copy-rights.sql`은 별도 권리 검수 기관의 고정 키·유효 기간·철회와 원본에 묶인 불변 증거를 저장한다. `register_publication_copy_rights`와 `resolve_publication_copy`는 service 전용이다. 사용자·관리자 검수자·익명 클라이언트는 직접 읽거나 기록하지 못한다. 일반 배포 권리·서명키·게시 상태도 다시 확인하고, 잠금 획득 뒤 `clock_timestamp()`로 확인하여 열린 transaction의 시작 시간만 기준으로 만료를 놓치지 않는다. 증거·키의 제자리 교체와 철회 취소는 허용하지 않는다.

`recordReviewedCopyRights` 작업자 경계는 입력을 복제한 뒤 현재 원본/별도 신뢰 키를 조회하고 실제 Ed25519를 검증한다. 검증된 서명 증거와 canonical hash만 DB의 최종 현재 상태 검사에 전달한다. DB가 암호학적 검증을 직접 수행한다고 주장하지 않는다. source/authority 조회와 기록은 신뢰된 작업자 어댑터가 제공해야 하며 현재 실제 서비스 비밀 연결은 구성하지 않았다.

현재 검증: 원본 준비16개와 기존 패키지 회귀를 합한30개 통과. 3호스트 workflow/materials, 전이 의존성, 원래 alias와 id 차이, CRLF·바이너리·Skill 사본 보존, 원문 UTF-8 손상·누락·변조·편집 배치 오류를 검사했다. 실제 임시 Ed25519 키를 사용한 복사 권리20개와 PostgreSQL·작업자12개, 총32개도 통과했다. 열린 transaction 중 만료, 암호 검증 뒤 권리 철회, 동일 요청 감사 중복0, 서명 입력 await 중 변경을 포함한다. 이 키·자료는 내부 시험에만 존재하며 실제 게시 증거로 집계하지 않는다.

## 준비와 원자적 반영

1. 로그인과 same-origin 요청을 확인한다. 클라이언트가 보낼 값은 release ID와 멱등 요청 ID뿐이다. 소유자·원본 hash·권리·Storage 경로는 서버가 결정한다.
2. 공개 전달과 같은 신뢰 키·서명·현재 게시/철회·검수 권리·원본 bytes/hash 경계를 통과한다. 복사에는 별도의 이용/수정 권리 증거가 필요하다. 범위가 없거나 만료되면 중단한다.
3. 서버가 검사한 원본 ZIP을 private staging에 저장한다. `inspectPackage`와 `verifyResources`로 모든 전이 의존성·실제 파일·라이선스·native Skill 사본을 검증한다. 코드·MCP·트리거를 실행하지 않는다.
4. editor 데이터는 기존 제한된 배치·한글 흐름 표시 정보로 검증한다. 실제 workflow와 맞지 않는 정보를 자동 보정해 성공으로 표시하지 않는다. 지원하지 않는 블록/모드는 내용을 보존하되 현재 편집·다운로드 제한을 보여 준다.
5. DB 최종 트랜잭션에서 같은 release/artifact와 **현재** 권리·서명키 유효성·철회를 다시 확인한다. 그 다음 새 프로젝트·초안·모든 자료 버전·별칭 매핑·출처·감사를 함께 생성하고 import를 committed로 전환한다. 중간 자료 몇 개만 생긴 프로젝트를 반환하지 않는다.
6. 응답 유실 뒤 같은 요청 ID는 같은 복사 결과를 반환한다. 다른 원본으로 ID를 재사용하면 충돌한다. 롤백된 staging 객체는 별도 보존 기한·재시도 가능한 정리 작업으로 처리한다. 사용자 객체 전체를 재귀 삭제하지 않는다.

Storage와 PostgreSQL의 단일 분산 트랜잭션을 주장하지 않는다. staging 객체는 일반 목록·다운로드에서 보이지 않고 committed 레코드만 소비한다. 마지막 DB 검사 후 발생한 철회는 새로운 복사/배포를 막으며 이미 사용자가 받은 바이트를 회수했다고 주장하지 않는다.

서버는 네트워크/commit 결과가 불명이면 같은 요청 ID를 유지한다. PostgreSQL의 확인된 권리 철회·원본 변경·만료·형식 불일치만 실패 RPC로 종료하고, 종료 기록을 확인했을 때만 UI에 새 요청을 허용한다. 객체는 즉시 지우지 않고 보존·정리 outbox에 남긴다. 이미 committed인 같은 요청은 다시 권한을 발급하거나 두 번째 복사를 만들지 않고 기존 영수증만 돌려준다.

재사용 때는 계정 UUID·원본 자료 ID·패키지 별칭을 분리하고 개인 보관 ZIP의 서명·고정 해시를 다시 검증한다. 원본을 import별로 한 번씩 검사한 뒤 선택한 파일만 남긴다. 검사한 전체 자료에도 합계64MiB/2,000파일을 적용하므로 여러 아카이브의 미선택 파일을 메모리에 무제한 쌓지 않는다. 이미 받은 개인 복사본을 여는 것은 새 공개 복사·배포 승인과 구분하며 새로운 게시에는 새 검수가 필요하다.

## 재사용·내보내기

- 프로젝트 저장은 workflow/editor/계정 자료 매핑을 같은 expectedVersion으로 갱신한다. 맵의 모든 version은 현재 사용자 소유여야 하며 workflow의 ResourceRef와 정확히 같아야 한다.
- 내보내기는 서버가 `private_resource_bindings`를 확인하고 고정 private 원본 ZIP을 재검증한 뒤 원래 별칭 경로로 자료를 materialize한다. 브라우저가 보낸 본문이나 파일 bytes를 검증된 자료로 취급하지 않는다.
- 자료를 다른 내 프로젝트에 연결하면 기존 고정 버전을 참조하는 별도 매핑을 만든다. 같은 별칭에 다른 참조가 있으면 충돌을 표시하며 덮어쓰지 않는다. 전이 의존성도 함께 연결한다.
- 개인 텍스트 자료는 기존 동작을 유지한다. 기존 UUID alias와 archive alias를 구분 없이 ID 이름으로 추론하지 않고 저장된 형식·바인딩으로 해석한다.
- 3종 ZIP은 원본 자료 bytes·라이선스·고정 의존성을 보존한다. 복사본을 관리자 공식 예제나 원본의 서명된 배포로 표시하지 않는다. 새 공개 배포에는 별도 검수·권리 확인·서명이 필요하다.

## 후속 구현 순서와 완료 조건

|순서|대상 파일|의존·산출물|완료 기준|
|---|---|---|---|
|1|`packages/package-kit/src/authoring-import.ts`, 계약 시험|아카이브→원본 보존 스냅샷, bytes/참조/전이 의존성 검사|Skill·코드·템플릿·바이너리·다중 의존성 보존, 잘못된 path/hash/외부 URI 거부|
|2|`infrastructure/supabase/migrations/010-private-imports.sql`, DB 시험|009 권리 검사에 의존. owner RLS, staging·멱등·출처, archive 버전, 바인딩 원자 저장|A/B 격리·직접 출처 위조 차단·모든 부분 실패 롤백·동시 중복 요청|
|3|`apps/studio-web/src/server/publication-copy.ts`, `resource-materials.ts`, `resources.ts`|검증된 전달→private staging→현재 권리 검사→commit, 저장 자료 materializer|철회/권리 만료/서명키 변경 중 copy 실패, 전이 자료 누락0, 재시도 결과 동일|
|4|`api/publications/[id]/copy/route.ts`, 프로젝트/자료 API|서버 확정 소유자·bounded 요청·same-origin·기존 텍스트 호환|미로그인·CSRF·타인 version·임의 객체 경로·과대 ZIP·허위 provenance 차단|
|5|`features/library/PublicationDetail.tsx`, 자료 선택/편집 저장|내 프로젝트로 복사, 내 도구 및 자료에 추가, 출처 표시|실제 저장 ID로 이동·재열기·수정·3종 ZIP, 오류 때 성공 UI 없음|
|6|정리 job·운영 문서·통합 증거|실패 staging 보존/청소와 실제 Supabase Storage 복원|계정 2개·실제 파일 hash·DB/Storage 복원·동시 철회와 다운로드 검증|

1~5의 로컬 계약·PostgreSQL 시험은 실제 Supabase 계정 없이 진행할 수 있다. 6의 실제 계정/Storage 검증과 공개 배포는 준비된 환경과 별도 증거가 필요하다.

010 구현에서는 기존 초안 직접 INSERT/UPDATE 권한으로 별칭 매핑 검사를 우회하지 못하도록 owner 검증 RPC로 쓰기를 모은다. 기존 create/save 함수 시그니처는 텍스트 자료 호환 경로로 유지한다. 불변 project revision에도 당시의 자료 매핑을 고정한다. 개인 자료 목록은 현재의 100개 제한을 페이지 방식으로 바꾸고 버전 메타데이터만 조회하여 120개 이상을 복사해도 누락되지 않게 한다.

## 010 DB 상세 계약

`010-private-imports.sql`의 서비스 RPC는 인증된 서버가 확정한 owner·release·request ID만 받는다. 일반 계정은 저장소 경로와 권리 증거가 든 `private_imports`를 직접 조회하거나 쓰지 못한다. 서비스 역할도 새 테이블에 직접 INSERT/UPDATE/DELETE할 권한은 없고 공개한 상태 전이 RPC를 사용한다. SQL은 아래 메타데이터의 소유 관계와 고정 참조를 검사한다. ZIP 실제 바이트·Ed25519·canonical JSON digest 검증은 서버의 책임이다.

### 준비 JSON과 반환 값

`begin_private_import(p_owner uuid,p_request uuid,p_release uuid)`는 다음 envelope를 반환한다. 같은 owner/request ID는 같은 import를 반환하고, 다른 release에 재사용하면 `IMPORT_REQUEST_CONFLICT`로 거절한다. committed 요청은 뒤늦은 원본 철회 이후에도 기존 receipt만 반환한다. 새로운 복사 권한을 부여하거나 새 계정 행을 만들지 않는다.

```json
{
  "importId": "계정 복사 UUID",
  "requestId": "멱등 요청 UUID",
  "releaseId": "원본 공개 버전 UUID",
  "state": "staging",
  "storage": {
    "bucket": "authoring-imports",
    "path": "<owner UUID>/<import UUID>/<artifact SHA256>.zip",
    "bytes": 12345,
    "sha256": "원본 ZIP SHA256"
  },
  "resolution": { "delivery": "009의 전달 객체", "copyRights": "009의 별도 복사 권리 객체" },
  "receipt": null
}
```

`stage_private_import(p_import uuid,p_preparation jsonb,p_preparation_sha text,p_stored_bytes bigint,p_stored_sha text)`는 실제 업로드와 readback 확인 뒤 호출한다. `p_preparation_sha`는 서버가 아래 전체 준비 JSON으로 계산한 canonical digest다. 같은 metadata/hash 재전송은 멱등이고 한 번 기록한 내용을 바꾸면 거절한다. `p_stored_bytes`·`p_stored_sha`가 begin의 원본과 다르면 거절한다. SQL 자체가 Storage readback을 수행한 것은 아니다.

```json
{
  "format": "private-authoring-v1",
  "source": {
    "artifactSha256": "원본 ZIP SHA256",
    "manifestSha256": "원본 manifest 바이트 SHA256",
    "packageId": "원본 패키지 ID",
    "packageVersion": "원본 버전",
    "kind": "workflow",
    "host": "codex",
    "trust": "verified"
  },
  "name": "내 계정 목록에 표시할 이름",
  "workflow": { "id": "원본 ID", "revision": 9, "resources": {} },
  "editor": { "positions": {} },
  "resources": [
    {
      "alias": "원본 별칭",
      "reference": { "id": "원본 자료 ID", "kind": "instruction", "revision": 3, "sha256": "resource.json 원본 바이트 SHA256" },
      "descriptor": "검증된 ResourceDescriptor 객체",
      "contentSha256": "아래 archive_v1 내용의 canonical digest"
    }
  ],
  "inventory": { "resourceCount": 1, "fileCount": 3, "bytes": 1234 }
}
```

위 예시는 필드를 설명하는 축약형이다. 실제 workflow/editor/descriptor는 각 원본의 완전한 검증 객체이며 서버가 전체 스키마를 검사한다. 준비 JSON은 4 MiB 이하, editor는 1 MiB 이하, 자료 2,000개 이하, 자료 파일 2,000개·64 MiB 이하로 제한한다. `resources`는 별칭 중복이 없어야 하고 모든 descriptor.dependencies와 workflow.resources의 참조가 정확히 일치해야 한다. materials에는 workflow/editor를 넣지 않으며 최소 한 자료가 있어야 한다. 원본 descriptor의 200자 이름은 잘라 저장하지 않고 resources.name 상한을 200자로 확장한다. preparation.name은 기존 프로젝트 이름 정책인 1~120자다.

`contentSha256` 계산 입력은 다음 객체 전체이며, `importId`는 begin의 UUID다. descriptor에는 description 필드가 없으므로 description은 정확히 빈 문자열이다.

```json
{
  "format": "archive_v1",
  "importId": "begin에서 받은 UUID",
  "sourceAlias": "원본 별칭",
  "reference": { "id": "원본 자료 ID", "kind": "instruction", "revision": 3, "sha256": "resource.json 원본 바이트 SHA256" },
  "descriptorSha256": "reference.sha256와 동일",
  "name": "descriptor.name",
  "kind": "descriptor.kind",
  "description": ""
}
```

`resource_versions.sha256`는 이 JSON의 canonical digest다. 원본 ResourceRef.sha256와 서로 바꿔 쓰지 않는다. 계정 resource/version ID는 새 UUID이고 계정 version.revision은 1이지만 원본 reference.revision은 3 같은 원래 값을 보존한다. `resource_archive_versions`는 version UUID→import/source alias/reference/descriptor를 고정한다. archive 바이트와 원문 JSON은 기존 비공개 ZIP에 보존한다.

### 확정·조회·저장

|RPC|권한·반환|핵심 조건|
|---|---|---|
|`commit_private_import(p_import uuid,p_preparation_sha text)`|service, 같은 envelope|staging+readback metadata+정확한 준비 digest. 프로젝트·자료·버전·바인딩·출처·감사와 committed 전이를 한 SQL transaction에서 처리|
|`fail_private_import(p_import uuid,p_code text)`|service, 같은 envelope|확정 실패만 terminal failed로 전환. code는 1~80자 대문자/숫자/밑줄. committed는 실패로 되돌릴 수 없음|
|`get_private_import_status(p_request uuid)`|authenticated own, 안전한 상태 projection 또는 null|`importId,requestId,releaseId,state,receipt,failureCode`만 반환. path·권리자료 없음|
|`create_private_project_with_resources(p_name,p_workflow,p_editor,p_bindings)`|authenticated, 기존 `{project,draft}`|새 프로젝트에 이미 소유한 archive/text 버전을 명시적으로 연결|
|`save_private_draft_with_resources(p_project_id,p_expected_version,p_name,p_workflow,p_editor,p_bindings)`|authenticated, 기존 draft row|프로젝트 owner·expectedVersion·모든 ref/alias/version 소유권·전이 의존성을 함께 검사하고 초안과 맵을 원자 갱신|

`p_bindings`는 `{ "원본 alias": "계정 resource_versions.id UUID" }` 객체다. archive alias와 참조는 import 당시 값과 같아야 하며 임의 이름 변경으로 descriptor 의존성을 깨뜨리지 못한다. text는 기존 UUID alias와 계정 resource ID/revision/kind를 검사한다. text descriptor hash는 서버가 원문으로 재생성하여 다시 검사하며 DB가 이 값을 암호학적으로 확인했다고 주장하지 않는다.

확정 receipt는 `{importId,projectId:null|UUID,resources:[{alias,resourceId,versionId,revision:1}]}`다. 자료 패키지는 projectId가 null이다. workflow는 commit에서 새 ID와 revision 1만 부여하고 그 밖의 원본 구조·별칭은 보존한다. 원본 release·source snapshot hash·패키지 ID/버전/hash·원래 제목·복사 권리 증거 hash와 자료 license/files 위치를 origins에 기록한다. 일반 저장은 origins를 변경하지 않는다. 원래 자료를 지운 뒤 같은 멱등 요청을 재사용해 재생성하지 않으며 새 복사에는 새 request ID가 필요하다.

기존 `create_private_project`·`save_private_draft`·`snapshot_private_project` 시그니처와 반환을 유지한다. SECURITY DEFINER 전환 후 모든 경로에 auth.uid()/owner 검사를 넣고, 직접 draft INSERT/UPDATE/DELETE 및 revision INSERT를 회수하여 매핑 우회를 닫는다. 기존 text UUID별칭은 버전을 자동 추론한다. archive가 이미 연결된 초안은 기존 고정 맵을 유지하며 새 archive는 명시적 bindings RPC가 필요하다. 새 snapshot은 `private_revision_resource_bindings`에 당시 맵을 고정한다. 010 이전의 정상 text 초안/스냅샷은 소유 관계가 일치하는 맵을 backfill하며 원본 workflow나 snapshot hash를 수정하지 않는다. 비정상·타인 ref는 성공으로 간주하지 않고 미해결로 남긴다.

### 현재 권리와 잠금 순서

owner/request에는 transaction advisory lock을 사용하여 아직 import 행이 없는 동시 요청을 직렬화한다. 확정은 import 행을 잠그고 소유 계정 존재를 검사한다. 원본 submission→release 순서로 공유 잠금을 취득하여 기존 publication 쓰기 순서와 맞춘 다음 candidate·scan·review·delivery·서명키·배포 권리키·복사 grant·복사 권리키를 고정한다. 같은 grant/authority의 철회가 먼저 완료되면 현재 조회가 실패하고, 복사가 먼저 잠금을 얻으면 철회는 복사 transaction 종료를 기다린다. 잠금 뒤 009의 현재 resolution 전체와 begin 때의 resolution을 비교한다. 증거 교체를 재시도로 조용히 수용하지 않는다.

열린 transaction의 `now()`에만 의존하지 않고 009의 fresh `clock_timestamp()` 만료 검사와 import 만료 검사를 사용한다. 새 grant 등록은 release UPDATE 잠금과 직렬화된다. 실제 PostgreSQL 다중 연결의 잠금 경합·deadlock 재시도·Supabase Auth/Storage 동작 검증은 배포 환경 시험으로 남아 있다. PGlite 단일 연결의 순차 경계 시험을 실제 서비스 동시 실행 증거로 표시하지 않는다.

### 보존과 정리

`authoring-imports`는 private 32 MiB 버킷이며 authenticated Storage policy가 없다. 서버는 begin 경로에 `upsert:false`로 저장하고 바이트/hash readback을 확인한다. SQL과 Storage 사이 분산 원자성은 제공하지 않는다. 업로드 결과가 불확실하면 서버가 객체를 임의 삭제하거나 무조건 failed로 바꾸지 않고 같은 요청으로 재조정한다.

staging 유효 기간은 24시간이다. `claim_private_import_cleanup(p_limit integer)`는 1~100개를 받고 만료/계정 삭제 staging을 먼저 terminal failed로 만든다. failed 객체는 7일 보존한다. committed 원본도 project origin이나 archive version이 남아 있으면 정리하지 않는다. 관련 계정 데이터가 모두 삭제된 후 고아 객체로 처음 발견된 시점부터 7일을 보존한다. 스냅샷의 version FK는 아직 참조 중인 자료 삭제를 막는다. 계정 삭제 시 import의 owner만 null이 되고 경로·hash·정리 이력은 남는다.

claim 반환은 `[{jobId,importId,leaseId,bucket:'authoring-imports',path,expectedSha256,attempts}]`다. 한 객체에 5분 lease를 부여하고 `FOR UPDATE SKIP LOCKED`를 사용한다. 정리 작업자는 정확한 path/hash와 현재 객체를 확인한 뒤 그 한 객체만 처리한다. `finish_private_import_cleanup(p_job uuid,p_lease uuid,p_outcome text)`는 `deleted|not_found|retry`만 받으며 claim 없는 null lease·옛 lease·만료 lease를 거절한다. deleted/404 확인 후에만 DB에 삭제 완료를 기록하고, retry는 한 시간 뒤 다시 시도한다. 완료된 같은 lease/outcome의 응답 재전송은 멱등이다. DB가 객체를 실제 지웠다고 대신 주장하지 않는다.

### 로컬 검증과 후속 연동

전용 `tests/database/private-imports.test.ts`는 실제 PostgreSQL 엔진에서 001~010을 적용한다. 실제 임시 서명 ZIP과 별도 copy grant를 사용하여 원본 alias/revision·계정 새 ID·canonical content hash·전이 의존성·소유권·멱등·직접 쓰기 차단·다섯 종류 철회·열린 transaction 만료·일부 삽입 실패 전체 롤백·기존 text backfill·불변 snapshot·정리 lease·계정 삭제 후 경로 보존을 확인한다. 외부 Storage와 운영 서명키/계정은 사용하지 않으며 실제 게시·모델·호스트 사용 수에 더하지 않는다.

서버 후속 구현에는 archive materializer의 원본 ZIP 재검증, 초안/revision별 binding 조회, 목록 cursor pagination과 버전 메타데이터 전용 조회가 필요하다. 120개 자료를 복사한 뒤 100개 limit 때문에 나머지가 사라지지 않아야 한다. 새 공개 제출은 원본 복사 권리를 재배포 승인으로 재사용하지 않고 현재 snapshot·자료 closure와 별도 배포 검수를 거친다.
