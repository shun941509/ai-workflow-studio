# 텍스트 자료의 명시적 이용 조건

이 규격은 새로 저장하는 작업 지침과 텍스트 문서의 이용 조건을 고정한다. 서비스 코드와 Studio Runner의 MIT 라이선스를 사용자의 자료에 자동 적용하지 않는다. 기존 버전의 이용 조건도 변경하지 않는다.

## 입력과 불변 버전

`packages/spec/schemas/text-resource-license.schema.json`이 선언 형식의 단일 기준이다. 새 자료 저장 요청의 선택 필드 `license`는 아래 형식이다. 이 예시 저작권자는 실제 기관이 아닌 가상 명칭이다.

```json
{
  "id": "MIT",
  "copyrightHolder": "가상 별빛 연구실",
  "copyrightYear": 2026,
  "confirmedAuthority": true
}
```

- `license` 필드가 없으면 기존 개인 이용 조건을 유지한다. HTTP 요청에 필드가 있는데 null, 누락된 확인 값 또는 잘못된 값이면 `RESOURCE_LICENSE_INVALID`로 거절한다. 잘못된 MIT 요청을 개인 이용 조건으로 조용히 바꾸지 않는다.
- 식별자는 `MIT`만 지원한다. `confirmedAuthority`는 boolean `true`여야 한다. 문자열 `"true"`나 false는 허용하지 않는다.
- 저작권자는 앞뒤 공백이 없는 1~160자이며 제어문자를 허용하지 않는다. 연도는 1900~9999의 정수다. 다른 필드, 비JSON 값, 접근자, 잘못된 Unicode를 거절한다.
- 이 값은 작성자의 권한 보유 선언이다. 실제 권리 확인, 관리자 검수, 게시 승인이나 개인 복사 권한 증거가 아니다.
- 저장할 때 선언을 복제해 `resource_versions.content`에 포함한다. 데이터베이스 내용 해시는 선언을 포함한 canonical JSON을 고정한다. 요청 객체의 이후 변경은 저장 대상으로 준비한 내용에 반영되지 않는다.

## 자료 원본과 ZIP

`createTextResource`는 본문, `LICENSE.txt`, `resource.json`을 만든다. MIT 선택 시 원문 허락 조건과 면책 문구를 줄이지 않고 저작권자·연도와 함께 기록한다. 자료 descriptor는 이용 조건 파일의 경로·바이트 수·SHA-256을 고정하고, `ResourceRef.sha256`은 descriptor의 원본 바이트를 고정한다. 데이터베이스 canonical 해시와 ResourceRef 해시는 서로 다른 대상을 확인한다.

이용 조건이 없는 기존 자료의 개인 이용 안내문, 파일 순서, descriptor 직렬화와 마지막 줄바꿈을 유지한다. 따라서 같은 ID·버전·이름·종류·본문을 다시 구성하면 기존 파일 바이트와 ResourceRef 해시가 유지된다. MIT 조건을 새로 포함하면 이용 조건과 descriptor가 바뀌므로 참조 해시도 달라진다. 이미 고정한 개인 자료 참조를 그대로 MIT 자료로 바꿀 수 없다.

Codex·Claude Code·OpenCode의 workflow/materials ZIP은 자료 원본을 보존한다. 패키지 ID·생성 시각은 다시 내보낼 때 바뀔 수 있지만 자료 본문, BOM·CRLF, 이용 조건, descriptor와 고정 참조는 재가져오기 후에도 같아야 한다. 자료 이용 조건 파일이 바뀌었는데 기존 참조를 제출하면 무결성 오류다. authoring import 준비는 계정 복사 권한을 부여하지 않는다.

## 화면과 공개 검수의 경계

새 자료 화면은 개인 이용 조건을 기본으로 제공한다. MIT 선택 시 저작권자·연도·권한 확인을 요구하며 저장 후에도 자료는 비공개다. 기존 자료의 이용 조건을 바꾸거나 검수를 건너뛰는 버튼은 아니다. 자료 미리보기와 원본 ZIP에서 고정된 조건을 확인한다.

scanner는 원본 불변 버전의 명시적 이용 조건으로 자료를 다시 구성하고 제출 ZIP의 참조와 비교한다. MIT라는 이름이나 원문 고지가 있다는 이유만으로 권리를 통과시키지 않는다. 현재 정책은 별도의 외부 신뢰키가 확인하는 전체 패키지 배포 권리 서명을 요구하며, 서명은 정확한 ZIP 해시·원본 snapshot 해시·만료에 묶인다. 이 규칙은 서비스의 검수 증거 정책이며 라이선스의 법률 해석을 대신하지 않는다.

별도 서명 근거가 없거나 만료·변조·다른 원본·다른 패키지·미신뢰키이면 `rights=unverified`, `status=needs_evidence`다. 원본 조건과 제출 자료가 다르면 `source=failed`다. 기존 개인 재배포 금지 조건은 서명 근거가 있더라도 현재 scanner 정책에서 차단한다. 모든 정적 검사가 통과해도 `releaseAuthorized=false`이며 실제 게시·서명 배포·호스트 실행 성공을 뜻하지 않는다.

## 2026-10-28 전용 검증 기록

`tests/contracts/text-resource-license.test.ts`와 `tests/security/text-resource-license-boundaries.test.ts`의 64개 시험이 통과했다(최종 실행 2.11초). 두 파일을 진입점으로 프로젝트와 같은 strict TypeScript 옵션으로 수행한 타입 검사도 통과했다. 입력 경계, 기존 개인 자료의 전체 원본/참조 보존, 저작권자와 전체 MIT 고지, 3호스트 × workflow/materials ZIP 왕복, 저장 해시 아래의 조건 변경 차단, 별도 배포 권리 근거의 필요성·만료·변조·원본 불일치를 확인했다.

이 시험은 실제 ZIP 바이트와 암호 서명을 사용한다. 서명키는 시험 프로세스 안에서 생성하며 운영 신뢰 목록이나 제품 패키지로 내보내지 않는다. Next의 server-only import 표지만 시험에서 대체하며 검사기·자료 materializer·서명 검증은 실제 코드를 사용한다. 초기 실행의 server-only 대체 경로 오류를 시험 파일에서 고친 뒤 두 파일을 다시 실행했다.

실제 Supabase 계정·Auth/Storage, 실제 저작권 검수, 공개 게시, 3호스트 로그인·실행, 모델 품질은 이 기록에 포함되지 않는다. 라이선스 선택을 포함한 최신 웹 운영 빌드·브라우저 통합 확인은 별도 통합 단계에서 수행한다.
