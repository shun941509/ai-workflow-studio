# P1-01~P1-06 대화에서 확정한 상세 설계

> 이전 계획 답변의 원문을 보존한 설계 기준입니다. 아래의 ‘구현하지 않음’은 당시 상태이며, 현재 구현·검증 상태는 `docs/implementation/status.md`를 따릅니다. 출시 수량은 이후 확정한 각각 120개 전체 검증·게시 기준을 적용합니다.

**구현은 진행하지 않고, 아래 내용을 `Studio v1`의 P1 상세 명세안으로 정리합니다.** 파일 생성·코드 작성·실행 검증은 하지 않았습니다.

이번 명세는 기존에 정한 **31개 블록, RAG 확장, Studio Runner, 운영용 ZIP, 공식 예제 120개와 자료 및 도구 120개**를 개발할 때 사용할 기준입니다. 참고 저장소의 블록 이름은 유지하지만, 기존 저장 파일과의 직접 호환을 전제로 하지 않습니다. 기존 파일을 가져오려면 별도의 변환기가 필요합니다.

문서에서 **필수**는 구현·검증을 반드시 해야 하는 사항이며, JSON 예시는 이 규칙을 설명하는 예시입니다.

---

**1. P1-01 — 제품 범위와 운영 화면을 확정합니다.**

예정 명세 파일:

- `docs/specifications/product-scope.md`
- `docs/specifications/navigation.md`
- `docs/specifications/production-policy.md`

| 항목 | v1 기준 |
|---|---|
| 사용자 | 비전문가가 예제를 복사하거나 블록을 연결해 프로젝트 제작 |
| 관리자 | 공식 예제 제작·검수·게시·신고 처리·배포 중단 |
| 편집기 | 운영 가능한 설정만 제공 |
| 실행 | Studio Runner가 실행 순서·권한·상태·복구 담당 |
| 지원 호스트 | Codex·Claude Code·OpenCode |
| 공식 콘텐츠 | 프로젝트 120개, 자료 및 도구 120개 |
| 지원 환경 | Windows 우선. 구체적인 지원 버전·에디션은 설치·격리 검증 후 지원표에 기록 |
| 자료 종류 | MCP 연결 정의, 작업 지침, 문서, Skill |
| 공유 | 프로젝트 또는 자료의 특정 버전을 공개하고 독립적으로 복사 |
| 제외 | 사용자용 개발 모드, 모의 결과, 개발 ZIP, 테스트 키 |

메뉴는 다음 8개로 고정합니다.

| 메뉴 | 경로 |
|---|---|
| 홈 | `/` |
| 내 프로젝트 | `/projects` |
| 도구 및 자료 | `/resources` |
| 프로젝트 둘러보기 | `/explore/projects` |
| 도구 및 자료 둘러보기 | `/explore/resources` |
| 예제 프로젝트 | `/examples` |
| 예제 자료 및 도구 | `/examples/resources` |
| 사용 가이드 | `/guide` |

프로필 버튼은 `/account`로 이동합니다. 관리자 화면은 권한이 있는 사용자에게 별도로 제공하며, 일반 메뉴에 추가하지 않습니다.

편집기 구성은 다음과 같습니다.

| 위치 | 구성 |
|---|---|
| 상단 | 이름, 저장 상태, 준비 상태 확인, ZIP 다운로드 |
| 왼쪽 | 블록 목록, 사용할 도구 및 자료 |
| 가운데 | 워크플로 캔버스 |
| 오른쪽 기본 탭 | 이름, 작업 내용, 해당 블록의 주요 설정 |
| 오른쪽 자료·도구 탭 | 지침·문서·Skill·MCP 연결 |
| 오른쪽 입력·결과 탭 | 입력 참조, 결과 형식, 다음 블록 연결 |
| 고급 설정 | 제한 시간, 재시도, 반복·병렬 상한 등 |

**운영용 화면에도 연결 점검·권한 안내·사용량·오류·취소·복구 기능은 포함합니다.** 이 기능들은 개발자 도구가 아니라 실제 사용에 필요한 기능입니다.

P1-01 검증 기준:

- 메뉴·경로·접근 권한에 충돌이 없다.
- 사용자 화면에 개발 모드나 가짜 실행 기능이 없다.
- 미구현 기능을 실행 가능한 기능처럼 표시하지 않는다.
- 공식 예제와 사용자 공유 자료를 구분한다.
- 다른 사용자가 복사한 프로젝트를 원본 수정으로 덮어쓰지 않는다.

---

**2. P1-02 — 설계·화면·실행 상태·비밀정보를 분리합니다.**

예정 명세 파일:

- `docs/specifications/workflow-format.md`
- `docs/specifications/resource-references.md`
- `docs/specifications/retrieval-contract.md`

| 데이터 | 저장 위치 | 포함 내용 |
|---|---|---|
| 실행 설계 | `workflow.json` | 노드, 연결, 입력·결과 계약, 자료 참조, 실행 제한 |
| 편집 상태 | `editor.json` | 위치, 확대 비율, 화면 배치 |
| 배포 선언 | `manifest.json` | 파일 목록, 권한 요청, 호환성, 해시 |
| 배포 의존성 | `runtime.lock.json` | 실행 구성요소·도구 스키마·검증 버전 |
| 배포 자료 | `resources/` | 지침·문서·Skill·연결 정의 |
| 확정 실행 계획 | Runner 내부 저장소 | 실제 사용할 버전·프로필·자료·권한 범위 |
| 실행 상태 | Runner의 SQLite | 노드 상태, 대기, 승인, 시도, 외부 작업 기록 |
| 비밀정보 | OS 보안 저장소 | API 키, OAuth 토큰 등 |

`workflow.json`과 ZIP에는 실제 승인 기록, 인증정보, 개인 실행 이력을 넣지 않습니다.

공통 형식은 **JSON Schema Draft 2020-12**로 정의하고, 이 스키마에서 TypeScript 타입과 검증기를 생성합니다. 별도의 수작업 타입을 실행 규격의 또 다른 기준으로 만들지 않습니다. [JSON Schema 규격](https://json-schema.org/draft/2020-12)

**버전 필드는 서로 다른 의미로 사용합니다.**

| 필드 | 예시 | 의미 |
|---|---|---|
| `schemaVersion` | `"1.0.0"` | 문서 형식 |
| `typeVersion` | `1` | 해당 블록의 설정·실행 의미 |
| `revision` | `7` | 사용자가 저장한 설계 버전 |
| `packageVersion` | `"1.2.0"` | 배포 패키지 버전 |
| `generationId` | `"gen_..."` | 불변 색인 세대 |
| `planRevision` | `2` | 한 실행 안에서 생성한 계획 버전 |

이번 최초 규격에는 RAG 확장까지 포함합니다. 이후 블록의 필수 설정이나 실행 의미가 바뀌면 해당 `typeVersion`을 올립니다.

---

**3. `workflow.json`의 최상위 구조는 다음으로 고정합니다.**

| 필드 | 필수 | 형식·규칙 |
|---|---:|---|
| `schemaVersion` | 필수 | 지원하는 규격 버전 |
| `id` | 필수 | 워크플로 식별자 |
| `revision` | 필수 | 1 이상의 정수 |
| `name` | 필수 | 사용자에게 표시할 이름 |
| `description` | 선택 | 설명 |
| `entryNodeId` | 필수 | 시작 노드 ID |
| `inputs` | 필수 | 실행 입력의 JSON Schema |
| `outputs` | 필수 | 최종 `data` 결과의 JSON Schema |
| `modelProfiles` | 필수 | 논리적 모델 프로필 요구 사항. 없으면 `{}` |
| `resources` | 필수 | 자료 별칭 → 고정 자료 참조. 없으면 `{}` |
| `subworkflows` | 필수 | 내장 하위 흐름. 없으면 `{}` |
| `nodes` | 필수 | 노드 배열 |
| `edges` | 필수 | 제어 연결 배열 |
| `policy` | 필수 | 실행 제한과 안전 정책 |

`inputs`는 실제 사용자 입력값이 아닙니다. 실제 값은 실행 시작 요청으로 전달합니다.

`modelProfiles`에는 API 키나 사용자 계정을 넣지 않습니다.

```json
{
  "text-default": {
    "kind": "chat",
    "requiredFeatures": ["text"]
  },
  "embedding-default": {
    "kind": "embedding",
    "requiredFeatures": ["embedding"]
  }
}
```

Runner가 실행 준비 과정에서 이 별칭을 사용자의 실제 모델 설정에 연결합니다. 실제 모델 식별자·설정은 확정 실행 계획에 기록합니다.

**흐름의 구조 규칙**

1. 각 흐름에는 시작 노드가 하나 있어야 합니다.
2. 최종 `output` 노드도 하나 있어야 합니다.
3. 모든 정상 성공 경로는 최종 출력으로 연결되어야 합니다.
4. 오류·차단·취소 경로는 성공 출력 없이 종료할 수 있습니다.
5. 일반 연결의 순환은 금지합니다. 반복은 `loop`로 표현합니다.
6. 부모 흐름과 하위 흐름의 노드 배열을 섞지 않습니다.
7. 다른 흐름의 노드 결과를 직접 참조하지 않습니다.
8. 하위 흐름끼리의 재귀 호출도 v1에서는 금지합니다.
9. 노드 ID와 연결 ID는 해당 흐름 안에서 중복될 수 없습니다.
10. 화면 위치가 달라져도 실행 의미는 바뀌지 않습니다.

---

**4. 31개 블록은 하나의 공통 노드 구조를 사용합니다.**

| 필드 | 의미 |
|---|---|
| `id` | 흐름 내부에서 고유한 노드 ID |
| `type` | 31개 블록 중 하나 |
| `typeVersion` | 블록 계약 버전 |
| `label` | 사용자 표시 이름 |
| `description` | 선택 설명 |
| `inputBindings` | 입력 필드별 값 또는 참조 |
| `config` | 블록별 설정 |
| `attachments` | 추가 지침·자료·Skill·도구 참조 |
| `execution` | 제한 시간·재시도·오류 처리 |

공통 스키마의 골격은 다음과 같습니다. 참조하는 스키마도 공통 패키지에 포함하며, 실행 중 인터넷에서 가져오지 않습니다.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:ai-workflow-studio:schema:node-common:1.0.0",
  "type": "object",
  "required": [
    "id",
    "type",
    "typeVersion",
    "label",
    "inputBindings",
    "config",
    "attachments",
    "execution"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
    },
    "type": {
      "enum": [
        "input", "form", "trigger",
        "agent", "ai", "classify", "output", "tool",
        "retrieval", "knowledge", "resource", "skill",
        "memory", "compensate", "transform", "program",
        "candidate_search", "merge", "condition",
        "guardrail", "evaluate", "error", "review",
        "file_input", "document_extract", "file_output",
        "parallel", "agent_team", "orchestrator",
        "subworkflow", "loop"
      ]
    },
    "typeVersion": {
      "type": "integer",
      "minimum": 1
    },
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "inputBindings": {
      "type": "object",
      "additionalProperties": {
        "$ref": "urn:ai-workflow-studio:schema:binding:1.0.0"
      }
    },
    "config": {
      "type": "object"
    },
    "attachments": {
      "type": "array",
      "items": {
        "$ref": "urn:ai-workflow-studio:schema:attachment:1.0.0"
      }
    },
    "execution": {
      "$ref": "urn:ai-workflow-studio:schema:execution:1.0.0"
    }
  },
  "additionalProperties": false
}
```

이 공통 스키마만으로 노드를 통과시키지 않습니다. 최종 검증기는 `type + typeVersion`으로 구분되는 **31개 타입별 스키마**를 추가 적용합니다.

예정 파일 구조:

```text
packages/spec/schemas/
  workflow.schema.json
  flow.schema.json
  node-common.schema.json
  node.schema.json
  binding.schema.json
  attachment.schema.json
  execution.schema.json
  resource-ref.schema.json
  nodes/
    input.v1.schema.json
    ai.v1.schema.json
    ...
    loop.v1.schema.json
```

각 블록의 Registry 항목에는 다음이 필요합니다.

| 항목 | 용도 |
|---|---|
| `configSchema` | 설정 검사 |
| `inputSchema` | 바인딩 해석 후 실제 입력 검사 |
| `outputSchema` | 실행 결과 검사 |
| `controlPorts` | 연결 가능한 입력·출력 포트 |
| `requiredCapabilities` | 모드별 필요한 실행 기능 |
| `handlerId` | Runner에 등록된 실행 처리기 |
| `uiDefinition` | 오른쪽 설정 패널 구성 |

`handlerId`는 설치된 Runner의 등록 항목입니다. ZIP에서 임의 모듈 경로나 실행 코드를 처리기로 지정할 수 없습니다.

---

**5. 입력 연결은 `Binding`으로 표현합니다.**

| `from` | 필수 필드 | 참조 대상 |
|---|---|---|
| `literal` | `value` | JSON 값 자체 |
| `workflowInput` | `pointer`, `onMissing` | 현재 흐름의 실행 입력 |
| `node` | `nodeId`, `pointer`, `onMissing` | 같은 흐름의 선행 노드 결과 |
| `resource` | `resource`, `pointer`, `onMissing` | 선언된 자료의 공개 데이터 |
| `error` | `pointer`, `onMissing` | 오류 처리 노드에 전달된 오류 문맥 |

```json
{
  "question": {
    "from": "workflowInput",
    "pointer": "/question",
    "onMissing": "error"
  },
  "context": {
    "from": "node",
    "nodeId": "search",
    "pointer": "/data/candidates",
    "onMissing": "default",
    "defaultValue": []
  },
  "language": {
    "from": "literal",
    "value": "ko"
  }
}
```

필수 규칙:

- `literal`에 `nodeId`나 `pointer`를 함께 넣지 않습니다.
- `onMissing`은 `error`, `default`, `omit` 중 하나입니다.
- `defaultValue`는 `onMissing: "default"`일 때만 허용하며 필수입니다.
- `null`은 실제 값입니다. 경로가 없는 경우와 구분합니다.
- 문자열을 숫자로 바꾸는 등의 자동 형 변환은 하지 않습니다.
- `omit`으로 필수 입력이 사라지면 해당 노드의 입력 검사에서 실패합니다.
- JSON Pointer의 빈 문자열은 참조 대상 전체를 의미합니다.
- 자격증명은 Binding으로 읽을 수 없습니다.
- 사용자 입력에 포함된 코드를 Binding이나 조건식으로 실행하지 않습니다.

**공통 결과 형식**

```json
{
  "data": {
    "summary": "회의에서는 일정 조정과 담당 업무가 결정되었습니다."
  },
  "text": "회의에서는 일정 조정과 담당 업무가 결정되었습니다.",
  "files": [],
  "sources": [],
  "effects": []
}
```

`data`는 필수이며 JSON 값입니다. 나머지는 선택입니다.

- 노드 결과 참조는 이 전체 객체를 기준으로 하므로 `/data/summary`처럼 작성합니다.
- 모델이 `effects`라는 문자열이나 객체를 생성해도 확인된 외부 작업으로 인정하지 않습니다.
- 실제 `EffectRef`는 Runner의 외부 작업 기록에서만 생성합니다.
- 출처 참조가 존재한다는 사실과 주장 내용이 옳다는 판단도 구분합니다.

---

**6. 자료 연결과 실행 권한은 별개로 관리합니다.**

`resources`는 자료 별칭을 고정된 자료 버전에 연결합니다.

| 참조 | 필수 내용 |
|---|---|
| `ResourceRef` | 종류, 자료 ID, revision, 자료 구성 목록의 SHA-256 |
| `ToolRef` | 연결 별칭, 도구 이름, 도구 스키마 해시 |
| `FileRef` | 관리되는 파일 ID, 상대 경로, 크기, MIME, 파일 해시 |
| `SourceRef` | 출처 ID·버전, 문서 위치, 필요한 원문 해시 |
| `FlowRef` | 내장 흐름 ID 또는 외부 워크플로 ID·revision·해시 |
| `EffectRef` | Runner가 발행한 확인된 외부 작업 ID |
| `IndexRef` | 색인 ID, generationId, 형식 버전, 구성 해시 |

자료 종류는 `mcp`, `instruction`, `document`, `skill`로 구분합니다. 코드·템플릿·평가 자료는 이 자료들의 구성 파일로 포함할 수 있습니다.

첨부 예시:

```json
{
  "attachments": [
    {
      "resource": "writing-guide",
      "role": "instructions"
    },
    {
      "resource": "product-manual",
      "role": "reference"
    },
    {
      "resource": "report-skill",
      "role": "skill"
    }
  ]
}
```

첨부 역할은 `instructions`, `reference`, `skill`, `tool`, `knowledge`, `template`로 제한하고, 블록별 허용 조합을 Registry에 정의합니다.

자료 선택만으로 다음 행동을 수행하지 않습니다.

- MCP 서버 실행·외부 서비스 연결
- Skill 코드 실행
- 문서 업로드
- 모델 호출
- 파일 변경
- 권한 부여

`config`나 Binding에서 이미 명시적으로 참조한 자료를 `attachments`에 중복 등록할 필요는 없습니다. 검증기는 모든 자료 참조를 모아 의존 관계를 계산합니다.

---

**7. 정상적인 `workflow.json` 전체 예시는 다음과 같습니다.**

이 예시는 `입력 → AI 요약 → 결과`입니다. 구조 검증용 예시이며, 실제 실행에는 `text-default`에 연결할 모델 설정이 필요합니다.

```json
{
  "schemaVersion": "1.0.0",
  "id": "wf_summary",
  "revision": 1,
  "name": "회의 메모 요약",
  "entryNodeId": "start",
  "inputs": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 20000
      }
    },
    "required": ["text"],
    "additionalProperties": false
  },
  "outputs": {
    "type": "string",
    "minLength": 1
  },
  "modelProfiles": {
    "text-default": {
      "kind": "chat",
      "requiredFeatures": ["text"]
    }
  },
  "resources": {},
  "subworkflows": {},
  "nodes": [
    {
      "id": "start",
      "type": "input",
      "typeVersion": 1,
      "label": "회의 메모",
      "inputBindings": {},
      "config": {},
      "attachments": [],
      "execution": {
        "timeoutMs": 60000,
        "retry": {
          "maxAttempts": 1,
          "backoffMs": 1000,
          "retryOn": []
        },
        "onError": "fail"
      }
    },
    {
      "id": "summarize",
      "type": "ai",
      "typeVersion": 1,
      "label": "핵심 요약",
      "inputBindings": {
        "content": {
          "from": "node",
          "nodeId": "start",
          "pointer": "/data/text",
          "onMissing": "error"
        }
      },
      "config": {
        "modelProfile": "text-default",
        "instructions": "입력 내용을 핵심 요점 3개로 요약하세요. 입력에 없는 사실은 추가하지 마세요.",
        "responseFormat": {
          "mode": "text"
        },
        "maxOutputTokens": 512
      },
      "attachments": [],
      "execution": {
        "timeoutMs": 60000,
        "retry": {
          "maxAttempts": 1,
          "backoffMs": 1000,
          "retryOn": []
        },
        "onError": "fail"
      }
    },
    {
      "id": "finish",
      "type": "output",
      "typeVersion": 1,
      "label": "요약 결과",
      "inputBindings": {
        "result": {
          "from": "node",
          "nodeId": "summarize",
          "pointer": "/data",
          "onMissing": "error"
        }
      },
      "config": {
        "format": "text"
      },
      "attachments": [],
      "execution": {
        "timeoutMs": 60000,
        "retry": {
          "maxAttempts": 1,
          "backoffMs": 1000,
          "retryOn": []
        },
        "onError": "fail"
      }
    }
  ],
  "edges": [
    {
      "id": "edge_start_summary",
      "from": {
        "nodeId": "start",
        "port": "next"
      },
      "to": {
        "nodeId": "summarize",
        "port": "in"
      }
    },
    {
      "id": "edge_summary_finish",
      "from": {
        "nodeId": "summarize",
        "port": "next"
      },
      "to": {
        "nodeId": "finish",
        "port": "in"
      }
    }
  ],
  "policy": {
    "approvalMode": "per_effect",
    "networkMode": "broker_only",
    "filesystemMode": "workspace_only",
    "limits": {
      "maxConcurrentNodes": 4,
      "maxNodeInstances": 1000,
      "maxModelCalls": 100,
      "maxTotalTokens": 200000,
      "maxActiveMs": 1800000,
      "maxChildDepth": 8
    }
  }
}
```

이 예시에서:

- `input.data`는 검증된 실행 입력 전체입니다.
- `ai`의 text 모드는 `data`에 문자열을 반환합니다.
- `output.data`는 `inputBindings.result`의 값입니다.
- `outputs` 스키마로 최종 결과를 검사합니다.
- 연결선은 실행 순서를, Binding은 실제 데이터 전달을 정의합니다.

예시 검증 기준:

| 변경 | 기대 결과 |
|---|---|
| 입력 `text` 누락 | 입력 검사 실패 |
| `start` 노드 삭제 | 시작 노드·연결 참조 오류 |
| `/data/text`를 존재하지 않는 경로로 변경 | 정적 판정 가능 시 사전 오류, 아니면 실행 입력 오류 |
| 문자열 대신 객체를 최종 출력 | `outputs` 계약 위반 |
| 모델 프로필 미설정 | 준비 상태에서 연결 필요 표시 |
| 모델 응답 빈 문자열 | 최종 결과 검사 실패 |
| 화면 위치만 변경 | 실행 설계와 실행 결과 계약 유지 |

---

**8. P1-03 — 31개 블록의 계약을 다음으로 고정합니다.**

예정 파일:

- `docs/specifications/node-contracts.md`
- `docs/specifications/support-matrix.md`
- `packages/spec/schemas/nodes/*.v1.schema.json`

아래 표는 각 블록의 핵심 설정입니다. 공통 실행 설정은 별도로 적용합니다.

| 타입 | 입력 | 주요 `config` | `data` 결과·실행 규칙 |
|---|---|---|---|
| `input` | 실행 요청 입력 | `{}` | 검증된 입력 전체. 시작 노드로 사용 |
| `form` | 문맥, 초기값 | `mode: initial/request`, `title`, 요청용 `schema` | 검증된 사용자 응답. initial은 루트 입력 계약 사용 |
| `trigger` | 예약 이벤트·입력 | 일정, `timeZone`, `misfire`, `overlap` | 발생 식별자·예정 시각·입력. 활성 상태는 로컬에 별도 저장 |
| `ai` | `content`, 선택 문맥 | 모델, 지침, 응답 형식, 최대 출력 토큰 | text는 문자열, json은 지정 스키마에 맞는 값 |
| `agent` | 목표, 문맥, 선택 색인 | 모델, 지침, 허용 도구, `maxSteps`, 결과 스키마, 전략 | `result`, `stopReason`, 사용 단계 |
| `classify` | 분류할 내용 | 모델, 라벨 ID·설명, 미분류 정책 | 라벨·근거. 해당 라벨 포트로 이동 |
| `output` | `result` | 표시 형식 | 최종 결과. 성공 출력 포트 없음 |
| `tool` | `arguments` | 고정 `ToolRef` | 검증된 도구 결과. 변경 작업은 별도 승인 정책 적용 |
| `retrieval` | 질의, `IndexRef`, 필터 | 검색 모드, 후보 수, 결합, reranker, 문맥 한도 | 검색 후보·점수·출처·추적 정보 |
| `knowledge` | 문서 또는 색인 참조 | `operation: build/update/open/delete`, 색인 프로필 | 색인 참조·처리 통계. 원문 삭제와 색인 삭제 구분 |
| `resource` | 선택 범위 | 자료 별칭, 선택 항목 | 자료 내용 또는 관리되는 파일 참조 |
| `skill` | Skill 인수 | 자료 별칭, `mode: instructions/execute`, 실행 항목 | 지침 묶음 또는 검증된 실행 결과 |
| `memory` | 키, 선택 값 | `operation: get/put/delete`, `scope: run/project`, TTL | 값·존재 여부·기록 정보 |
| `compensate` | 확인된 `EffectRef` | 등록된 보상 방법 | 별도 보상 작업 결과. 자동 롤백으로 취급하지 않음 |
| `transform` | `value` | 제한된 변환 단계, 결과 스키마 | 변환 결과. 임의 JavaScript 금지 |
| `program` | 실행 인수 | 코드 자료·파일 참조, Worker 프로필, 결과 스키마 | 격리 실행 결과 |
| `candidate_search` | 목표, 초기 후보 | tree/graph, 생성 흐름, 등록 검증기, 탐색 상한 | 후보·점수·선정 결과 |
| `merge` | 경로별 값 | `waitFor: all_active`, 결합 방식, 충돌 정책 | 활성 경로의 결과 결합 |
| `condition` | 판단할 값 | 제한된 조건 AST | 불리언. `true/false` 포트 선택 |
| `guardrail` | 검사 대상 | 규칙, 차단 기준 | 통과 값·검사 기록. 차단 시 일반 오류 복구 불가 |
| `evaluate` | 대상·기준 | `mode: rules/model`, 평가 스키마, 통과 조건 | 점수·`passed`·근거. 자동 분기하지 않음 |
| `error` | 오류 문맥, 선택 대체값 | `mode: recover/rethrow` | 복구 결과 또는 실패 종료 |
| `review` | 검토 대상 | 질문, 응답 형식 | 결정·피드백. `accepted/rejected` 포트 |
| `file_input` | 사용자 선택 파일 참조 | 허용 형식·개수·크기 | 검사된 `FileRef` 목록 |
| `document_extract` | 파일 | `mode: text/table/ocr`, 언어·추출 설정 | 텍스트·표·위치·불확실 항목 |
| `file_output` | 내용 또는 생성 파일 | 형식, 파일명, 허용 출력 위치 | 실제 생성 파일 참조 |
| `parallel` | 분기별 입력 | 분기 FlowRef, `all/first_match`, 동시성, 실패 정책 | 분기별 상태·결과, 선택 결과 |
| `agent_team` | 팀 목표·문맥 | 역할·FlowRef, `sequential/parallel`, 선택 통합 흐름 | 역할별 결과·통합 결과 |
| `orchestrator` | 목표·제약 | `plan/adaptive/dynamic`, 허용 흐름, 계획 모델, 재계획 상한 | 계획 이력·작업 결과·종료 이유 |
| `subworkflow` | 하위 입력 | 고정 `FlowRef` | 하위 흐름의 최종 결과 |
| `loop` | 목록 또는 상태 | `foreach/until`, body FlowRef, 중단 조건, 반복 상한 | 반복 결과·최종 상태·종료 이유 |

추가 의미를 다음과 같이 고정합니다.

| 항목 | 명세 |
|---|---|
| `form.initial` | 필요한 입력을 모두 받은 뒤 루트 `inputs`를 검사하고 후속 작업 시작 |
| `classify` | 라벨 ID 중복·예약 포트 이름 사용 금지. `unclassified` 포트를 별도 제공 |
| `ai` JSON 모드 | JSON 해석과 스키마 검증 모두 통과해야 성공. 숨겨진 무제한 수정 요청 금지 |
| `skill.instructions` | 지침·참조를 제공하며 코드를 실행하지 않음 |
| `skill.execute` | 지정한 실행 항목만 Worker에서 수행 |
| `memory` | 다른 사용자의 프로젝트 기억을 읽을 수 없음 |
| `condition` | 비교·논리·존재 검사 등 등록된 AST 연산만 허용 |
| `evaluate` | `passed`에 따라 이동하려면 `condition`을 연결 |
| `file_output` | 텍스트·JSON·CSV 등은 해당 생성기, DOCX·PDF 등은 검증된 변환 Worker 사용 |
| `parallel.first_match` | 외부 변경 없는 하위 흐름만 허용 |
| `orchestrator.plan` | 실행 계획만 출력 |
| `orchestrator.adaptive` | 허용된 흐름 안에서 실행하고 필요하면 계획 수정 |
| `orchestrator.dynamic` | 허용된 흐름 템플릿으로 작업을 조합. 임의 코드·도구 생성 후 실행 금지 |
| `candidate_search.graph` | 후보 탐색 구조를 뜻하며 GraphRAG 색인과는 별개 |
| `loop.foreach` | 시작 시 목록을 확정하고 입력 순서로 결과 반환 |
| `loop.until` | 본문 실행 후 중단 조건 검사. 최대 횟수 도달 원인을 결과에 기록 |

반복 본문의 기본 입력 계약은 다음으로 고정합니다.

- `foreach`: `{ item, index, context }`
- `until`: `{ state, iteration, context }`

부모의 다른 데이터가 필요하면 `context`에 명시적으로 전달합니다.

---

**9. 실행 연결과 합류 규칙을 명확하게 정의합니다.**

기본 포트는 입력 `in`, 성공 출력 `next`입니다.

| 블록 | 특별한 출력 포트 |
|---|---|
| `condition` | `true`, `false` |
| `classify` | 라벨 ID, `unclassified` |
| `review` | `accepted`, `rejected` |
| 오류 라우팅 지원 블록 | `error` |
| `output` | 없음 |

v1에서는 일반 노드의 제어 입력을 하나로 제한하고, 여러 경로의 합류는 `merge`로 표현합니다. 일반 노드의 `next`에서 여러 작업을 동시에 시작하는 대신 `parallel`을 사용합니다.

`merge.waitFor: "all_active"`의 의미는 다음과 같습니다.

1. 들어오는 경로마다 활성·비활성 여부를 확인합니다.
2. 비활성 경로는 기다리지 않습니다.
3. 활성 경로는 모두 완료될 때까지 기다립니다.
4. 모든 경로가 비활성이면 merge도 건너뜁니다.
5. 활성 경로에 미처리 실패가 있으면 실패 원인을 기록합니다.
6. 실패한 경로를 기다리며 무한 대기하지 않습니다.

예를 들어 다음 구조에서:

```text
조건
 ├─ true  → 요약 A ─┐
 └─ false → 요약 B ─┴→ merge → output
```

true가 선택되면 요약 B만 건너뜁니다. **merge와 output까지 함께 건너뛰면 안 됩니다.**

`merge`가 비활성 분기의 값을 참조할 경우 해당 Binding에는 `omit` 또는 `default` 처리가 필요합니다.

---

**10. RAG 확장은 기존 블록의 모드로 구현합니다.**

새 블록 이름을 추가하지 않습니다.

| 기능 | 중심 블록 |
|---|---|
| 문서 정제·추출 | `document_extract`, `transform`, `program` |
| 색인 생성·갱신 | `knowledge` |
| 키워드·벡터·Hybrid·그래프 검색 | `retrieval` |
| Agentic RAG | `agent`, `retrieval`, `form`, `subworkflow`, `loop` |
| 품질 측정 | `evaluate`, `review` |
| 고급 색인 처리 | 격리 Worker |

**RAG 공통 참조 계약**

| 객체 | 필수 정보 |
|---|---|
| `DocumentRef` | 문서 ID·revision·원본 해시·형식·출처 |
| `ChunkRef` | 청크 ID·문서 참조·내용 해시·원문 위치 |
| `IndexRef` | 색인 ID·generationId·형식 버전·구성 해시 |
| `IndexBuildManifest` | 입력 문서, 분할기, 모델·차원, 그래프 설정, 접근 범위, 상태 |
| `RetrievalCandidate` | 후보 ID·청크 또는 그래프 근거·순위·본문·출처·단계별 점수 |
| `RetrievalResult` | 질의·사용 색인·후보·검색 추적·경고 |
| `RagAnswer` | 답변 상태·답변·인용 |

원본 파일 해시와 정제 텍스트 해시는 구분합니다. 원문 위치에는 페이지·절·표 셀 등을 사용하고, 텍스트 범위를 사용할 때는 기준 텍스트 해시와 UTF-8 바이트 범위를 함께 기록합니다.

검색 결과의 점수는 종류를 구분합니다.

```json
{
  "candidateId": "handbook-v3-chunk-42",
  "rank": 1,
  "scores": [
    {
      "stage": "keyword",
      "kind": "bm25",
      "value": 8.2
    },
    {
      "stage": "vector",
      "kind": "cosine_similarity",
      "value": 0.83
    },
    {
      "stage": "fusion",
      "kind": "rrf",
      "value": 0.0325
    },
    {
      "stage": "rerank",
      "kind": "provider_relevance",
      "value": 0.91
    }
  ]
}
```

위 코드는 점수 필드 설명용 조각입니다. 실제 후보에는 청크·색인·출처 참조가 추가되어야 합니다.

BM25 점수와 벡터 유사도를 같은 척도의 숫자로 더하지 않습니다.

**Hybrid RAG 설정 예시**

다음은 `retrieval.config`의 예시입니다. 질의와 `IndexRef`는 `inputBindings`로 받습니다.

```json
{
  "mode": "hybrid",
  "keywordTopK": 30,
  "vectorTopK": 30,
  "fusion": {
    "method": "rrf",
    "k": 60
  },
  "candidateLimit": 40,
  "topK": 6,
  "reranker": {
    "modelProfile": "reranker-default",
    "timeoutMs": 15000,
    "onFailure": "fail"
  },
  "maxContextTokens": 6000
}
```

처리 순서는 고정합니다.

```text
현재 접근 권한 확인
→ 키워드·벡터 후보 검색
→ 동일 후보 정규화·중복 제거
→ RRF 순위 결합
→ candidateLimit 적용
→ reranker
→ topK 적용
→ 문맥 한도 적용
→ 출처를 유지한 결과 반환
```

RRF는 1부터 시작하는 순위에 대해 `Σ 1 / (k + rank)`로 계산합니다. 동점일 때는 후보 ID로 정렬해 순서를 안정적으로 유지합니다.

reranker가 입력 후보에 없던 ID를 반환하면 실패 처리합니다. 실패 시 원래 순위를 사용할지는 설정에 명시하며, 기본값은 `fail`입니다.

**Agentic RAG 설정 예시**

다음은 `agent.config`에 추가하는 설정 조각입니다.

```json
{
  "strategy": "agentic_rag",
  "maxSteps": 12,
  "retrievalPolicy": {
    "maxRounds": 4,
    "maxQueriesPerRound": 3,
    "maxRetrievedChunks": 100,
    "maxContextTokens": 12000,
    "onInsufficient": "abstain"
  }
}
```

필수 규칙:

- 사용할 색인은 입력으로 받은 허용 목록으로 제한합니다.
- 등록된 검색 도구만 호출합니다.
- 질문 분해·재작성·재검색도 전체 실행 예산에 포함합니다.
- `onInsufficient: "ask"`를 사용하려면 `form`을 포함한 질문용 하위 흐름을 지정해야 합니다.
- 추가 질문 후에도 기존 검색 횟수와 사용량을 초기화하지 않습니다.
- 충분한 근거를 찾지 못하면 불충분 상태로 종료합니다.
- 자연어 판단으로 도구·색인·네트워크 권한을 확대하지 않습니다.

답변 상태는 다음으로 제한합니다.

```text
answered
insufficient_evidence
conflicting_evidence
needs_clarification
```

검색 오류와 검색 성공 후 결과가 없는 경우도 구분합니다.

**GraphRAG 계약**

GraphRAG에는 개체·관계 추출, 커뮤니티 구성·요약, 검색이 포함됩니다. v1에서는 local 검색과 global 검색을 지원 범위로 둡니다. [GraphRAG 색인](https://microsoft.github.io/graphrag/index/overview/), [GraphRAG 검색](https://microsoft.github.io/graphrag/query/overview/)

| 영역 | 필수 규칙 |
|---|---|
| 개체 | 안정적인 ID, 유형, 별칭, 원문 근거 |
| 관계 | 출발·도착 개체, 관계 유형, 방향, 근거 |
| 별칭 통합 | 모호한 개체를 무조건 병합하지 않음 |
| 커뮤니티 | 구성 개체·관계와 색인 세대 기록 |
| 요약 | 의존 원문·관계·접근 범위 추적 |
| local 검색 | 실제 그래프 경로와 원문 근거 사용 |
| global 검색 | 사용한 커뮤니티 요약과 원문 근거 추적 |
| 비용 | 추출·임베딩·요약 호출 모두 Runner 중계 통과 |

**색인 수명과 접근 제어**

1. 새 색인은 별도의 불변 `generationId`로 만듭니다.
2. 생성·검증이 끝나기 전에는 활성 색인으로 사용하지 않습니다.
3. 실행은 사용할 색인 세대를 고정합니다.
4. 접근 권한은 검색 시점에도 다시 검사합니다.
5. 삭제·권한 철회는 즉시 조회 차단에 반영합니다.
6. 파생 청크·캐시·관계·요약도 무효화합니다.
7. 권한이 다른 자료를 섞어 만든 요약을 무조건 공유하지 않습니다.
8. 모델·분할·색인 설정이 바뀌면 해당 평가 기록도 다시 확인합니다.

실행 계획의 버전 고정이 권한 철회를 무시하는 근거가 되어서는 안 됩니다.

---

**11. P1-04 — Studio Runner의 실행 규칙을 고정합니다.**

예정 파일:

- `docs/specifications/execution-semantics.md`
- `docs/specifications/runner-protocol.md`
- `docs/specifications/worker-contract.md`
- `docs/specifications/security-boundaries.md`

실행 시작은 다음 순서로 처리합니다.

```text
패키지 검사
→ workflow 구조 검사
→ 그래프·입출력 의미 검사
→ 필요한 기능·모델·연결 확인
→ 실제 권한·예산 확인
→ 자료·도구·모델·색인 버전 확정
→ 불변 resolvedPlan 저장
→ run 생성·실행
```

**실행 식별자**

| 식별자 | 의미 |
|---|---|
| `runId` | 전체 실행 |
| `nodeInstanceId` | 반복·하위 흐름을 포함한 특정 노드 실행 단위 |
| `attemptId` | 해당 단위의 실행 시도 |
| `operationId` | 논리적으로 동일한 외부 변경 작업 |
| `waitId` | 사용자 입력·검토·승인 대기 |
| `planHash` | 실제 실행 계획의 해시 |

같은 외부 작업을 재시도하면 `attemptId`는 바뀌지만 `operationId`는 유지합니다.

**상태 모델**

| 대상 | 상태 |
|---|---|
| 노드 | `pending`, `ready`, `running`, `waiting_input`, `waiting_review`, `waiting_approval`, `retry_wait`, `reconciling`, `succeeded`, `failed`, `skipped`, `blocked`, `cancelled` |
| 실행 | `created`, `running`, `waiting`, `cancelling`, `attention_required`, `succeeded`, `failed`, `blocked`, `cancelled` |

- 병렬 작업 일부가 대기하더라도 다른 작업이 실행 중이면 전체는 `running`입니다.
- 실행할 작업 없이 사용자 응답만 기다릴 때 `waiting`입니다.
- 외부 변경 결과를 확정하지 못하면 `attention_required`로 표시합니다.
- 최종 출력이 있어도 미확인 외부 변경이 남아 있으면 성공 처리하지 않습니다.
- 상태 변경과 이벤트 기록은 같은 저장 트랜잭션으로 처리합니다.
- 이벤트에는 증가하는 순번을 부여합니다.

**공통 `execution` 계약**

```json
{
  "timeoutMs": 60000,
  "retry": {
    "maxAttempts": 1,
    "backoffMs": 1000,
    "retryOn": []
  },
  "onError": "fail"
}
```

| 필드 | 규칙 |
|---|---|
| `timeoutMs` | 실제 처리의 제한 시간. 대기 시간과 구분 |
| `retry.maxAttempts` | 최초 시도를 포함. 기본 1 |
| `retry.backoffMs` | 재시도 간 대기 시간 |
| `retry.retryOn` | 재시도를 허용할 오류 코드 |
| `onError` | `fail` 또는 `route` |
| `waitTtlMs` | 사용자 대기 블록에서 사용. 기본 24시간 |

기본값은 편집기가 노드를 만들 때 기록합니다. JSON Schema의 `default`만 믿고 런타임에서 값을 몰래 삽입하지 않습니다.

**초기 프로젝트의 실행 제한 기본값**

| 항목 | 기본값 |
|---|---:|
| 최대 동시 노드 | 4 |
| 최대 노드 실행 인스턴스 | 1,000 |
| 최대 모델 호출 | 100 |
| 총 토큰 한도 | 200,000 |
| 활성 실행 시간 | 30분 |
| 하위 흐름 최대 깊이 | 8 |

이 값은 프로젝트의 초기 설정입니다. 사용자가 변경할 수 있는 범위는 Runner 정책으로 제한합니다. 하위 흐름·Agent·GraphRAG가 별도 예산을 만들어 상한을 우회할 수 없습니다.

**예산 규칙**

- 병렬 호출 전에 사용량을 원자적으로 예약합니다.
- 입력·최대 출력 토큰 등 확인 가능한 상한을 기준으로 예약합니다.
- 실제 사용량을 받은 뒤 정산합니다.
- 결과를 확인하지 못한 호출의 예약을 즉시 반환하지 않습니다.
- 금액 추정과 호출·토큰·시간 제한을 구분합니다.
- 모델·임베딩·reranker·그래프 요약을 모두 집계합니다.

**승인과 외부 변경**

승인은 다음 대상에 묶습니다.

```text
planHash
+ operationId
+ 실제 작업 대상
+ 실제 인수의 정규화된 해시
+ 승인자
+ 승인 범위
+ 만료 시각
```

`review.accepted`는 업무 내용 검토 결과입니다. 파일 삭제·서비스 등록 같은 보안 승인을 대신하지 않습니다.

외부 변경 전에는 실행 의도와 요청 해시를 먼저 저장합니다.

| 상황 | 처리 |
|---|---|
| 호출 전 실패가 확실함 | 정책에 따라 재시도 가능 |
| 읽기 작업의 일시 오류 | 허용된 재시도 적용 |
| 멱등키를 지원하는 변경 | 같은 operationId로 제한 재시도 |
| 변경 후 응답 유실 | 결과 조회·멱등키 확인 등으로 조정 |
| 실행 여부를 확인할 수 없음 | 확인 필요 상태. 자동 재전송 금지 |

전체 외부 시스템에 대해 “정확히 한 번 실행”을 보장한다고 표시하지 않습니다. 대신 중복 방지와 결과 불명 처리를 명확히 구현합니다.

**오류·취소·복구**

- 일반 업무 오류만 `error` 경로로 복구할 수 있습니다.
- 권한 거부·보호 차단·전체 예산 소진·취소·외부 결과 불명은 일반 오류 처리로 성공 전환할 수 없습니다.
- 취소 요청을 먼저 저장한 뒤 신규 작업 시작을 중단합니다.
- 이미 완료된 외부 변경은 취소로 되돌아가지 않습니다.
- 보상은 확인된 `EffectRef`를 대상으로 별도의 작업·승인으로 수행합니다.
- 입력·검토 대기는 재시작 후 같은 `waitId`로 복원합니다.
- 응답은 대기 버전을 확인해 한 번만 수락합니다.
- 완료된 외부 작업을 복구 과정에서 다시 실행하지 않습니다.

**오케스트레이터의 재계획**

기존 실행 계획을 수정하지 않고 새로운 `planRevision`과 `planHash`를 만듭니다.

```text
새 계획 생성
→ 구조·권한·예산 검사
→ 필요한 사용자 확인
→ 실행 경계에서 전환
```

이미 실행 중인 작업과 확인된 외부 변경은 기존 기록을 유지합니다. 새 계획의 미실행 작업에 이전 승인을 그대로 적용하지 않습니다.

---

**12. Runner의 외부 인터페이스와 격리 경계를 정의합니다.**

Studio MCP 도구는 다음으로 시작합니다.

| 도구 | 역할 |
|---|---|
| `studio.inspect_package` | 패키지 구성·요구 사항 조회 |
| `studio.validate` | 구조·의미·준비 상태 검사 |
| `studio.start` | 실행 시작, 빠르게 `runId` 반환 |
| `studio.status` | 실행 상태 조회 |
| `studio.events` | 순번 이후 이벤트 조회 |
| `studio.cancel` | 취소 요청 |
| `studio.results` | 결과·산출물 참조 조회 |

`studio.start`는 `requestId`로 중복을 방지합니다.

- 같은 ID와 같은 내용: 기존 `runId` 반환.
- 같은 ID와 다른 내용: 충돌 오류.
- MCP 연결 종료: 실행 취소로 해석하지 않음.
- 재접속: `runId`로 상태·이벤트·결과 조회.

사용자 승인 응답은 인증된 Runner UI 경로로 받습니다. AI에 보안 승인을 생성하는 MCP 도구를 제공하지 않습니다.

**격리 요구 사항**

| 영역 | 필수 조건 |
|---|---|
| 로컬 API | 루프백 바인딩, 인증, 브라우저 Origin 검사 |
| 파일 | 허용된 작업 영역·관리 파일만 접근 |
| 네트워크 | 모델·도구 중계 또는 명시적으로 허용된 목적지 |
| Worker | 파일·네트워크·프로세스·시간·메모리 경계 |
| 자격증명 | Worker나 모델에 원문 전달하지 않음 |
| 코드 의존성 | 검증된 고정 구성요소 사용. 실행 중 임의 설치 금지 |
| 도구 권한 | 역할 지침·문서·Skill로 확대할 수 없음 |

별도 Node 프로세스를 띄웠다는 이유만으로 악성 코드가 격리되었다고 판단하지 않습니다. 실제 Windows 격리 방식과 지원 환경을 구현 단계에서 검증해야 합니다.

Runner가 통제하는 범위는 Runner를 통과하는 작업입니다. 호스트의 자체 셸·도구와 원격 MCP 서버 내부 동작까지 동일하게 통제한다고 표시하지 않습니다.

트리거는 UTC 시각과 IANA 시간대를 함께 사용합니다. 놓친 일정은 `skip/run_once`, 실행 중 중복은 `skip/queue_one`처럼 제한된 정책으로 처리합니다. 가져온 예약은 비활성 상태로 시작합니다.

---

**13. P1-05 — 운영 ZIP의 형식과 신뢰 규칙을 정의합니다.**

예정 파일:

- `docs/specifications/package-format.md`
- `docs/specifications/host-adapters.md`
- `docs/specifications/version-policy.md`

패키지 종류는 두 가지입니다.

| `packageKind` | 목적 |
|---|---|
| `workflow` | Studio Runner로 워크플로 실행 |
| `materials` | 호스트에서 지침·문서·Skill·연결 정의 활용 |

자료 패키지에는 Runner의 31개 블록 실행 의미를 보장한다고 표시하지 않습니다.

워크플로 ZIP 예시:

```text
project/
  manifest.json
  manifest.sig
  runtime.lock.json
  workflow.json
  editor.json
  README.ko.md

  resources/
    writing-guide/
      resource.json
      instructions.md

    report-skill/
      resource.json
      SKILL.md
      scripts/
      references/
      assets/

  host별 지침·Skill·MCP 설정
```

Skill은 `SKILL.md`를 기본으로 코드·참조 자료·템플릿을 포함할 수 있습니다. Skill의 선언이 Runner의 실제 권한 부여를 대신하지는 않습니다. [Agent Skills 규격](https://agentskills.io/specification)

**`manifest.json` 필드**

| 필드 | 의미·규칙 |
|---|---|
| `schemaVersion` | 패키지 규격 버전 |
| `packageId` | 배포 식별자 |
| `packageVersion` | 불변 배포 버전 |
| `packageKind` | workflow 또는 materials |
| `purpose` | v1은 `production`만 허용 |
| `targetHost` | codex, claude-code, opencode 중 하나 |
| `entrypoint` | workflow 패키지는 `workflow.json` |
| `requiredCapabilities` | 필요한 블록 모드·RAG·Worker 기능 |
| `compatibility` | 지원 플랫폼·Runner·호스트 조건과 검증 버전 |
| `requestedPermissions` | 요청 권한. 실제 승인 아님 |
| `requiredConnections` | 필요한 연결 정의. 인증정보 제외 |
| `resources` | 포함 자료의 고정 참조와 권리 정보 |
| `indexes` | rebuild 또는 bundled 정책 |
| `files` | 상대 경로·바이트 수·SHA-256·파일 역할 |
| `createdAt` | 고정된 배포 생성 UTC 시각 |

`requiredCapabilities`는 작성자가 임의로 축소하지 못하도록 블록 설정과 자료 의존성에서 계산하고 대조합니다.

예를 들어 Hybrid 검색이 포함되면 관련 검색·reranker 기능이, GraphRAG가 포함되면 색인 형식과 local/global 검색 기능이 요구 목록에 들어가야 합니다.

**`runtime.lock.json`의 범위**

| 항목 | 기록 내용 |
|---|---|
| 실행 구성요소 | Runner·Worker·내장 런타임 버전과 해시 |
| 규격 | 스키마·블록 계약·색인 형식 버전 |
| 자료·코드 | 고정 자료·Skill·실행 의존성 |
| 도구 | 도구 이름과 입력·출력 스키마 해시 |
| 모델 | 요구 프로필과 실제 검증에 사용한 모델 정보 |
| 호스트 | 실제 검증한 호스트 버전 |
| 제한 사항 | 공급자가 불변 모델 버전을 제공하지 않는 경우 등 |

소프트웨어 의존성 잠금과 모델의 완전한 결정성을 혼동하지 않습니다. 모델의 답변이 항상 동일하다는 보장은 하지 않고, 입력·설정·사용 모델·결과의 추적성을 확보합니다.

사용자가 다른 모델 프로필을 연결하면 새 실행 계획에 기록하고, 기존 검증과 동일한 조합이라고 표시하지 않습니다.

**호스트별 파일**

| 호스트 | 생성 대상 |
|---|---|
| Codex | `AGENTS.md`, `.agents/skills/`, `.codex/config.toml` |
| Claude Code | `CLAUDE.md`, `.claude/skills/`, `.mcp.json` |
| OpenCode | `AGENTS.md`, `.opencode/skills/`, `opencode.json` |

기존 사용자 전역 설정을 덮어쓰지 않습니다. 어댑터는 지원 버전에 맞는 프로젝트 설정을 생성하고 충돌을 검사합니다.

**색인 배포 정책**

| 정책 | 규칙 |
|---|---|
| `rebuild` | 원문 또는 입력 요구 사항과 색인 설정을 제공. 수신 환경에서 사용량 확인 후 생성 |
| `bundled` | 배포 권리가 확인된 색인·근거·구성 목록을 고정 해시로 포함 |

개인 ACL·인증정보·실행 중인 색인 상태를 복사하지 않습니다. 비공개 문서의 임베딩·그래프·요약도 공개 권리를 따로 확인합니다.

---

**14. ZIP 무결성과 가져오기 규칙을 고정합니다.**

개별 파일은 **원본 바이트의 SHA-256**을 사용합니다. JSON 파일도 파일 해시를 계산할 때 다시 직렬화하지 않습니다.

논리적 패키지 해시와 서명에는 `manifest.json`을 RFC 8785 JCS 방식으로 정규화한 값을 사용합니다. JCS는 JSON 서명·해시를 위한 일정한 표현을 정의합니다. [RFC 8785](https://www.rfc-editor.org/info/rfc8785/)

서명 규칙:

- 서명 알고리즘은 v1에서 Ed25519로 고정합니다.
- 서명 입력은 규격 식별 문자열과 정규화된 manifest를 결합합니다.
- `files` 목록에서는 자기 참조를 피하려고 `manifest.json`, `manifest.sig`를 제외합니다.
- 나머지 실제 배포 파일은 모두 목록에 있어야 합니다.
- 신뢰 키는 ZIP 외부에서 관리합니다.
- ZIP에 들어 있는 키만으로 그 ZIP을 공식 배포라고 인정하지 않습니다.
- 공식·공개 배포는 검수된 버전의 서명을 요구합니다.
- 개인 미서명 패키지는 공식 검증 표시를 받지 못합니다.
- 서명은 무결성과 출처 확인이며, 안전성이나 실행 승인을 대신하지 않습니다.

**가져오기 검사**

| 검사 대상 | 거부 조건 |
|---|---|
| 경로 | 절대 경로, 드라이브·UNC, `..`, 역슬래시, NUL, 제어 문자 |
| Windows 파일명 | 예약 이름, 끝의 점·공백, NTFS ADS |
| 충돌 | 대소문자 또는 정규화 후 동일한 경로 |
| 파일 유형 | 심볼릭 링크·하드링크·암호화 ZIP |
| 구성 | 목록에 없는 파일, 빠진 파일 |
| 무결성 | 크기·해시 불일치 |
| JSON | 중복 키, 잘못된 형식, 지원하지 않는 규격 |
| 기능 | 필요한 capability·색인 형식·Worker 미지원 |

초기 가져오기 한도는 다음으로 제안합니다.

| 항목 | 초기 한도 |
|---|---:|
| 파일 수 | 10,000개 |
| 개별 파일 | 128 MiB |
| 전체 해제 크기 | 512 MiB |
| 압축 비율 | 100배 |
| manifest 크기 | 4 MiB |

이 한도는 실제 패키지 시험 후 조정하되, ZIP 자체가 한도를 높일 수는 없습니다. 압축 목록에 적힌 크기만 믿지 않고 해제 중 실제 바이트도 검사합니다.

가져오기는 새 임시 영역에서 검사하고, 통과한 뒤 관리 영역에 확정합니다. 기존 프로젝트나 호스트 설정을 자동으로 덮어쓰지 않습니다.

**가져오기·초기화 시 실행 금지**

- 모델 호출
- 외부 MCP 호출
- Skill·프로그램 실행
- 설치 스크립트 실행
- 예약 실행 활성화

호스트가 프로젝트 MCP 설정을 읽으며 Studio Bridge를 시작할 수는 있습니다. 이때 Bridge는 인증·기능 협상만 수행하며, 명시적인 실행 요청 전에는 워크플로·모델·외부 도구를 실행하지 않습니다.

내보내기는 허용된 배포 파일 목록을 기준으로 구성합니다. 내부 테스트 fixture·검증 명세·개발 서버·키 파일은 제외합니다.

---

**15. P1-06 — 검증은 구조·의미·실행 준비·실사용으로 나눕니다.**

예정 파일:

- `docs/specifications/conformance-plan.md`
- `docs/specifications/official-examples.md`
- `docs/specifications/release-gates.md`

| 검증 단계 | 검사 내용 | 대표 오류 |
|---|---|---|
| 구조 | 필수 필드·타입·허용 키·설정 | `SCHEMA_INVALID` |
| 블록 지원 | type·typeVersion·모드 | `UNKNOWN_NODE_TYPE`, `UNSUPPORTED_TYPE_VERSION` |
| 그래프 의미 | ID·포트·순환·도달성·합류 | `INVALID_EDGE`, `CYCLE_DETECTED` |
| 데이터 의미 | 참조·입출력 타입·분기별 가용성 | `BINDING_NOT_AVAILABLE`, `TYPE_MISMATCH` |
| 자료 무결성 | 버전·파일·해시 | `RESOURCE_DIGEST_MISMATCH` |
| 실행 준비 | 모델·연결·Worker·capability | `CONNECTION_REQUIRED`, `CAPABILITY_MISSING` |
| 정책 | 파일·도구·네트워크·사용량 | `POLICY_DENIED`, `BUDGET_EXCEEDED` |
| 결과 | 결과 스키마·파일·근거 | `OUTPUT_INVALID`, `CITATION_INVALID` |

오류 응답은 편집기에서 해당 설정으로 이동할 수 있어야 합니다.

```json
{
  "severity": "error",
  "stage": "semantic",
  "code": "BINDING_NOT_AVAILABLE",
  "message": "선택되지 않을 수 있는 분기의 결과를 필수 입력으로 참조하고 있습니다.",
  "nodeId": "finish",
  "instancePath": "/nodes/2/inputBindings/result",
  "hint": "merge로 합류하고 누락 처리 방식을 지정하세요."
}
```

Ajv 설정에서는 암묵적인 타입 변환·속성 삭제·기본값 삽입을 비활성화합니다. 사용자 스키마의 외부 `$ref`를 자동 조회하지 않고, 스키마 깊이·크기·정규식 복잡도도 제한합니다.

**필수 검증 사례**

| ID | 조건 | 기대 결과 |
|---|---|---|
| SC-01 | 알 수 없는 노드 type | 저장·실행 준비 검사 실패 |
| SC-02 | 허용하지 않은 config 필드 | 구조 검사 실패 |
| SC-03 | 같은 흐름에 중복 노드 ID | 의미 검사 실패 |
| SC-04 | 일반 연결의 순환 | 실행 전 거부 |
| SC-05 | 하위 흐름 A→B→A 호출 | 실행 전 거부 |
| SC-06 | 스키마에 외부 URL 참조 | 자동 다운로드 없이 거부 |
| RT-01 | 동일한 시작 요청 두 번 | 같은 runId, 실행 하나 |
| RT-02 | 같은 requestId에 다른 입력 | 충돌 오류 |
| RT-03 | 조건 한쪽만 선택 후 합류 | 비활성 분기를 기다리지 않고 완료 |
| RT-04 | 필수 참조 대상이 건너뛰어짐 | 누락 입력 오류 |
| RT-05 | 검토 대기 중 재시작 | 동일한 대기 복원, 응답 한 번만 처리 |
| RT-06 | 승인 후 대상·인수 변경 | 기존 승인 사용 불가 |
| RT-07 | 외부 변경 응답 유실 | 확인 필요 상태, 자동 재전송 금지 |
| RT-08 | 병렬 작업이 마지막 예산 경쟁 | 예약 한도를 넘겨 모두 시작하지 않음 |
| RT-09 | 외부 변경 완료 후 취소 | 완료 변경 유지·표시 |
| RT-10 | 새 계획 생성 | 새 planHash 검증, 이전 승인 재사용 금지 |
| RT-11 | Worker가 허용 밖 파일 접근 | 차단·위반 기록 |
| RT-12 | MCP 호스트 종료·재접속 | 기존 실행 조회, 중복 실행 없음 |
| RG-01 | 검색 성공이나 결과 없음 | 정상 빈 결과와 근거 부족 표시 |
| RG-02 | Hybrid 두 검색원이 동일 청크 반환 | 후보 하나로 결합 |
| RG-03 | reranker가 없는 후보 ID 반환 | 결과 거부 |
| RG-04 | Agentic 상한 도달·근거 부족 | 불충분 상태 종료 |
| RG-05 | 색인 생성 중 중단 | 미완성 세대 활성화 금지 |
| RG-06 | 원문 권한 철회 | 청크·그래프·요약·캐시 재노출 차단 |
| RG-07 | 관계의 원문 근거 없음 | 검증된 그래프 근거에서 제외 |
| RG-08 | GraphRAG Worker의 직접 모델 호출 | 중계 정책에 따라 차단 |
| ZP-01 | 파일 추가·누락·변조 | 가져오기 실패 |
| ZP-02 | 경로 탈출·예약 이름·충돌 | 관리 영역에 쓰기 전 거부 |
| ZP-03 | 자체 제공 키로 공식 서명 주장 | 공식 신뢰로 인정하지 않음 |
| ZP-04 | 필요한 검색 capability 미지원 | 실행 전 차단 |
| ZP-05 | ZIP 가져오기·Bridge 초기화 | 모델·외부 작업·예약 실행 0건 |
| ZP-06 | 키·내부 fixture·검증 명세 포함 | 운영 내보내기 실패 |

**RAG 품질 검증**

- 문서·질문·정답 근거·접근 범위가 있는 고정 평가 세트를 준비합니다.
- 평가 세트와 기준을 실행 전에 고정합니다.
- Recall@K, MRR 또는 nDCG를 측정합니다.
- reranker 적용 전후를 비교합니다.
- 인용의 출처 존재·위치 일치를 검사합니다.
- 근거 없는 질문에 답변을 유보하는지 확인합니다.
- 접근 제한 자료 노출은 허용하지 않습니다.
- 모델 평가만으로 모든 의미적 정확성을 통과시키지 않고, 공식 예제는 사람의 검수도 포함합니다.

**240개 예제의 실제 사용 검증**

| 대상 | 필요한 증거 |
|---|---|
| 프로젝트 120개 | 실제 입력, runId, 실제 산출물, 사전에 정한 결과 검사 |
| 자료 및 도구 120개 | 최소 하나의 실제 활용 사례와 결과 |
| 세 호스트 | 프로젝트별 진입·실행 시작·결과 회수 경로 |
| MCP 연결 | 실제 서비스 연결·허용 도구·권한·실패 처리 |
| Skill 코드 | 실제 파일·코드·템플릿 사용 결과 |
| RAG 예제 | 색인·검색·출처·답변 유보·권한 검증 |

검증 기록은 프로젝트·자료·ZIP 해시와 연결합니다. 이름·설명만 작성한 항목은 완료 수에 포함하지 않습니다.

---

**16. P1의 설계 완료 조건과 이후 구현 완료 조건을 구분합니다.**

| P1 작업 | 설계 완료 조건 |
|---|---|
| P1-01 | 메뉴·역할·운영용 범위·사용자 흐름이 확정되어 있다 |
| P1-02 | workflow·노드·참조·색인·버전의 의미가 서로 일치한다 |
| P1-03 | 31개 블록의 설정·입출력·포트·지원 모드가 빠짐없이 정의되어 있다 |
| P1-04 | 분기·합류·대기·승인·재시도·복구·재계획의 처리 규칙이 명확하다 |
| P1-05 | ZIP 파일 구성·호환성·서명·가져오기·호스트별 배치가 정의되어 있다 |
| P1-06 | 정상·오류·중단·보안·실사용 검증의 입력과 기대 결과가 정의되어 있다 |

이후 개발에서는 다음 순서로 명세를 코드에 옮깁니다.

```text
스키마 파일
→ 타입·검증기 생성
→ 그래프·Binding 검사
→ 기본 Runner
→ ZIP 빌더·검사기
→ 31개 블록·RAG 구현
→ 명세 적합성 시험
→ 240개 예제 실제 사용 검증
```

**현재 결과는 상세 명세안입니다. 스키마 파일 생성, 실행 처리기 구현, ZIP 제작, 검증 시험은 아직 수행하지 않았습니다.**

