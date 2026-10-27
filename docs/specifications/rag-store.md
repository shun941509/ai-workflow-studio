# SQLite RAG 저장소와 실제 로컬 검색

`apps/runner/src/rag/store.ts`는 신뢰된 Runner 서비스 내부에서 사용할 영속 저장 계층이다. 실제 `node:sqlite`와 `@studio/rag-core`의 BM25/exact vector 계산을 사용한다. 저장소 자체는 HTTP 경로나 capability를 등록하지 않는다. 후속 `run-runtime.ts`가 현재 실행에서 검증한 텍스트 파일의 keyword build/open/search만 RunnerService에 연결한다. 실제 embedding 모델 연결, GraphRAG, Agentic 실행, 공개 검색 서비스의 완료를 의미하지 않는다.

## 공개 API와 신뢰 경계

| API | 계약 |
| --- | --- |
| `new SqliteRagStore(absoluteFilename, limits?)` | 서비스가 정한 절대 경로의 전용 DB. 사용자 Workflow/Binding이 경로를 고르지 않음 |
| `createScope(scope)` | 신뢰된 관리 경로에서 새 tenant/project 생성. 초기 epoch=1, 모든 문서 접근 거부 |
| `replaceAccess(scope, {expectedEpoch, subjects, documents})` | 인증·권한 어댑터만 호출하는 전체 권한 교체. subject의 현재 groupIds와 문서 ACL/revision/tombstone을 같은 트랜잭션에 저장 |
| `authority.readCurrent(scope, subjectId)` | 현재 membership+ACL을 한 SQLite 읽기 snapshot에서 반환 |
| `stageGeneration({corpus,index,documents,artifacts})` | 실제 원본·추출문·추출 설정·청크·색인 artifact를 검사하고 원자적으로 저장 |
| `loadGeneration(scope, IndexRef)` | 고정 세대를 실제 저장 bytes로 다시 검증하여 반환. 권한 있는 내부 builder/검색 서비스 전용 |
| `getActiveIndex(scope,indexId)` | `{ref,revision}` 또는 null. 메타데이터 조회이며 bytes 검증을 대신하지 않음 |
| `activate(scope, IndexRef, expectedActiveOrNull)` | bytes 재검사 후 현재 hash+활성 revision에 대한 원자적 CAS |
| `search(principal, IndexRef, {query,channel,limit},signal,embedder?)` | 고정 세대의 실제 keyword/vector 검색 및 현재 권한 사전·사후 검사 |
| `searchActive(principal,indexId,options,signal,embedder?)` | 현재 활성 포인터를 한 번 고정한 뒤 위 검색 수행 |
| `statistics()`, `close()` | 내용/사용자 ID가 없는 운영 수치, DB 종료 |

`Principal={scope,subjectId}`는 서비스의 실제 인증 결과여야 한다. 이 저장소가 입력 문자열 subjectId를 인증하는 것은 아니다. 임의 HTTP/AI 입력을 principal로 전달하거나 `createScope`/`replaceAccess`/`stageGeneration`/`activate`에 연결하면 안 된다. `authority` 객체는 읽기 함수만 노출한다. 별도 그룹 배열·문서 allowlist를 검색 요청에서 받지 않는다. 공개 API가 없는 현재 단계의 신뢰 경계이며, 추후 HTTP·도구 연동 시 인증/권한·호출 주체 검사가 필수다.

`loadGeneration`은 ACL 필터 전 원본 corpus를 읽는 내부 API다. 사용자 응답 경로는 `search`와 최종 인용/공개 검사를 사용해야 한다. 검색 결과의 epoch는 마지막 권한 확인 시점을 뜻한다. 이후 네트워크 송신과 동시 권한 철회를 원자적으로 묶는 응답 계층은 아직 구현하지 않았다.

## 저장 형식과 원자적 staging

외부 artifact 디렉터리 대신 SQLite BLOB staging을 선택했다. 원본 bytes, UTF-8 추출문 bytes, 추출기 설정 JSON, corpus/index JSON, 실제 artifact bytes를 전용 테이블에 저장한다. 파일 rename과 DB commit의 두 가지 성공 상태를 조합하지 않는다.

- `rag_corpora`, `rag_sources`: 봉인된 corpus와 원본·추출문·추출 설정.
- `rag_indexes`, `rag_artifacts`: 봉인된 색인과 실제 artifact.
- `rag_active`: 활성 세대 포인터와 증가하는 활성 revision.
- `rag_scopes`, `rag_subjects`, `rag_access`: 현재 권한 epoch, 현재 membership, 문서 ACL·revision·tombstone.

staging은 원본을 복사하고 검증한 뒤 `BEGIN IMMEDIATE` 한 트랜잭션에서 전부 저장한다. 저장된 세대가 있다고 자동 활성화하지 않는다. artifact 삽입 실패는 corpus/source/index 행까지 rollback한다. 불변 테이블은 UPDATE/DELETE 거부 trigger를 사용하며 서비스의 변경 API도 없다. 이미 사용한 index generation ID는 같은 내용이어도 재사용할 수 없다. 동일 corpus generation은 같은 고정 내용·원본 bytes일 때 다른 index에서 참조할 수 있다. 같은 scope/documentId/revision에 다른 원본·추출문·추출 설정·출처를 덮어씌우지 못한다.

Node24의 SQLite를 WAL, `synchronous=FULL`, foreign keys, trusted_schema off로 사용한다. 현재 스키마는 application_id `0x53524147`, user_version=1이다. 알 수 없는 DB, 미래 schema version은 migration이나 journal 변경 전에 거절한다. 재개 시 quick_check와 foreign key 검사를 수행한다. 이 검증은 악의적인 로컬 관리자에 의한 모든 DB 재작성이나 파일 복제의 진위까지 보장하지 않는다.

## 원본·세대 검증과 활성화

`documents`는 core의 실제 `DocumentInput[]`다. 문서 원본과 추출문은 각각 별도 해시를 가진다. 로드할 때 저장된 원본·추출문·추출 설정으로 `createCorpusGeneration`을 다시 실행하고 봉인된 corpus hash를 비교한다. 청크의 위치는 `encoding:'utf8'`이며 추출문 UTF-8 **바이트** 범위 `[start,end)`다. 문자 중간 분할이나 원본과 다른 범위를 인정하지 않는다. 추출기의 정확성이나 이용 권리는 이 검증의 대상이 아니다.

artifact hash와 크기를 검사한 후 `openLocalSearchProvider`로 실제 빈도/벡터 형식을 읽는다. 원문과 다른 term, 다른 corpus/embedding fingerprint, 손상된 artifact, 미지원 graph 형식을 성공 세대로 취급하지 않는다. 변조되었거나 거짓 크기가 들어간 DB를 읽을 때는 먼저 SQLite의 실제 `length()`로 크기를 확인한다.

활성화는 다음 순서다.

1. 짧은 읽기 트랜잭션으로 후보 세대의 실제 저장 bytes를 소유한 snapshot으로 복사한다.
2. 잠금 밖에서 corpus·원본·artifact·실제 검색 형식과 `planIndexActivation`을 검사한다.
3. `BEGIN IMMEDIATE`에서 현재 활성 `{ref,revision}`이 기대값과 일치하는지 확인한다.
4. 동일 후보를 다시 읽고 모든 원본/메타데이터/artifact bytes의 receipt가 바뀌지 않았는지 확인한다.
5. 활성 포인터와 revision을 한 번에 commit한다.

트랜잭션 안에는 await가 없다. 독립 DB 연결 두 개가 동시에 활성화하면 하나만 성공한다. 이전 immutable generation으로 명시적인 내부 rollback을 하더라도 revision은 증가한다. 따라서 같은 manifest hash로 돌아온 뒤 과거 기대값으로 갱신하려는 ABA도 거절한다. 현재 세대를 그대로 다시 활성화하는 요청은 generation reuse 오류다.

## 현재 membership·ACL·삭제

권한 교체는 expectedEpoch CAS를 먼저 확인한다. subject membership과 모든 문서 ACL 변경, epoch 증가가 같은 트랜잭션에 들어간다. 등록되지 않은 subject는 ACL의 allowedSubjects에 이름이 있더라도 거부한다. 그룹에서 탈퇴하면 문서 ACL이 바뀌지 않아도 다음 조회에서 접근이 제거된다.

교체 요청에서 빠진 문서는 삭제 이력을 잃지 않도록 tombstoned=true로 남긴다. 현재 문서 revision을 낮추거나 같은 revision의 tombstone을 해제할 수 없다. 복구하려면 더 높은 문서 revision을 등록하고 해당 원본을 색인해야 한다. 오래된 고정 색인은 남더라도 현재 revision과 일치하지 않으면 검색 후보에서 제거된다. 물리적 원본 삭제·보존 기간·compaction·법적 삭제는 후속 기능이다. 이미 공개된 결과를 원격으로 지운다고 주장하지 않는다.

`searchCurrentChannel`은 현재 권한에서 문서 allowlist를 만든 뒤 점수 계산 전에 필터하고, 비동기 embedder 호출 뒤 현재 권한을 다시 읽는다. 검색/로드 실패를 정상 빈 결과로 바꾸지 않는다. 권한 때문에 실제 후보가 없으면 정상 빈 결과다. 검색 결과에는 고정 index/corpus/chunk 출처가 남으며 인용 생성은 core의 `buildCitations`를 사용해 공개 직전 다시 검사해야 한다.

## 한도와 미구현 경계

기본 한도는 DB당 immutable index 128개, scope 64개, generation 입력·저장 bytes 64 MiB, JSON/단일 local artifact 8 MiB, 논리 payload 512 MiB다. subject는 scope당 1000개, 현재·삭제 문서 접근 기록은 합쳐 scope당10000개다. 생성자에서 기본값 이하로 낮출 수 있다. 기존 DB가 선언된 수/총량 한도를 넘으면 열기 또는 읽기를 거절한다. 생성 실패와 ACL quota 실패는 부분 상태를 남기지 않는다.

논리 payload는 corpus/index JSON, 원본·추출문·추출 설정, artifact와 ACL/group JSON을 센다. SQLite 페이지·인덱스·중복 열 overhead까지 동일한 값으로 세지는 않는다. DB 페이지는 별도로 1 GiB 상한을 지정한다. WAL은 자동 checkpoint 및 8 MiB journal_size_limit을 설정하지만 외부의 장시간 SQLite reader가 잡고 있는 WAL을 같은 크기로 강제 자르지는 못한다. 서비스 API의 읽기 트랜잭션은 await 없이 짧게 닫는다. 엄격한 디스크/CPU 격리는 OS Worker·운영 저장 용량 정책의 후속 경계다.

원본은 DB 안에서 보관하므로 검색 때 파일 경로를 조합하지 않는다. DB 생성자는 기존 경로의 symlink/junction 및 DB/WAL/SHM hard link를 거절한다. 디렉터리는 신뢰된 서비스가 소유해야 하며, 이 검사만으로 동시 경로 교체 공격을 막는 OS sandbox를 제공하지 않는다.

작은 로컬 자료용의 BM25와 exact vector 계산만 제공한다. vector/hybrid는 모든 실제 supplied vector와 정확한 profile을 요구하고, query embedding adapter가 없으면 검색 오류다. 테스트 벡터를 모델 호출 성공으로 세지 않는다. 현재 미구현은 외부 embedding/reranker 호출·비용 예약 연동, 독립 검색 HTTP API, keyword 이외 Runner retrieval 모드, Hybrid 검색 서비스 조합, GraphRAG, Agentic 오케스트레이션, 자동 GC/물리 삭제, 다중 기기 ACL 동기화와 실제 공급자 검증이다.

## 현재 실행의 실제 keyword 블록 연결

`RunnerService`는 아래 제한된 기능만 제공한다. 서비스가 발급한 runId와 검색 DB에서 처음 생성·영속화한 installation UUID로 scope를 만든다. `workflow.id`, 사용자 입력의 tenant/project/subject, 파일의 relativePath, 임의 OS 경로는 권한의 근거가 아니다. 동일 패키지/프로젝트라도 다음 실행은 다른 scope다. 과거 실행 색인이나 다른 설치의 IndexRef를 열 수 없다.

| 블록 | 지원 계약 |
| --- | --- |
| knowledge.build | `profile="local-run-keyword-v1"`, `indexSettings={kind:"keyword",chunkSize,chunkOverlap}`, `documents=현재 run FileRef[]` |
| knowledge.open | config는 `operation:"open"`만, `index=같은 run에서 생성 완료한 고정 IndexRef` |
| retrieval.keyword | `index`, `query` 입력과 `mode:"keyword",topK,maxContextTokens` 설정만 |

지원 capability는 `node.knowledge@1`, `knowledge.build@1`, `knowledge.open@1`, `knowledge.keyword@1`, `rag.run_local@1`, `node.retrieval@1`, `retrieval.keyword@1`이다. update/delete/vector/hybrid/web/graph/reranker/filters/첨부 자료는 실행 전 명시적으로 거절한다. 검색 전용 HTTP/MCP 임의 색인 관리 API는 추가하지 않는다. 기존 start/status/results와 사용자 파일 선택 경로를 사용한다.

파일은 현재 run의 ArtifactStore 원본 bytes와 RunStore 등록을 모두 검사한다. TXT(`text/plain`), Markdown(`text/markdown`), JSON(`application/json`)의 MIME/확장자가 일치해야 한다. 1~32개, 파일당 2 MiB, 한 build 원문 8 MiB/1000청크까지다. JSON은 strict 문법·중복 키 검사를 수행하지만 검색 내용은 재직렬화하지 않은 UTF-8 원문 그대로다. BOM도 보존한다. PDF/OCR, 임의 프로그램 실행, 원격 업로드를 지원한다고 표시하지 않는다.

chunkSize는 100~20000 UTF-8 bytes, chunkOverlap은 크기보다 작아야 한다. 끝 경계는 문자 시작까지 뒤로, 다음 시작은 문자 경계까지 앞으로 조정한다. 각 청크의 원본 바이트 위치·hash를 봉인하며 입력 순서/재시도에 임의 난수를 넣지 않는다. 문서 ID는 검증한 FileRef ID, revision=1이고 원본 SHA256과 `urn:studio:file:<id>` 출처를 보존한다. 같은 파일을 중복 연결하면 오류다.

색인 결과는 `NodeOutput.data=IndexRef`이다. 검색 결과는 `data={index,candidates,citations,context,authorizationEpoch,contextBudget}`이고 `text=context`, `sources=citations`다. citations는 현재 권한을 다시 검사한 청크 전체 원문에서만 만든다. 정상 빈 결과는 빈 candidates/citations이며, 실패를 빈 성공으로 변환하지 않는다.

문맥 계산은 실제 `js-tiktoken@1.0.21`의 로컬 `o200k_base` BPE를 사용한다. 고정 안내문·source 라벨·개행을 포함한 text를 측정하고 전체 청크만 선택한다. contextBudget은 encoding/tokenizerFingerprint/tokenCount/limit/omittedCount를 기록한다. 이 값은 지정한 로컬 문맥 encoding의 측정값이며 호스트 모델의 과금 사용량이나 전체 프롬프트 토큰 수가 아니다. 모델을 호출하지 않는 keyword 경로의 모델 사용량은 0이다. tokenizer 계약과 시험은 `context-tokenizer.ts`, `tests/contracts/rag-tokenizer.test.ts`에 있다.

## 실행 의도·예산·취소·재시작

`operations.sqlite`에 서버 발급 runId/nodeInstanceId/작업종류로 만든 operationId와 실제 config/input hash, 예약량을 원자적으로 저장한 뒤 비싼 색인 계산을 시작한다. 반복된 완료 build는 같은 고정 참조를 다시 검증해 반환한다. 같은 ID/다른 입력은 충돌이다. 반복 검색은 저장된 텍스트를 재사용하지 않고 현재 ACL로 다시 계산한다. run별 최대 build 4개, 작업 100개, 누적 원문 16 MiB, 누적 청크 2000개이며 실패·결과 불명 예약을 환급하지 않는다. 기존 동시성·노드 인스턴스·활성 시간·노드 timeout도 적용한다.

원문/색인 DB와 작업 journal은 별도 트랜잭션이다. `pending` intent → 실제 corpus/index staging → 현재 ACL의 새 파일만 추가 → atomic activation → `completed` journal 순서로 진행한다. journal의 완료된 build 소유 기록까지 있어야 open/search가 가능하므로 중단 중 활성화된 색인을 추측한 참조로 열 수 없다. 중간 장애의 pending/failed 작업은 자동 replay하지 않으며, 결과 불명 intent는 `attention_required`다. 알려진 취소·한도 실패는 후속 단계를 막고 이미 저장된 내부 불변 bytes는 남길 수 있다. 재조정·GC는 후속 기능이다.

파일마다 host yield와 취소/시간 checkpoint를 두고 해시/생성/저장/권한/활성화 뒤에 다시 검사한다. 순수 계산이 동기적으로 오래 걸리면 단조 시간 검사로 결과·후속 작업을 차단한다. 이 방식은 OS CPU sandbox나 동기 함수의 강제 선점을 뜻하지 않는다. 실행이 정상 대기 중일 때는 고정 색인과 설치 ID를 보존해 명시적인 사용자 응답 후 이어갈 수 있다. 프로세스 재시작 자체가 검색을 시작하지 않는다.

현재 run reader를 관리 경로에서 철회했을 때 새 build로 이를 재등록하지 않는다. 기존 문서 ACL/tombstone도 build가 덮어쓰지 않는다. 첫 scope/reader 생성은 서비스만 수행한다. 전역 scope/generation/디스크 상한은 앞 절의 저장소 한도도 함께 적용된다. 64개 보관 scope 또는 128개 세대에 도달하면 자동 삭제 없이 용량 오류가 발생하므로 정식 운영 전 보존/정리 정책이 필요하다.

## 검증

`tests/contracts/rag-store.test.ts`는 실제 Node24 SQLite와 새 임시 파일만 사용한다. durable reopen, UTF-8 원본, 스냅샷 mutation, generation/document revision 재사용, 두 연결 CAS·ABA, 삽입 중 rollback, immutable trigger, byte 변조, async 검증 도중 변조 receipt, 실제 BLOB 크기, scope 격리, 현재 그룹 탈퇴, tombstone 복원 revision, 미등록 subject, embedding 대기 중 철회, 오류/취소, access CAS, quota rollback, 미래/외부 DB 거부, hard link/junction 거부를 검증한다. 내부 test fault trigger와 명시적인 테스트 벡터는 제품 API나 ZIP에 존재하지 않는다.

2026-10-28 Node 24.22.1에서 저장소 22개와 core/search 36개를 합친 58개 시험이 통과했다. `tsc --noEmit -p apps/runner/tsconfig.json` 및 `tsc --noEmit -p tsconfig.tooling.json`도 통과했다. 이것은 내부 저장소·검색 계산의 확인된 증거이며, 인증된 검색 HTTP/Workflow 통합이나 실제 공급자 모델 검증 증거는 아니다.

후속 Runner 연결 검증에서는 `tests/integration/runner-rag.test.ts` 20개가 통과했다. 3종 운영 ZIP을 실제 Runner로 가져와 사람용 파일 업로드 경로를 거쳐 build/open/search를 실행했고, BOM/JSON/Markdown 원문, 과거 실행 참조·파일 차단, 권한 철회, 누적 쿼터, 취소/timeout, 정상 대기 재시작, 결과 불명 intent, activation 후 journal 완료 실패를 검사했다. 이 시험은 대상 호스트 CLI 자체를 실행한 호환성 검증이 아니다.

최종 회귀 명령 `vitest run tests/integration tests/contracts/rag-core.test.ts tests/contracts/rag-search.test.ts tests/contracts/rag-store.test.ts tests/contracts/rag-tokenizer.test.ts`는 16개 파일 252개 시험이 모두 통과했다. Runner/tooling의 두 TypeScript 검사도 다시 통과했다. 실제 모델·임베딩 API 호출은 수행하지 않았다.
