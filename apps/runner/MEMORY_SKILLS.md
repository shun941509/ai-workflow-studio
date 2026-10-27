# 실행 기억과 Skill 지침 계약

지원 capability는 `node.memory@1 + memory.run@1`, `node.skill@1 + skill.instructions@1`이다. `memory.project`, `skill.execute`, 외부 연결/종속 자료가 필요한 Skill은 실행 전 차단한다. 이는 31개 블록의 모든 모드를 구현했다는 의미가 아니다.

## memory.run

입력은 key와 put일 때의 명시 value다. null도 값이며 존재 여부는 found로 구분한다. 출력 data는 다음 구조다.

```json
{
  "scope": "run",
  "key": "summary",
  "operation": "get",
  "found": true,
  "value": {"text": "확인된 자료"},
  "version": 2,
  "expiresAt": null,
  "lastCommit": {"sequence": 12, "operationId": "memory_hash", "operation": "put", "at": "2026-10-28T00:00:00.000Z"}
}
```

- SQLite v6는 run_memory의 키/값/버전/만료/마지막 commit과 memory_operations의 요청 hash/확정 결과를 보관한다. 기존 루트 run의 scope만 사용하므로 하위 흐름은 같은 기억을 공유하고 다른 run은 접근할 수 없다.
- operationId는 root run + scope/local node instance + 작업 종류의 고정 해시다. 같은 operation의 재전송은 최초 결과를 반환하고 다른 본문은 충돌한다. 이전 put 재전송으로 나중 write를 덮어쓰지 않는다. get도 최초 관찰 결과가 고정되며 새 노드/반복의 get은 새 관찰이다.
- put/delete/TTL 만료는 키 버전을 1 올린다. 병렬 쓰기는 **SQLite에 마지막으로 commit한 값이 최종 값**이다. 각 결과의 version과 lastCommit.sequence로 실제 순서를 확인한다. 실행마다 선언된 분기 순서로 승자를 고정한다고 약속하지 않는다.
- TTL은 put에서만 1밀리초~30일이며 생략하면 현재 run의 보존 기간 동안 유지된다. 새 접근에서 만료를 확인하여 tombstone과 이벤트를 같은 트랜잭션에 남긴다. 만료 뒤 found=false/value=null이고, 존재한 적 없는 키는 version=0/lastCommit=null이다. TTL은 현재 기억의 유효기간이며 이전 노드 결과·멱등 응답 기록을 삭제하는 개인정보 보존 정책이 아니다.
- 키는 제어문자를 제외한 1~256자, 값은 일반 JSON 1MiB 이하, 실행당 키1000개이다. 현재 값과 멱등 결과 기록 합계16MiB를 제한한다. 한도 초과는 값·이벤트·operation 전체를 rollback하고 실행을 차단한다.
- SQLite BEGIN IMMEDIATE 안에서 기억 변경, 버전, audit 이벤트, 멱등 ledger를 함께 확정한다. 이벤트에 저장 값은 복제하지 않는다. 재시작 후 확정 기억과 결과를 보존하되 중단된 실행을 자동 재호출하지 않는다.

프로젝트 기억은 workflowId 문자열만으로 권한을 부여하지 않는다. 별도의 신뢰된 project workspace 권한이 구현될 때까지 공개 capability와 처리 경로를 제공하지 않는다.

## skill.instructions

지침 모드는 모델을 호출하거나 코드를 실행하지 않고 다음 묶음을 반환한다.

```text
data.resource = {alias,id,revision,sha256}
data.metadata = SKILL.md의 검증된 YAML frontmatter
data.instructions = frontmatter를 제외한 원본 본문
data.references = references/의 고정 파일 뷰
data.assets = assets/의 고정 파일 뷰
data.excludedFiles = scripts/ 또는 선택하지 않은 파일의 해시·크기·제외 이유
data.arguments = 명시적으로 연결했을 때만 전달한 인수
```

모든 파일은 resource.json의 고정 목록·크기·해시를 먼저 검사한다. UTF-8 텍스트인 references/assets는 `{path,bytes,sha256,trust:"untrusted",content:"text",text}`로 반환한다. 이진 자료는 `content:"binary_metadata"`이며 해시·크기만 반환한다. scripts/는 `execution_not_supported` 메타데이터만 반환한다. 문자열 템플릿의 코드를 실행하거나 자동 치환하지 않는다. 지침 mode에 entrypoint/workerProfile/resultSchema 실행 옵션을 지정하면 오류다.

AI 소비는 명시적 연결이 있을 때만 발생한다.

1. `ai.attachments=[{resource:"alias",role:"skill"}]`: SKILL 본문만 명시 지침으로 조립하고 보조 텍스트는 기존 untrustedReferences 데이터로 전달한다. role=instructions/reference로 Skill 종류를 우회할 수 없다.
2. 노드/자료 binding: `/data/instructions`, `/data/references/...`, `/data/assets/...`를 명시한 입력에 전달한다. binding이 모델 입력을 선택했다고 해서 모델의 지침·도구 권한을 자동 변경하지 않는다.

자료를 패키지에 포함한 것만으로 모델 지침에 추가하지 않는다. 인수·문서·assets·지침 어느 쪽도 파일/네트워크/도구 권한을 부여하지 않으며 scripts와 이진 파일을 모델에 암묵 전송하지 않는다. 파일당256KiB/전체 자료1MiB 제한을 유지한다.

## 검증

`tests/integration/runner-memory-skills.test.ts`는 실제 운영 ZIP·SQLite·자료 해시 경로에서 3호스트 Skill→기억 저장→조회, null/미존재, 재시작/TTL/중복/충돌/병렬 last commit/타 run 격리/할당량 rollback, 명시 첨부와 binding, 무첨부 비소비, 실행/역할/외부 연결 거절을 검사한다. 모델 입력 전달 시험만 외부 계정 경계에 시험 대역을 사용한다. 실제 모델 API를 호출하거나 품질 성공을 주장하지 않는다.
