# 고정 읽기 전용 도구 계약

첫 운영 범위는 아래 두 builtin뿐이다. 외부 MCP 서버, 사용자 등록 실행 함수, 변경 도구와 보상은 활성화하지 않는다. 편집기 목록에는 아직 추가하지 않는다.

| ToolRef | 인수 | 결과 | 범위 |
|---|---|---|---|
| `{kind:"builtin",id:"file.inspect",version:1}` | `{file: FileRef}` | `data={file:FileRef,integrity:"verified"}` | 현재 run에 등록된 파일의 참조·원본 바이트 무결성 확인 |
| `{kind:"builtin",id:"document.read_utf8",version:1}` | `{file: FileRef}` | 기존 UTF-8 문서 추출의 data/text/sources envelope | 현재 run의 비어 있지 않은 2 MiB 이하 TXT·Markdown·JSON 원문 |

파일 정보 확인의 integrity는 저장한 바이트·해시·크기가 일치한다는 뜻이다. 파일 내용의 사실성·안전성·권리까지 보증하지 않는다. UTF-8 읽기는 BOM·개행·Unicode를 보존하며 기존 `executeTextExtraction`의 decoder, SHA-256, 원본 UTF-8 바이트 위치를 그대로 사용한다. PDF·표·OCR로 대체 실행하지 않는다.

## Registry와 고정 계획

Runner 코드에 있는 폐쇄 registry가 id/version, argumentsSchema/resultSchema, classification=`read_only`, scope=`current_run_managed_files`, contractHash를 결정한다. hash는 이 고정 계약의 canonical digest이며 실행 바이너리 서명을 대신하지 않는다. 의미가 달라지면 버전을 올린다. Workflow의 metadata, 설명, 자료 내용, 인수의 effects·classification·handler 값으로 분류나 실행 함수를 바꿀 수 없다.

인수는 file 하나만 허용하는 닫힌 schema다. FileRef 모양 검사에는 신뢰된 canonical FileRef schema를 사용한다. 파일의 id/relativePath/filename/mimeType/bytes/sha256을 일부 바꾼 참조는 저장 descriptor와 대조해 거절한다. 사용자 입력은 validate 이전에 일반 JSON 여부를 검사한다.

resolvedPlan.verifiedDependencies.builtinTools에는 사용한 `id@version`별 descriptor 전체를 넣는다. 사용자 대기 응답 소비 전과 실제 도구 실행 전에 현재 registry와 고정 descriptor를 대조한다. 분류·인수/결과 형식·해시·버전이 바뀌거나 pin이 없으면 새 실행 계획을 요구한다. 내부 handler와 validator는 공개 descriptor에 포함하지 않는다.

요구 capability는 node.tool@1 및 tool.builtin.file.inspect@1 또는 tool.builtin.document.read_utf8@1이다. 다른 ID·버전·MCP는 readiness에서 차단한다. `tool.mcp@1`은 요구 기능으로 수집하지만 제공하지 않는다.

## 파일·실행 경계

Workflow나 인수는 runId·OS 경로·URL·모듈·명령을 고를 수 없다. 신뢰된 서비스가 현재 runId를 주입한다. ArtifactStore의 descriptor/bytes 검사와 RunStore의 현재 run 등록을 둘 다 통과해야 한다. 다른 run의 유효한 참조, 디스크에는 있지만 현재 run에 등록되지 않은 자료, 변조된 원본은 읽을 수 없다.

두 handler는 관리 파일의 읽기만 수행하고 새로운 artifact, 외부 요청, 효과 기록을 만들지 않는다. 결과 schema도 effects 필드를 허용하지 않는다. effects=[] 같은 사용자 주장으로 읽기 전용 지위를 얻는 경로는 없다. 원문 안에 도구 호출 지시가 있어도 데이터로 반환한다.

기존 leaf 실행에서 노드 수·동시성·활성시간·노드 timeout·취소를 유지한다. 파일 접근 전후 checkpoint를 검사한다. bounded 동기 파일 읽기를 OS 격리 Worker라고 주장하지 않는다. 중단된 실행은 기존 복구대로 attention_required이며 자동 재실행하지 않는다. 성공한 노드 결과와 artifact는 DB 재시작 뒤에도 확인할 수 있다. 새 보상 동작이나 외부 EffectRef는 생성하지 않는다.

## 검증

실제 파일 저장소·SQLite·3종 운영 ZIP으로 두 도구, UTF-8 원문과 해시/위치, 잘못된 인수·위조 FileRef·다른 run·미등록 자료·변조 파일·중단·대기 복구·고정 descriptor 대조를 검사한다. 도구 구현에 모델 대역·테스트 옵션·비밀정보를 넣지 않는다.

2026-10-28 검증 결과: 계약 시험 16개와 실제 Runner 통합 시험 15개 통과. 기존 Runner 통합 및 후보 탐색 계약까지 함께 실행한 17개 파일·258개 시험도 통과했다. Runner/tooling TypeScript 및 의존 경계 검사 통과. 운영 지원으로 확인한 것은 표의 두 읽기 도구이며 외부 MCP·변경 도구·보상은 이 증거에 포함하지 않는다.

재검증 명령: `node tooling/run-pnpm.mjs exec vitest run tests/contracts/builtin-tools.test.ts tests/integration/runner-builtin-tools.test.ts`.
