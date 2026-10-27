# 운영 파일 입력·출력 계약

현재 실제 지원 capability는 `node.file_input@1`, `node.file_output@1` 및 `file_output.text/markdown/json/csv/copy@1`이다. PDF·DOCX·HTML 변환, workerProfile, 임의 OS 폴더 내보내기는 실행 전 거절한다. 관리되는 `outputs`는 다운로드할 결과를 보관하는 공간이며 사용자 문서 폴더를 수정하는 기능이 아니다.

## file_output

`format=copy`는 `inputBindings.file`에 현재 실행의 등록된 FileRef가 필요하다. 나머지 형식은 `inputBindings.content`가 필요하다. text/markdown은 문자열, json은 JSON 값, csv는 `{columns:string[],rows:Record<string,string|number|boolean|null>[]}`를 받는다. CSV 위험 문자열은 변경하거나 실행하지 않고 오류를 반환한다.

node instance의 root run + scope/local node ID + 작업 종류에서 SHA-256 operationId를 만든다. 재시도 attempt ID를 포함하지 않으므로 같은 논리 작업은 재시작해도 같은 파일을 가리킨다. 먼저 ArtifactStore가 불변 바이트를 확정한 뒤 SQLite v5의 artifacts/artifact_metadata와 artifact.registered 이벤트를 한 트랜잭션으로 등록한다. 두 저장소 사이에서 중단되면 미등록 파일은 API로 읽을 수 없으며 같은 operationId 재시도만 동일 원본을 등록한다. 중단된 실행을 자동 재호출하지 않는 기존 복구 정책은 유지한다.

출력은 `{data:FileRef,files:[FileRef]}`이다. 하위 흐름에서도 루트 run의 파일 공간과 한도를 공유하고 scope ID를 포함하므로 같은 로컬 node ID가 충돌하지 않는다.

## file_input 사용자 선택

루트 흐름에서 `files:{from:"literal",value:[]}`는 실행 중 사용자의 명시 파일 선택을 요청한다. 실행 ID를 먼저 발급하고 kind=files인 영속 wait를 생성하므로 시작 전 임시 업로드나 다른 실행 파일을 암묵적으로 재사용하지 않는다. 비어 있지 않은 files는 같은 run에 등록되고 원본이 검증된 참조만 허용한다.

대기는 원래 runId·nodeInstance·planHash·요청 ID·응답 schema·만료 시각에 고정된다. 사용자가 파일 선택 후 **선택한 파일로 진행**을 누를 때 업로드하고 선택한 목록을 제출한다. 브라우저 새로고침과 daemon 재시작 뒤 기존 업로드와 대기를 복원한다. 동일 업로드 ID/바이트는 멱등이며 다른 바이트는 충돌이다. 응답 ID 중복과 다른 본문 충돌은 기존 영속 대기 계약을 따른다. 취소·만료 후에는 업로드·응답·후속 실행을 거절하고 기다린 시간은 활성 예산에서 제외한다.

파일 응답은 이 wait에서 사용자가 업로드한 FileRef만 수락한다. 배열 길이와 중복·MIME·크기·현재 run·모든 참조 필드·저장 바이트를 다시 검사한다. 일반 대기 validator의 비신뢰 정규식 금지 정책을 유지하므로 파일 선택용 responseSchema는 정규식 없는 구조 검사를 수행하고 ArtifactStore가 별도로 전체 신뢰 FileRef 스키마와 저장본을 대조한다.

MIME은 브라우저가 선언한 자료이며 파일 내용 안전성 인증이 아니다. 브라우저 File API에서 선택한 바이트만 업로드하며 사용자 OS 경로는 API 인수가 아니다. 기본 파일당16MiB/실행128MiB/100파일과 블록의 더 작은 한도를 함께 적용한다. PDF 업로드가 허용되어도 PDF 추출·변환 capability가 생기지 않는다.

현재 하위 흐름 내부의 빈 files 사용자 대기는 미지원이다. 루트에서 파일을 선택하고 같은 run FileRef를 하위 흐름으로 전달하는 경로는 지원한다.

## 로컬 API 및 UI

| 동작 | 경로 | 인증·내용 |
|---|---|---|
| 파일 업로드 | `POST /api/runs/:runId/waits/:waitId/files` | 쿠키+동일 Origin+CSRF+same-origin fetch metadata 필수. Authorization 헤더가 있으면 유효 쿠키가 함께 있어도 거절한다. |
| 업로드 메타데이터 | 위 요청 헤더 | content-type=application/octet-stream, x-studio-filename=encodeURIComponent(표시 이름), x-studio-mime-type, x-studio-upload-id. body는 제한된 원본 바이트다. |
| 선택 확인 | `POST /api/runs/:runId/waits/:waitId/responses` | 같은 브라우저 인증. `{requestId,response:FileRef[]}`. MCP 자동 응답 도구 없음. |
| 파일 내려받기 | `GET /api/runs/:runId/artifacts/:fileId` | 인증된 현재 run의 SQLite 등록본만 읽는다. attachment, application/octet-stream, nosniff, no-store. 전달한 경로로 원본을 열지 않는다. |
| 파일 목록 | status/results의 files | `{reference,source,operationId,waitId}`. 실제 바이트나 원본 OS 경로는 응답에 포함하지 않는다. |

UI는 원본 선택 파일과 생성 파일을 구분해 파일명·바이트·다운로드 버튼을 제공한다. HTML·Markdown·PDF를 로컬 앱 origin에서 inline 렌더하지 않는다. AI 연결이 필요 없는 파일 작업은 연결 추가를 요구하지 않는다.

## 검증 증거

- `tests/integration/runner-files.test.ts`: 실제 SQLite·파일·HTTP, 3종 운영 ZIP, 등록·중복·scope·재시작·잘못된 참조·취소·만료·MIME/개수/크기·인증·다운로드 헤더.
- `tests/security/artifact-store.test.ts`: 실제 파일 저장소와 직렬화 처리기의 무결성·경로·할당량 검증.
- `tests/integration/check-runner-files-ui.ts`: runner-ui 생산 빌드 후 pinned Node/tsx로 실행한다. 실제 Chromium에서 ZIP 가져오기→준비 확인→실행→파일 선택/명시 제출→원본 바이트 다운로드를 검증한다. 외부 모델 계정이나 모의 제품 모드를 사용하지 않는다.

디스크 전체 보존량, 중단 staging 정리, 파일 삭제/보존 UI, 외부 파일 변환기와 다중 사용자 공유는 아직 별도 후속 작업이다.
