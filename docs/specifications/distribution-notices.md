# Runner 배포 구성 목록과 원본 고지

실제 운영 번들에 들어간 구성요소를 기준으로 원본 라이선스·고지 파일을 보존한다. 개발 의존성을 모두 복사하거나 제3자 이용조건을 자체 MIT 문구로 교체하지 않는다.

## 수집 기준

`tooling/build-runner.mjs`는 esbuild가 실제 읽은 입력 바이트를 스냅샷하고 최종 번들에 남은 입력만 선택한다. Runner UI는 Vite의 retained module graph를 사용한다. 구성요소의 실제 package.json에서 이름·버전·선언 라이선스를 읽고 package.json 해시, 입력 모듈 상대 경로·바이트 수·SHA256을 기록한다.

`tooling/distribution/notice-inventory.ts`는 해당 패키지와 입력 파일의 상위 디렉터리에 있는 LICENSE/COPYING/NOTICE 등을 원본 바이트로 동봉한다. notice 경로, 크기, 원본 해시를 별도로 기록한다. 링크·workspace 밖 경로·숨김 설정·테스트·node_modules 전체 복사·잘못된 고지 경로는 거절한다. JSON 구성 목록에 로컬 절대 경로를 넣지 않는다.

`js-tiktoken@1.0.21`의 npm 배포에는 LICENSE가 빠져 있어, 설치 package.json 해시와 npm gitHead를 대조한 [고정 커밋 원문](https://raw.githubusercontent.com/dqbd/tiktoken/4c8b748e07992c00386f3180af5c574b27b65139/LICENSE)을 보완한다. 출처·commit·해시는 `tooling/distribution/notices/provenance.json`에 고정하며 다른 버전으로 자동 재사용하지 않는다.

## 산출물

|파일|내용|
|---|---|
|distribution-sbom.json|실제 Runner/Bridge/UI 입력 구성 목록과 Node binary·원본 고지 해시|
|notices/runner, notices/bridge|각 번들의 구성요소별 원본 고지·inventory.json|
|ui/notices/runner-ui|UI에 실제 포함된 구성요소의 고지|
|NODE-LICENSE.txt|고정 Node 배포에 포함된 전체 원본 고지|
|LICENSE|사용자가 선택한 자체 코드·Studio Runner의 MIT 라이선스 원문|
|build-manifest.json|위 파일을 포함한 실제 배포 후보 파일 목록·크기·해시|

현재 구성 목록은 `studio-distribution-inputs` 내부 형식이며 SPDX/CycloneDX 표준 인증을 주장하지 않는다. 이전 UI dist를 재사용할 때도 목록에 적힌 고지 파일을 실제 바이트로 다시 확인한다. 원문 누락·선언 누락·변조가 있으면 `noticeComplete=false` 또는 빌드 실패다.

## 출시와 구분

`noticeComplete`는 원문 수집의 완전성이다. `releaseApproved`는 이 도구에서 항상 false이며, 파일 목록 생성만으로 정식 배포가 승인되지 않는다. 제품 출시 gate의 `license-notices-complete` 관찰 증거는 실제 배포 해시에 연결된 별도 서명 보고서로 확인해야 한다.

2026-10-28: 사용자가 자체 서비스 코드와 Studio Runner의 **MIT 오픈소스 라이선스**를 선택했다. 저장소 루트와 8개 자체 패키지에 원문을 두고 package.json에 `license: MIT`를 선언한다. 배포물 루트의 LICENSE와 구성 목록에도 해당 원문의 해시를 기록한다. 문구는 [Open Source Initiative의 MIT 원문](https://opensource.org/license/mit)을 따른다. 제3자 코드, 사용자 자료, 자료별 이용 조건은 해당 원본 고지를 유지한다.

MIT 반영 후보 `artifacts/runner/win32-x64/2026-10-28T11-10-34-846Z`에서 `noticeComplete=true`와 실제19개 별도 프로세스 검사를 확인했다. 자체 LICENSE의 실제 바이트와 해시도 배포 목록에 포함된다. 공식 서명·설치·업데이트·깨끗한 Windows·세 호스트 실사용은 별도 남은 조건이고 `releaseApproved=false`는 유지한다.
