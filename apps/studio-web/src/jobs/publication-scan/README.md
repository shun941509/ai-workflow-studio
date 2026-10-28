# 게시 후보 정적 검사와 검수 경계

이 작업은 실제 ZIP 검사와 사람 검수 API까지 연결한다. 파일 내용 실행, 모델 호출, 계정 생성, 서명 발급, 실제 Storage 업로드 또는 외부 게시를 수행하지 않는다. 정적 패턴 검사는 완전한 악성코드 부재·권리 소유·의미적 정확성·실제 호스트 사용 성공을 보장하지 않는다.

## 실제 검사

`scanPublication`은32MiB 이하 workflow/materials ZIP을 package-kit으로 검사한다. 허용 경로, ZIP 헤더·압축 한도, 원본 파일 해시, manifest, 고정 자료/전이 의존, 운영 파일, 호스트 연결 정의, workflow 의미를 검사한다. 이어서 원본 제출 snapshot과 실제 package identity를 비교하고 고정 배포 정책의 지원 capability, 모든 텍스트의 알려진 비밀 패턴, 정적 위험 신호를 검사한다.

- 텍스트 파일당1MiB, archive2000 files/64MiB 한도를 적용한다. 초과하거나 UTF-8로 해석할 수 없는 내용은 검사하지 못한 것으로 기록한다.
- 실행 코드·HTML/SVG·바이너리는 실행/렌더링하지 않는다. 이 단계에서 검사 완료로 표시하지 않으며 격리된 별도 검증이 필요하다.
- 외부 연결·MCP·색인은 실제 연결/검증 없이 통과하지 않는다.
- 비밀 패턴의 원문이나 일부 값을 보고서에 넣지 않는다. 발견 코드·대상 경로와 정확한 바이트 해시를 기록한다.
- 프로젝트 원본은 canonical workflow hash와 editor까지 비교한다. 자료 원본은 현재 private text revision을 재물질화해 비교한다. 다른 자료 원본 저장 형식은 지원할 때까지 차단한다.
- private text export의 `LicenseRef-Proprietary`는 실제 포함된 재배포 제한으로 취급한다. 외부 권리 증거가 있어도 포함된 제한을 자동 삭제/무시하지 않는다. 공개용 권리·자료 물질화 경로는 별도 후속 작업이다.

보고서는 원본 ZIP SHA-256, 원본 manifest SHA-256(검사 불가면 null), source snapshot hash, scanner/policy 버전과 실제 규칙·capability 목록 hash, 검사 시각,8개 검사 상태에 귀속된다. 보고서 자체도 canonical digest로 고정한다. 모든 항목이 passed인 경우에만 정적 검사 passed이며 `releaseAuthorized`는 항상 false다.

## 권리 근거와 현재 신뢰

재배포 권리는 외부 운영자 trust에 등록된 Ed25519 검수자가 정확한 artifact/source hash와 whole-package 범위에 서명한 근거를 요구한다. 단순 라이선스 이름, 사용자 `passed:true`, ZIP에 동봉된 공개키는 권한이 아니다. 검수 근거는 증거 hash·검수자·기간을 포함하며 domain-separated 서명으로 검증한다.

005의 `publication_rights_authorities`에는 운영자가 따로 승인한 key ID·공개키 DER SHA-256·취소 시각만 저장한다. 사용자와 reviewer는 읽거나 변경할 수 없다. worker는 이 현재 registry와 외부 공개키가 모두 일치해야 권리 근거를 인정한다. 키를 자동 생성/신뢰 등록하지 않는다. 직접 review RPC 호출도 키 취소·교체 및 근거 만료를 재검사하므로 API 우회로 승인할 수 없다.

## 영속 worker 경로

1. 권리와 원본 파일을 고정할 수 있는 신뢰된 준비 작업이 private `publication-candidates` Storage에 업로드한다. 이 업로드/준비 작업 자체는 아직 연결되지 않았다.
2. service 전용 `register_publication_candidate`는 submission·ZIP hash/size·source hash를 불변으로 고정한다. 경로는 `candidates/<submission UUID>/<artifact SHA>.zip`이다. 같은 내용은 멱등이고 다른 바이트로 교체할 수 없다.
3. `scanConfiguredPublication`은 서버 전용 `SUPABASE_SECRET_KEY`를 우선 사용하는 worker다. 기존 프로젝트의 `SUPABASE_SERVICE_ROLE_KEY`는 호환용 fallback이다. 둘 다 없으면 `SCAN_WORKER_NOT_CONFIGURED`로 종료한다. 이 값은 NEXT_PUBLIC 변수나 브라우저에 넣지 않으며 reviewer API에서는 worker를 호출하지 않는다. URL과 공개키만으로 이 worker를 실행할 수 없다. 일반 사용자 편집·개인 실행 준비에 이 운영자 비밀키는 필요하지 않다.
4. `runPublicationScan`은 등록된 실제 파일을 읽고 크기/바이트/source를 다시 대조한다. 임의 URL·OS 경로·브라우저 보고서를 입력받지 않는다.
5. service 전용 scan RPC는 candidate hash·보고서 체크와 boolean 일치·신뢰된 rights key를 확인한 뒤 보고서·상태·감사를 같은 transaction에 저장한다. 모든 검사가 완료돼야 scanned이고 실패/미검증은 changes_requested다. 잘못된 ZIP은 null manifest hash로 실패를 보존한다.
6. 저장 응답 유실 후 재시도는 실제 바이트와 저장 report hash/current policy/current rights를 확인한다. 같은 결과를 다시 기록하지 않는다. 바뀐 정책이나 권리 근거가 필요한 재검사는 새 제출로 진행한다.

## 관리자 API

- `GET /api/admin/reviews?status=scanned`: 최대25개 metadata와 다음 cursor.
- `GET /api/admin/reviews/:id`: 검수 대상 metadata와 현재 형식의 hash-checked 검사 보고서, 현재 권리 상태/readiness. private 원본/Storage 경로/인증정보는 반환하지 않는다.
- `POST /api/admin/reviews/:id`: `{artifactSha256,decision:'approved'|'rejected',reason}`. 동일 Origin,20,000 bytes JSON,10~4,000자 사유, 실제 Auth getUser, DB reviewer/administrator 역할을 요구한다. 입력한 pass flag/역할/게시 동작은 거절한다.

API와 DB 모두 검수 해시가 실제 검사한 해시와 일치해야 한다. 승인해도 signed/published 상태로 바꾸지 않는다. 서명·외부 업로드·공식 예제 사용 증거·전체 release gates와 배포 시점의 재검증이 연결되기 전에는 실제 게시 성공을 주장할 수 없다.

## 관리자 검수 화면

`/admin/reviews`와 `/admin/reviews/:id`는 위 API를 사용하는 실제 검수 목록·상세 화면이다. 일반 사용자의8개 메뉴에 관리자 메뉴를 추가하지 않는다. 주소 접근이나 브라우저 UI의 상태가 검수 권한을 부여하지 않으며, 모든 읽기·결정은 서버 Auth와 DB 역할을 확인한다.

006의 `publication_review_readiness`는 reviewer/administrator에게만 현재 권리 근거 만료·취소·키 변경 및 승인 차단 이유를 돌려준다. 비공개 신뢰 키와 Storage 경로는 노출하지 않는다. 실제 결정 RPC는 이를 다시 검사하므로 조회 후 권리나 상태가 바뀌어도 오래된 화면으로 승인할 수 없다.

화면은 고정 ZIP/manifest/source/report/policy 해시,8개 검사 결과, 코드·경로 형태의 위험 신호, 저장된 검수 사유를 escaped text로 표시한다. 파일·HTML·실행 코드를 미리보기로 실행하지 않는다. 구체적 사유와 표시 해시 확인을 요구하고 연속 클릭은 한 요청으로 제한한다. 경쟁 상태/응답 유실은 성공으로 표시하지 않고 최신 기록을 다시 읽는다. 해시·보고서·권리 상태가 바뀌면 입력한 확인을 초기화한다. 창 복귀·60초 주기·수동 새로고침으로 상세 상태를 다시 확인한다.

계정 서비스가 없으면 실제503 준비 안내,401은 로그인 안내,403은 역할 부족을 표시한다. 가짜 목록·승인 기록을 제품에 넣지 않는다. 승인 기록은 서명·게시 동작을 호출하지 않는다.

## 검증과 미검증

`tests/contracts/publication-scan.test.ts`는 실제3종 ZIP·자료 ZIP·로컬 파일·암호 서명·미검증 내용·응답 유실/재시도 경계를 검증한다. `tests/database/publication-reviews.test.ts`는001~006 migration과 실제 scanner output을 PostgreSQL(PGlite)에 연결한다. Auth 주입과 운영자 테스트 공개키는 테스트 경계에만 있다. `tests/e2e/publication-reviews.spec.ts`는 실제 로컬 Next API의 미설정·Origin·요청 한도·권한 상승 입력을 확인한다. `tests/e2e/reviews-ui.spec.ts`는 Chrome에서 실제 미설정 화면과 테스트 전용 HTTP 응답을 이용한401/403·페이지 이동·해시 확인·중복 클릭·경쟁·만료·취소·모바일 표시를 검증한다. 이 HTTP 응답 시험은 실제 클라우드 로그인/게시 성공의 증거가 아니다. 실제 Supabase Auth/Storage 연결, 인간의 콘텐츠 검토, 상용 악성코드 엔진, 공식 서명/게시 증거는 아직 없다.
