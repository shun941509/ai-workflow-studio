# RAG 순수 기반 계약

`@studio/rag-core`는 P3-10A/10B/13A의 데이터·권한·예산 기반과 제한된 로컬 BM25/exact vector 검색 계산을 제공한다. 이 순수 패키지는 파일·DB·네트워크·모델 SDK에 접근하지 않는다. 후속 Runner 계층이 영속 저장·고정 OpenAI 임베딩 어댑터·키워드/벡터/RRF 혼합 검색을 연결한다. 실제 유료 API와 검색 품질은 미검증이다. TypeScript 내부 계약이며 canonical Workflow/Node JSON Schema를 복제하거나 변경하지 않는다.

## 패키지와 공개 진입점

`packages/rag-core/package.json`의 `exports["."]`는 `./src/index.ts`다. 의존성은 `@studio/spec: workspace:*`, `json-canonicalize: 3.0.1`이며 build/typecheck는 `tsc --noEmit`이다. root workspace 링크는 통합 담당자가 추가한다.

| 모듈 | 공개 함수/인터페이스 | 역할 |
| --- | --- | --- |
| corpus.ts | createCorpusGeneration, verifyCorpusGeneration | 원본·추출문·청크·불변 corpus 세대 |
| corpus.ts | embeddingFingerprint, validateEmbeddingVector | 정확한 embedding 설정 및 실제 벡터 검사 |
| corpus.ts | sealIndexGeneration, verifyIndexGeneration, verifyIndexArtifacts | 실제 artifact bytes 목록과 불변 index 세대 |
| corpus.ts | assertIndexCompatibility, planIndexActivation | 세대/모델 호환성, 저장소 CAS 계획 |
| ranking.ts | normalizeRankedHits, fuseRrf, applyRerank | 후보 정규화, rank fusion, 재정렬 응답 검사 |
| ranking.ts | buildBoundedContext | 실제 tokenizer 인터페이스를 이용한 문맥 상한 |
| access.ts | filterAuthorized, authorizeCurrent, buildCitations | 현재 권한·삭제·revision 재검사와 원문 인용 |
| access.ts | filterDerivedEvidence | 모든 근거가 허용되는 그래프 파생 자료만 통과 |
| local-search.ts | buildLocalSearchIndex, openLocalSearchProvider | 실제 term 빈도 artifact, BM25·cosine/dot/l2 검색 계산 |
| access.ts, retrieval.ts | currentSearchAuthorization, searchCurrentChannel | 현재 권한 사전 필터 및 검색 후 재검사 |
| budget.ts | createAgenticSession, beginAgenticRound, reserveAgenticOperation, settleAgenticOperation | 누적 Agentic 예산 예약·정산 |
| budget.ts | agenticUsage, pauseForClarification, resumeAfterClarification, completeAgenticSession | 영속 상태를 전제로 한 수명주기 |

SHA-256은 WebCrypto, JSON hash는 JCS UTF-8이다. async 함수는 첫 await 전에 입력을 복사하고 결과는 깊게 freeze한다. JSON accessor·prototype 키·순환·비유한 숫자 등의 공통 spec 제한을 적용한다. 주요 계약 오류는 `RagContractError.code`로 구분한다. 공유 전역 cache는 없다.

## 실제 로컬 검색 계산

`buildLocalSearchIndex`는 검증한 corpus에서 청크별 실제 단어 빈도를 만들고, vector/hybrid에는 모든 청크의 실제 supplied embedding을 요구한다. 결과는 `local-search` artifact 원본 bytes와 그 bytes를 봉인한 index다. 로딩은 hash뿐 아니라 원문에서 재계산한 terms·길이·문서 ID도 대조한다. 벡터 생성 모델의 진위나 품질을 이 함수가 증명하지는 않는다.

형식은 `studio-bm25-exact-v1`, tokenizer는 `nfkc-lower-unicode-words-v1`이다. Unicode NFKC·소문자 변환 후 문자/숫자/결합문자 연속 구간을 단어로 사용한다. 한글 형태소 분석·동의어·phrase 문법은 제공하지 않는다. BM25는 k1=1.2, b=0.75, IDF=`ln(1+(N-df+0.5)/(df+0.5))`, TF=`f*(k1+1)/(f+k1*(1-b+b*len/avgLen))`다. IDF와 기본 계수는 [Lucene 공식 API](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/similarities/BM25Similarity.html)를 기준으로 했다. 쿼리 중복 단어는 한 번만 계산하며 통계 N/df/avgLen도 현재 읽을 수 있는 청크로 한정한다.

벡터는 근사 탐색 없이 cosine·dot·음수 Euclidean distance를 계산한다. 높은 score가 먼저이며 동률은 chunk ID 순이다. QueryEmbedder는 별도 실제 연동 경계이고 query text만 전달한다. fingerprint·차원·정규화·유한값을 검증하며 임베딩 모델이 없으면 오류다. keyword-only 사용은 모델이 필요하지 않다.

현재 한 index는 최대1000청크, 모든 벡터 성분 합32768, artifact8MiB·strict JSON 복잡도 한도다. 쿼리8192자/고유 단어256개, 결과 최대1000개다. 작은 자료용의 제한된 구현이며 큰 문서군·근사 색인·대형 벡터는 별도 binary/DB 구현이 필요하다. 검색 계산은 동기식으로 이 한도 안에서 진행하고, embedding 대기 전후 취소를 검사한다. 강제 CPU 중단은 이를 호출하는 격리 worker의 책임이며 아직 통합하지 않았다.

호출 서비스는 `searchCurrentChannel`을 사용해 현재 principal/group/ACL/tombstone에서 allowlist를 만들고 provider가 점수 계산 전에 필터하도록 한다. 검색 후 현재 권한을 다시 읽는다. 이후 reranker와 답변 공개 직전에도 기존 `authorizeCurrent`/`buildCitations` 검사를 반복해야 한다. 낮은 수준의 SearchProvider 자체는 인증 서버가 아니며 임의 사용자 allowlist를 HTTP에서 그대로 받아 전달하면 안 된다.

`tests/contracts/rag-search.test.ts`는 손으로 계산한 BM25, 원문/해시 변조, 3종 벡터 거리, 설정 누락/불일치, 취소, 권한 회수에 대한14개 검사를 수행한다. 벡터 숫자는 테스트 데이터이며 실제 모델 호출 성공으로 집계하지 않는다.

## 원본과 불변 세대

`AccessScope={tenantId,projectId}`다. DocumentRef에는 scope, documentId, revision, originalSha256, textSha256, sourceUri, extractionFingerprint가 들어간다. sourceUri는 credentials/query/fragment 없는 https·urn·resource locator만 허용한다. 원본 파일을 추출문 해시로 대체하지 않는다.

`createCorpusGeneration({scope,corpusId,generationId,documents,chunks})`는 실제 원본 bytes와 extractedText를 별도로 hash한다. 문서에는 `{extraction:{id,version,options}}`가 있어 추출기 설정도 고정한다. 원문 추출의 정확성·권리 보유까지 이 함수가 증명하는 것은 아니다.

ChunkRef는 DocumentRef 전체, 고유 chunkId, 내용 SHA-256, `{encoding:"utf8",start,end}`를 갖는다. P1에 맞춰 위치는 **textSha256으로 고정한 추출문의 UTF-8 바이트 범위, end-exclusive**다. 해당 구간을 실제로 잘라 hash하며 다중 바이트 문자 중간 분할·범위 밖·중복 chunk ID를 거부한다. JavaScript 문자열 길이를 그대로 byte offset으로 쓰면 안 된다. PDF page/표 cell 위치는 현재 제공하지 않는다. 추출기 어댑터가 실제 위치를 제공한 뒤 별도 확장해야 한다.

문서는 generation당 ID별 revision 하나, 최대1000문서·10000청크다. 단일 추출문 최대8Mi 문자, 청크65536문자이며 원본+추출문 메모리 입력은128MiB 이내다. 공통 JSON 복잡도 제한도 적용한다. 대용량 스트리밍 builder는 미구현이다.

CorpusRef는 `{scope,corpusId,generationId,manifestHash}`다. 생성 시 문서와 청크를 ID 순으로 정렬하고 전체 inventory를 hash한다. 재로딩 시 `verifyCorpusGeneration`이 참조·청크 내용·위치·manifest hash를 재검사한다. 주입한 text를 허용된 document ID로 바꾸는 방식은 통과하지 않는다.

IndexRef는 `{scope,indexId,generationId,formatVersion:"1.0.0",manifestHash}`다. IndexGeneration은 정확한 CorpusRef, kind, embedding fingerprint, 실제 artifact `{id,sha256,size}` 목록을 고정한다. `sealIndexGeneration`은 bytes가 없는 빈 색인을 만들지 않는다. 이 봉인은 builder artifact의 무결성만 확인하며 bytes가 유효한 BM25/vector/graph 색인인지 해석하지 않는다.

```ts
const sealed = await sealIndexGeneration({
  corpus: corpus.ref, indexId: 'knowledge', generationId: 'generation-2',
  kind: 'hybrid', embeddingProfile: resolvedEmbeddingProfile,
  artifacts: actualBuilderArtifacts,
});
const activation = await planIndexActivation(
  currentIndexRef, sealed, currentIndexRef?.manifestHash ?? null,
  bytesReadBackFromStaging,
);
// 저장소가 expectedManifestHash를 조건으로 원자적 CAS를 수행한다.
```

`planIndexActivation`은 실제 저장 bytes를 hash 대조하고 같은 index의 새 generation만 허용한다. 함수가 DB를 활성화하지는 않는다. 완성된 staging artifact의 내구성 확보 → bytes 재검증 → 원자적 pointer CAS는 저장소 책임이다. 기존 generation ID 재사용과 현재 hash 불일치는 오류다. 열린 query의 고정 generation을 다른 세대로 자동 교체하지 않는다.

## Embedding의 정확한 호환성

fingerprint에는 providerId, modelId, **modelRevision**, dimensions, distance(cosine/dot/l2), normalization(none/l2), tokenizerRevision, preprocessingRevision, parameters를 모두 넣는다. 같은 차원·같은 표시 이름만으로 호환된다고 보지 않는다. 키·토큰·비밀번호 필드는 프로필에 넣지 않는다.

외부 provider가 실제 immutable revision을 확인해 주지 않으면 어댑터가 임의 revision을 만들어 채우면 안 된다. 이 라이브러리는 선언된 identity를 정확히 비교하며 공급자 내부 모델 고정성까지 증명하지 않는다. 실제 모델 선택은 Runner 준비 검사와 검증 기록에 연결해야 한다.

`assertIndexCompatibility`는 corpus/index manifest와 세대·scope·embedding fingerprint를 검사한다. `validateEmbeddingVector`는 실제 값의 차원·유한성·zero cosine·l2 정규화 오차(1e-5)를 검사한다. embedding을 생성하거나 임의 벡터를 돌려주지 않는다.

## 현재 ACL·삭제·인용

Principal은 인증 어댑터가 확인한 `{scope,subjectId}`다. 사용자 입력이나 세션에 저장한 group 목록을 받지 않는다. AuthorizationSnapshot은 `{scope,subjectId,groupIds,epoch,documents}`이고, 현재 subject/group membership과 문서의 current revision, tombstoned, allowedSubjects, allowedGroups를 같은 epoch로 제공한다. 반환된 subjectId가 요청과 다르면 실패한다. 누락·삭제·revision 교체·권한 미일치는 기본 deny다. 오래된 index에 청크가 남아 있어도 이 검사를 우회할 수 없다.

`filterAuthorized(context,candidates,snapshot,expectedEpoch)`는 corpus/index를 검증하고 snapshot epoch를 확인한다. 이름·점수·text를 바꿔도 실제 corpus 원문과 일치하지 않으면 provenance 오류다. 서로 다른 tenant/project를 섞으면 전체 요청이 실패한다. deny 목록의 document ID를 사용자에게 노출하지 않도록 결과는 허용 candidates와 내부 deniedCount만 제공한다.

`AccessAuthority.readCurrent(scope, subjectId)`는 **현재 subject/group membership+문서 ACL+tombstone+revision을 권위 있는 저장소에서 원자적으로 읽는 어댑터**다. 색인에 저장된 옛 ACL이나 세션의 과거 groupIds·공유 cache로 대체하지 않는다. 문서 ACL이 그대로여도 그룹 탈퇴 후에는 해당 그룹을 근거로 접근할 수 없다. `authorizeCurrent`는 매 호출마다 이를 읽으며 실패하면 오류를 전달한다. 실패를 정상 빈 검색으로 바꾸지 않는다.

권장 연결 순서는 다음과 같다.

1. 현재 ACL에서 검색 가능한 문서 allowlist와 epoch를 얻는다.
2. SearchProvider에 고정 IndexRef·allowlist·epoch를 전달하고 backend에서도 필터링한다.
3. 반환 세대 확인, corpus 기반 후보 재구성, 현재 ACL 재검사 후 RRF를 계산한다.
4. 외부 reranker에 본문을 보내기 직전에 현재 ACL을 다시 확인한다.
5. rerank/문맥 구성 후 `buildCitations`가 최종 공개 직전에 다시 권한을 확인한다.
6. 응답 송신을 권한 epoch와 묶는 transaction/CAS는 서비스가 구현해야 한다. 이 순수 라이브러리만으로 동시 철회와 네트워크 송신을 원자화할 수 없다.

`buildCitations`는 원래 후보 목록에 없는 ID를 거부하고, 선택한 근거 중 하나라도 삭제·교체·철회되면 전체 인용 생성을 실패시킨다. 인용에는 exact quote, ChunkRef, IndexRef, 검증 epoch가 들어간다. 모델이 말한 quote나 source URL을 그대로 채택하지 않는다. 인용의 존재는 답변의 모든 주장에 대한 의미적 entailment 검증을 대신하지 않는다.

파생 entity/relation/community/summary의 `supportingChunkIds`는 비어 있을 수 없다. `filterDerivedEvidence`는 **모든** 원문 근거에 현재 접근할 수 있을 때만 해당 파생 항목을 통과시킨다. 일부 근거만 공개라고 혼합 요약을 노출하지 않는다. 이는 GraphRAG indexing/local/global 검색 구현이 아니다.

## Hybrid/RRF/reranker

SearchResponse는 `{status:"ok",index,corpus,hits}` 또는 `{status:"failed",code}`다. 성공한 hits=[]와 검색 실패를 구분한다. 각 hit는 chunkId, 1부터 시작하는 provider rank, 선택적 raw score다. 제공자가 보낸 본문 대신 corpus의 청크 본문을 사용한다.

`normalizeRankedHits`는 같은 chunk의 가장 좋은 rank를 선택하고, 같은 best rank의 상충 score는 거부한다. rank가 건너뛰거나 동점이면 `(providerRank,candidateId)`로 정렬해 연속된 1-based rank로 만든다. ACL로 후보가 빠진 단일 채널도 재번호화한다. providerRank와 rawScore는 별도 보존한다.

RRF는 채널마다 `1/(k+rank)`를 더한다. k=1..1000, 채널별1000후보, candidateLimit=1..1000이다. BM25·벡터·reranker 점수를 서로 더하거나 척도를 임의 변환하지 않는다. 동점은 candidateId의 코드 단위 순서다. 한 fusion 안에서 다른 index generation을 섞지 않는다.

`applyRerank`는 fingerprint가 일치하는 **전체 후보의 정확한 순열**만 받는다. score는 유한 숫자이며 큰 값이 우선이고 동점은 ID다. 빠진/중복/후보 밖 ID는 설정이 use_original이어도 오류다. 실제 provider 실패에만 명시적인 fail/use_original 정책을 적용하며 fallback 결과에는 실패코드를 남긴다.

`buildBoundedContext`는 fingerprint가 붙은 실제 tokenizer의 count 함수를 주입받는다. 누적 prefix+source label+전체 chunk 문자열을 세고 다음 청크가 한도를 넘으면 멈춘다. 청크를 조용히 잘라 인용 범위를 어긋나게 만들지 않는다. 외부 모델에 보내는 전체 prompt와 토큰 계수기를 맞추는 책임은 호출 어댑터에 있다.

## Agentic 예산과 재검색

한 session이 scope·고정 index allowlist·등록 tool allowlist·limits·revision·operation ledger를 가진다. 현재 schema에 맞춰 rounds≤20, queries/round≤20, retrieved chunks≤1000, context tokens≤200000, steps≤100이다. 새 query 전에 round를 시작한다.

외부 호출 전 `reserveAgenticOperation`으로 operationId와 chunk/token 상한을 예약한다. 같은 ID와 같은 요청은 revision을 증가시키지 않고, 다른 요청이면 충돌이다. 이미 예약/완료된 ID에 대해 어댑터가 외부 호출을 다시 보내서는 안 된다. ledger의 steps/queries는 정산 후에도 소비된 상태를 유지한다.

`settleAgenticOperation(...,{status:"unknown"})`는 예약을 반환하지 않는다. 실제 결과가 확인된 뒤에만 actualChunks/actualContextTokens를 정산하고 미사용 예약을 돌려준다. 예약보다 큰 결과는 오류이며 이미 확정한 정산을 다른 값으로 바꿀 수 없다. 미확인 작업이 남으면 완료할 수 없다.

clarification 대기/재개는 같은 session과 누적 사용량을 보존한다. 새 round도 전체 chunk/token/step 예산을 초기화하지 않는다. 허용하지 않은 index generation·도구·scope를 선택하면 실패한다.

모든 상태 변경은 새 revision을 반환하는 순수 계산이다. **영속 DB CAS와 예약 transaction, 부모 run의 공유 예산, 동시 호출 제어, 실행 취소는 Runner가 구현해야 한다.** 같은 이전 revision에서 계산한 두 결과를 동시에 저장하면 안 된다. 답변 상태 answered/insufficient_evidence/conflicting_evidence/needs_clarification의 생성과 의미 검증은 아직 Agent handler의 후속 작업이다.

## 검증·미구현 범위

`tests/contracts/rag-core.test.ts`는 실제 bytes/hash, mutation, chunk 범위, embedding 설정/벡터 mismatch, 세대 활성화 충돌, 저장 artifact 변조, tenant/project ACL, tombstone/revision, 철회 후 인용, provenance 위조, 혼합권한 요약, rank normalization/RRF, rerank ID injection, token 한도, 예산 예약/미확인/clarification을 검사한다. 테스트의 가상 provider·artifact bytes는 내부 검증 자료이며 공식 검색 예제로 게시하지 않는다.

후속 구현으로 bounded BM25·exact vector 계산, SQLite 세대/원자적 활성화·현재 ACL 저장소, 실행별 키워드/벡터/혼합 build/open/search, 실제 `o200k_base` 문맥 계수를 연결했다. 임베딩과 선택적 재순위는 고정 OpenAI 어댑터·DPAPI·공유 예산에 연결했으나 테스트는 공급자 경계 대역을 사용했고 실제 API 호출은 하지 않았다. 편집기는 키워드·벡터·혼합 설정과 임베딩 연결을 제공한다. 상세 운영 범위는 [진행 상태](../implementation/status.md), [저장소](rag-store.md), [토큰 계산](rag-tokenizer.md), [임베딩 계약](rag-embeddings.md), [재순위 계약](rag-reranker.md), [편집기 계약](rag-authoring-ui.md)을 함께 확인한다.

후속 일반 AI의 문자열 전달은 [실행 전체의 공개 권한 기준](run-disclosure.md)으로 보수적으로 보호한다. 필드별 근거 추적은 아니며 관련 없는 값도 같은 실행이면 권한 변경 때 차단한다. 미구현: UTF-8 원문 외 parsing/OCR, 필드별 provenance, 물리 삭제·보존 정책과 무효화 전파, Agentic 실행, GraphRAG 구축·local/global 검색, Agentic query planner·모델 루프, 실제 분야별 검색 품질 검증. 내부 한국어24문항 진단은 [키워드 품질 기록](keyword-quality.md)에 있으며 자연어·형태소 검색의 한계를 확인했다. 이 패키지의 시험 통과를 해당 기능이나 240개 예제 완료로 세지 않는다.
