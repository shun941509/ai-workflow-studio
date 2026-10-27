# 관리 파일 저장 규격

`FileRef`의 유일한 구조 원본은 `packages/spec/schemas/file-ref.schema.json`이며 생성된 타입을 사용한다. 필드는 id, relativePath, filename, mimeType, bytes, sha256이다. relativePath는 표시용 논리 경로이고 파일 시스템 접근 인수가 아니다.

`ArtifactStore`는 한 개의 daemon lease를 가진 Runner 내부에서 사용한다. put(runId, operation), read(runId, fileId), resolve(runId, unknownReference)를 제공한다. runId는 인증한 서비스가 실제 실행 권한을 확인한 뒤 넘긴다. 모델이 제공한 runId·FileRef만으로 권한을 부여하지 않는다. 다른 실행 파일은 별도 승인된 복사로 새 참조를 발급해야 한다.

operationId는 논리 파일 작업 동안 유지한다. runId+operationId로 고정 ID를 만들며 같은 작업에 다른 이름·형식·바이트는 충돌이다. 재시작 후 동일 요청은 원본을 반환한다. 파일은 무작위 staging 안에 data와 record.json을 배타적으로 기록하고 fsync 후 디렉터리 rename으로 확정한다. staging은 결과로 읽지 않으며 중단된 staging 정리는 별도 유지관리 작업이다. 이 검증은 프로세스 재시작 내구성이고 전원 차단 시 저장 장치 보장은 별도 시험이다.

기본 한도는 파일16MiB/실행128MiB/100파일, 구성 상한은 파일128MiB/실행512MiB/1000파일이다. 같은 daemon의 동기적인 한도 확인·저장으로 동시 quota 초과를 막는다. 여러 프로세스가 저장소를 함께 쓰도록 제공하지 않는다. 전체 실행들의 디스크 보존량 한도와 고아 staging 정리는 후속 운영 작업이다.

이름의 경로 구분자·ADS·예약 이름·정규화 모호성을 거부하고, 실제 저장에는 고정 data 파일명만 사용한다. 경로의 junction/symlink, hardlink, 목록 밖 파일, 크기·원본해시 변경을 차단한다. 파일 읽기는 열린 descriptor에서 정해진 최대 바이트까지만 수행한다. MIME은 선언된 메타데이터이며 안전한 내용이라는 인증이 아니다. 다운로드 구현은 항상 attachment와 nosniff를 적용하고 HTML을 로컬 앱 origin에서 렌더하지 않아야 한다.

중요한 경계: 이 저장소는 같은 사용자 권한의 악성 OS 프로세스를 격리하는 샌드박스가 아니다. Worker에 저장소 쓰기 권한을 주면 안 된다. 일반 파일 API의 경로 검사로 모든 OS 수준 경합을 해결했다고 주장하지 않는다. 인증 API·SQLite artifact 인덱스·file_input/file_output handler·사용자 선택 파일 흐름은 별도 통합해야 하며 이 모듈만으로 블록 capability를 광고하지 않는다.

검증은 실제 파일로 재시작·원본 보존·중복/충돌·한도·타 실행 거절·위조 참조·바이트/메타 변경·hardlink/junction·중단 staging을 검사한다.

## 기본 파일 처리기

`artifacts/file-handlers.ts`는 file_input의 고정 참조·현재 실행·개수·MIME·크기 필터를 검사한다. MIME은 저장한 선언값이며 문서 파서에 의한 형식 확인을 대체하지 않는다. 사용자 파일 선택을 받는 업로드 API와 실행 간 자료 복사는 후속 통합 대상이다.

file_output은 `outputDirectory="outputs"`인 관리 저장소에 text(.txt), markdown(.md/.markdown), json(.json), csv(.csv), copy를 기록한다. 복사는 같은 실행의 검증된 파일만 읽으며 원본 확장자를 유지한다. PDF·DOCX·HTML·workerProfile·임의 OS 경로는 미지원 오류다. 공개 capability는 서비스와 실제 경로 검증을 연결한 뒤에만 올린다.

CSV 입력은 `{columns:string[], rows:Record<string,string|number|boolean|null>[]}`이다. 모든 행의 열이 일치해야 하며 최대100열/10000행이다. 한글용 UTF-8 BOM, CRLF 행 구분, 큰따옴표 이스케이프는 [RFC 4180](https://www.rfc-editor.org/info/rfc4180/) 형식에 따른다. 수식으로 해석될 수 있는 문자열/열 이름은 오류로 반환하며 원본이 필요한 사용자는 JSON으로 저장한다. 이는 [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection)의 위험 문자를 반영한 제품 정책이며, 모든 외부 스프레드시트 재저장 동작의 안전성을 보장하는 선언은 아니다. 문자열을 몰래 바꾸지 않는다.
