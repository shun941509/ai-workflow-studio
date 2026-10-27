# 페이지 인용 Skill

페이지·구간 매핑 코드. 이 자료는 독립적으로 사용할 수 있는 원본 Agent Skill입니다.

## 사용

Codex·Claude Code·OpenCode용 자료 ZIP에서 Skill은 map-page-citations 이름의 호스트 Skill 폴더에 같은 상대 구조로 제공됩니다. SKILL.md를 먼저 읽고 필수 입력을 준비하세요. 입력→결과: 본문·인용 → 위치. 연결 설계: skill·document_extract·program.

동봉된 로컬 도우미는 Node.js 24와 해당 호스트의 실행 허용이 필요합니다. 코드를 읽을 수 있는 것과 안전한 격리 실행을 지원하는 것은 별개입니다. 실제 모델이나 외부 도구 연결은 사용 환경에서 준비합니다. 가져오기만으로 실행하거나 권한을 늘리지 않습니다.

## 자료 구분

references/example-input.json과 기타 예의 기관·업무·기록·수치는 모두 가상 연습자료입니다. 실제 모델·외부 서비스 실행 기록이 아닙니다. 출력 틀은 assets/result.md, 방법은 references/method.md에 있습니다. 원본 자료의 사용·수정·재배포 조건은 LICENSE.md를 따르며 제3자의 권리는 포함하지 않습니다.

## 확인 기준

원본에서 인용 확인. 이 버전은 콘텐츠와 파일·코드·ZIP 검사 대상으로 작성됐으며 실제 호스트 사용·검수·게시는 별도입니다. 원본 파일을 수정하면 descriptor 버전과 모든 원본 해시를 명시적으로 갱신해야 합니다.
