# AI Workflow Studio 작업 규칙

먼저 docs/specifications/{product-scope,architecture,runtime-and-package}.md와 docs/implementation/P2-detailed-spec.md, P3-P4-catalog-plan.md를 읽는다.

- 사용자는 계획 완료 뒤 로컬 구축·테스트까지 계속 진행하도록 승인했고, 2026-10-28 후속 요청에서 개발 완료 후 git push도 승인했다. 미완성 작업을 먼저 푸시하지 않는다. 서비스 게시·배포·계정/키 생성은 이 승인에 포함하지 않는다.
- 코드에는 주석을 반드시 작성한다. 모듈 역할, 공개 함수, 상태 전이, 승인/비밀정보/경로/트랜잭션 경계를 설명한다. JSON은 Schema description/$comment 또는 문서로 설명한다.
- JSON Schema가 Workflow/Node 타입의 유일한 기준이다. 타입은 생성한다. 호스트/HTTP 입력은 검증 전 unknown이다.
- spec/core는 파일·DB·네트워크에 접근하지 않는다. 앱끼리 내부 import 금지. ZIP 코드는 서버 전용이다.
- 사용자 UI·ZIP에 개발 모드·모의 모델·가짜 결과·fixture·테스트 키를 포함하지 않는다. 내부 테스트 대역은 tests에만 둔다.
- 사용자가 2026-10-28 자체 코드·Studio Runner의 MIT 오픈소스 라이선스를 선택했다. 루트·자체 패키지의 LICENSE를 보존하고 제3자·자료별 원본 이용 조건은 바꾸지 않는다.
- 실행 가능한 capability만 광고한다. 31개 스키마를 정의한 것과 31개 처리기를 구현·검증한 것은 다르다.
- 프로젝트120/자료120의 실제 검증·게시가 정식 출시 조건이다. 빈 항목·복제·ZIP변형을 완료 수에 넣지 않는다.
- 비밀정보를 명령 인수·로그·Git·ZIP에 쓰지 않는다. 실제 키가 없으면 설정 필요 상태로 유지한다.
- 독립 변경은 소유 파일을 나눠 병렬 작업한다. 루트 package.json·잠금파일·생성물 소유자는 통합 담당자 한 명이다.
- 검증 기록은 confirmed/partial/unverified/failed를 구분한다. 테스트 skip을 통과로 집계하지 않는다.
- 삭제·이동은 명시적으로 필요한 범위만 사용하고 Windows 경로를 확인한다. 사용자 전역 설정을 변경하지 않는다.

명령은 package.json과 docs/implementation/status.md를 확인한다. 개발은 Node24 LTS 고정 런타임으로 검증하며 사용자 ZIP에 개발 명령을 넣지 않는다.
