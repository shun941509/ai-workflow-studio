# 복사 자료의 공개 검수 원본 계약

2026-10-28. 복사한 `archive_v1` 계정 자료를 materials ZIP으로 검수할 때 원본 자료와 정확한 전이 의존성을 대조한다. 이 기능은 원본 일치 확인이다. 새 배포에는 그 ZIP과 계정 snapshot에 대해 별도로 검수한 현재 배포 권리 증거가 필요하며, 복사 허가나 기존 프로젝트 배포 서명을 재사용하지 않는다.

## 원본 고정

`publication_submissions.source_snapshot.version`은 서버가 저장한 불변 계정 자료 버전이다. `version.content` 전체의 canonical digest가 `version.sha256`와 같아야 한다. archive 계정 버전은 revision 1이고 resource_id는 계정 UUID다. 콘텐츠는 `format,importId,sourceAlias,reference,descriptorSha256,name,kind,description` 8필드만 가지며 description은 빈 문자열이다. 원본 ref의 revision과 계정 revision은 독립적이다.

검수기는 ZIP에서 `resources/<sourceAlias>/resource.json` 원본 바이트의 SHA256를 계산하여 reference.sha256 및 descriptorSha256와 대조한다. manifest의 해당 alias 참조도 원본 reference 전체와 같아야 한다. JSON 의미가 같아도 공백·개행이 달라 원본 byte hash가 바뀌면 다른 자료로 판단한다. 검사한 descriptor의 name/kind가 고정 콘텐츠와 같아야 한다. snapshot에 resource 메타데이터가 있으면 계정 ID/name/kind 관계도 같아야 한다.

## 전이 의존성 범위

`verifyResources`로 실제 descriptor·payload·의존 ref의 해시를 검사한 뒤, 선택한 루트 자료의 `descriptor.dependencies`부터 모든 전이 의존성을 탐색한다. 이 집합과 manifest.resources의 alias 집합이 정확히 일치해야 한다. 루트 descriptor의 원본 해시는 직접 의존 ref를 고정하고, 각 의존 descriptor의 해시는 다시 하위 의존성과 파일을 고정한다.

다음은 거절한다.

- 루트 alias만 바꾸거나 다른 alias의 원본 ref를 대신 제출한 경우
- 원본 descriptor를 같은 JSON으로 다시 직렬화하여 원문 hash가 달라진 경우
- 직접 또는 전이 의존성의 누락·해시 교체·파일 변조
- 루트 자료와 무관한 다른 자료를 같은 ZIP에 추가한 경우
- account content hash·원본 name/kind·sourceAlias·import ID·계정 revision이 다른 경우

자료를 열고 복사·내보내는 서버는 먼저 owner·committed import·보관 ZIP·고정 서명을 다시 검증한다. 검수기의 snapshot은 이 서버/DB 경계에서 공급하며, 브라우저가 제출한 새 콘텐츠를 불변 원본으로 받아들이지 않는다. 검수기는 원격 URL을 읽거나 Skill/MCP/코드를 실행하지 않는다.

## 권리 및 기존 정책

`archive_v1` 원본 일치를 통과해도 파일 유형, 비밀, 지원 capability, 외부 연결, 실행 코드, 정적 위험과 배포 권리 검사는 계속 적용한다. 실행 가능한 코드·미지원 바이너리 등이 포함되면 기존 정책대로 unverified가 될 수 있다. Skill 원본을 정확히 확인했다는 것과 안전 실행 증거가 있다는 것은 다른 판단이다.

기존 `format:text` 자료의 `LicenseRef-Proprietary`는 그대로 배포를 차단한다. 새로운 라이선스 선택 UI나 권리 변경을 이 작업에서 추가하지 않는다. 복사 permission의 `privateCopy/modification` 및 옛 패키지의 redistribution 증거는 새 materials 배포 권리를 대신하지 않는다. 검수 결과의 `releaseAuthorized`도 false이며, 게시에는 별도 현재 권리·사람 검수·서비스 상태 전이가 필요하다.

source 규칙 변경은 `scanPolicyDigest`의 `sourceIdentityRules: "text-v1/archive-v1-closure-1"`로 고정한다. 기존 scannerVersion/DB 보고 형식은 1.0.0을 유지하지만 이전 정책 fingerprint로 저장한 보고를 새 규칙의 성공 결과로 재사용하지 않는다.

## 검증 증거와 남은 경계

`tests/contracts/publication-archive-scan.test.ts`는 임시 Ed25519 서명으로 만든 실제 workflow ZIP, 별도의 복사 권리, `prepareVerifiedCopySource`, 실제 archive 콘텐츠 생성, 3호스트 materials ZIP과 새 배포 권리 증거를 사용한다. 단계가 다른 권리 재사용, 3단계 의존 closure, unrelated 자료 추가, alias 변경, 원문 직렬화 변경, 메타데이터 불일치, 파일 누락과 예전 정책 보고 재사용을 검사한다. 기존 scanner 회귀를 함께 실행하여 개인 텍스트 자료의 권리 차단도 유지한다.

`tests/database/private-imports.test.ts`의 materials 경로는 실제 001~010 DB에서 workflow 복사 확정→계정 자료 version 제출 snapshot→materials ZIP 원본/권리 검사→사람 검수·배포 DB 전이→새 복사 권리 등록→다른 계정 materials 복사 확정을 이어 검증한다. scanner가 실제 계산한 passed 보고만 기록한다. 최종 receipt.projectId는 null이며 원본 두 자료의 revision 3/9와 전이 의존성, 각 계정 버전 revision 1을 보존한다. 이 로컬 DB 흐름도 실제 서비스 게시 증거는 아니다.

테스트 transport만 메모리 대역으로 공급한다. 원문 bytes·해시·ZIP·서명 검증은 실제 수행하며 가짜 passed scan을 삽입하지 않는다. 이 증거는 운영 계정에서의 복사/게시·실제 외부 서비스·모델/호스트 사용 검증을 대신하지 않는다.
