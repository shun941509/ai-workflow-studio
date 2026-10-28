import { join } from 'node:path';
import { searchRunIndex } from './search-kernel.js';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { assertJsonData, type FileRef } from '@studio/spec';
import type { NodeOutput } from '@studio/workflow-core';
import { canonicalDigest } from '@studio/package-kit';
import { buildLocalSearchIndex, createCorpusGeneration, RagContractError, validateIndexRef, type Candidate, type DocumentInput, type IndexRef, type Principal } from '@studio/rag-core';
import { RunnerError } from '../errors.js';
import { interruption } from '../execution/concurrency.js';
import { RagStoreError } from './contracts.js';
import { SqliteRagStore } from './store.js';
import { RunRagLedger } from './run-ledger.js';
import { chunkUtf8, decodeManagedText, RUN_RAG_LIMITS, validateRunRagNode, type RunRagNode } from './run-contract.js';
import { embeddingBatches } from '../providers/embedding-contract.js';
import { ModelError } from '../providers/model-provider.js';
import type { RunEmbeddings } from './embedding-session.js';
import type { RunReranker } from './rerank-session.js';
import { disclosureError, disclosureSnapshot, type DisclosureSnapshot } from '../provenance/run-disclosure.js';

export interface ManagedRagFile { reference: FileRef; bytes: Uint8Array }
export interface RunRagExecution { signal: AbortSignal; checkpoint(): void }
export type RunContextBuilder = (candidates: readonly Candidate[], maxTokens: number) => { text: string; candidates: readonly Candidate[]; tokenCount: number; tokenizerFingerprint: string; encoding: string; omittedCount: number };
type ReadManagedFile = (runId: string, reference: unknown) => ManagedRagFile;
export interface RunRagDisclosure { assert(runId: string): void; unobserved(runId: string): boolean; pin(runId: string, snapshot: DisclosureSnapshot): void; block(runId: string, code: string): void; inventory(runId: string): readonly FileRef[] }

/** Run-only local search runtime. Identity, bytes, authority, embedding bindings and operation keys originate in the service. */
export class RunRagRuntime {
  readonly #ledger: RunRagLedger;
  readonly #store: SqliteRagStore;
  constructor(directory: string, private readonly readFile: ReadManagedFile, private readonly contextBuilder?: RunContextBuilder, private readonly embeddings?: RunEmbeddings, private readonly reranker?: RunReranker, private readonly disclosure?: RunRagDisclosure) {
    this.#ledger = new RunRagLedger(join(directory, 'operations.sqlite'));
    try { this.#store = new SqliteRagStore(join(directory, 'generations.sqlite')); }
    catch (error) { this.#ledger.close(); throw error; }
  }
  close(): void { this.#store.close(); this.#ledger.close(); }
  /** Publication checks read existing authority only; they never initialize a missing scope or grant access. */
  currentDisclosure(runId: string): DisclosureSnapshot { const principal = this.#ledger.principal(runId); return disclosureSnapshot(this.#store.readCurrent(principal.scope, principal.subjectId)); }

  /** Agentic callers receive verified run-local keyword generations; their own journal owns query identity. */
  async agenticIndexes(runId: string, values: unknown, execution: RunRagExecution): Promise<IndexRef[]> {
    if (!Array.isArray(values) || !values.length || values.length > 4) throw new RunnerError('AGENTIC_INDEX_LIMIT', '현재 실행의 키워드 색인을 1~4개 연결하세요.');
    const principal = this.#ledger.principal(runId); const refs: IndexRef[] = [];
    for (const value of values) {
      execution.checkpoint(); this.disclosure?.assert(runId);
      const ref = await this.open(principal, value); const bundle = await this.#store.loadGeneration(principal.scope, ref);
      if (bundle.index.kind !== 'keyword' || refs.some(item => item.indexId === ref.indexId)) throw new RunnerError('AGENTIC_INDEX_DENIED', '중복 없는 현재 실행의 키워드 색인만 사용할 수 있습니다.');
      refs.push(ref);
    }
    this.disclosure?.pin(runId, this.currentDisclosure(runId)); execution.checkpoint(); this.disclosure?.assert(runId);
    return refs;
  }

  async agenticSearch(runId: string, nodeInstanceId: string, reference: IndexRef, query: string, maxChunks: number, maxContextTokens: number, execution: RunRagExecution) {
    const [ref] = await this.agenticIndexes(runId, [reference], execution);
    if (!this.contextBuilder || typeof query !== 'string' || !query.trim() || query.length > 8192 || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100 || !Number.isSafeInteger(maxContextTokens) || maxContextTokens < 20 || maxContextTokens > 12000) throw new RunnerError('AGENTIC_QUERY_INVALID', '검색어·청크·문맥 한도가 올바르지 않습니다.');
    return searchRunIndex({ store: this.#store, principal: this.#ledger.principal(runId), ref: ref!, runId, nodeInstanceId, query, config: { mode: 'keyword', topK: maxChunks, maxContextTokens }, execution, checkpoint: () => { execution.checkpoint(); this.disclosure?.assert(runId); }, contextBuilder: this.contextBuilder });
  }

  /** Completed search repeats are recomputed with current ACL; failed/uncertain intents never automatically replay. */
  async execute(runId: string, nodeInstanceId: string, node: RunRagNode, input: Record<string, unknown>, execution: RunRagExecution): Promise<NodeOutput> {
    assertJsonData(node); node = structuredClone(node); validateRunRagNode(node); assertJsonData(input);
    const owned = structuredClone(input); const principal = this.#ledger.principal(runId);
    const kind = node.type === 'retrieval' ? 'search' : node.config.operation as 'build' | 'open';
    const operationId = `op_${canonicalDigest({ runId, nodeInstanceId, kind })}`;
    const requestHash = canonicalDigest({ config: node.config, input: owned });
    const checkpoint = () => { if (execution.signal.aborted) throw interruption(execution.signal); execution.checkpoint(); this.disclosure?.assert(runId); };
    checkpoint(); let reserved = false;
    try {
      if (kind === 'build' && node.type === 'knowledge') {
        const settings = node.config.indexSettings!;
        if (Object.keys(owned).some(key => key !== 'documents') || !Array.isArray(owned.documents) || !owned.documents.length || owned.documents.length > RUN_RAG_LIMITS.files) throw new RunnerError('RAG_INPUT_LIMIT', '색인에는 현재 실행에서 선택한 1~32개 파일이 필요합니다.');
        // Seal before decoding the first source or yielding. The metadata inventory does not read nonselected/binary file bytes.
        if (this.disclosure?.unobserved(runId)) {
          this.ensureScope(principal);
          const inventory = this.disclosure.inventory(runId).map(file => ({ documentId: file.id, revision: 1 }));
          this.#store.registerManagedDocuments(principal.scope, principal.subjectId, inventory.map(file => file.documentId), true);
          // A denied preexisting file must not become the accepted baseline for later artifact downloads.
          this.assertReadable(principal, inventory);
          this.disclosure.pin(runId, this.currentDisclosure(runId)); checkpoint();
        }
        const documents: DocumentInput[] = []; const chunks: { chunkId: string; documentId: string; start: number; end: number }[] = []; let bytes = 0;
        const seen = new Set<string>();
        for (const value of owned.documents) {
          checkpoint(); const file = this.readFile(runId, value);
          if (seen.has(file.reference.id)) throw new RunnerError('RAG_FILE_DUPLICATE', '같은 파일을 한 색인에 두 번 연결할 수 없습니다.'); seen.add(file.reference.id);
          bytes += file.bytes.byteLength; if (bytes > RUN_RAG_LIMITS.buildBytes) throw new RunnerError('RAG_INPUT_LIMIT', '한 색인의 원문 합계는 최대 8 MiB입니다.');
          const text = decodeManagedText(file.reference, file.bytes);
          documents.push({ documentId: file.reference.id, revision: 1, originalBytes: new Uint8Array(file.bytes), extractedText: text, sourceUri: `urn:studio:file:${file.reference.id}`, extraction: { id: 'studio-utf8-text', version: '1', options: { mimeType: file.reference.mimeType, preserveBom: true } } });
          for (const range of chunkUtf8(file.bytes, settings.chunkSize, settings.chunkOverlap)) chunks.push({ chunkId: `chunk_${canonicalDigest({ fileId: file.reference.id, ...range })}`, documentId: file.reference.id, ...range });
          if (chunks.length > RUN_RAG_LIMITS.buildChunks) throw new RunnerError('RAG_INPUT_LIMIT', '한 색인은 최대 1000개의 청크를 지원합니다.');
          await yieldToHost(); checkpoint();
        }
        const previous = this.#ledger.reserve(runId, operationId, requestHash, kind, bytes, chunks.length);
        if (previous) { const ref = await this.open(principal, previous.result); checkpoint(); return { data: ref }; }
        reserved = true;
        this.ensureScope(principal); checkpoint();
        // The first observation seals the already-registered file IDs; indexing still reads only selected, bounded UTF-8 documents.
        const inventory = this.disclosure?.unobserved(runId) ? this.disclosure.inventory(runId).map(file => file.id) : documents.map(document => document.documentId);
        this.#store.registerManagedDocuments(principal.scope, principal.subjectId, inventory, this.disclosure?.unobserved(runId) ?? true);
        this.assertReadable(principal, documents);
        this.disclosure?.pin(runId, this.currentDisclosure(runId)); checkpoint();
        const identity = canonicalDigest({ operationId });
        const corpus = await createCorpusGeneration({ scope: principal.scope, corpusId: `corpus_${identity}`, generationId: `generation_${requestHash}`, documents, chunks }); checkpoint();
        const indexKind = settings.kind as 'keyword' | 'vector' | 'hybrid';
        const profile = indexKind === 'keyword' ? undefined : this.embeddings?.profile(runId, settings.embeddingProfile!);
        if (indexKind !== 'keyword' && !profile) throw new RunnerError('EMBEDDING_PROFILE_UNSUPPORTED', '고정한 임베딩 실행 연결이 필요합니다.');
        // Validate all chunks before sending the first batch. Only a complete vector inventory can be staged.
        const batches = profile ? embeddingBatches(corpus.chunks.map(chunk => chunk.text)) : [];
        const vectors: number[][] = [];
        for (const batch of batches) { checkpoint(); this.assertReadable(principal, documents); vectors.push(...await this.embeddings!.embed(runId, nodeInstanceId, profile!, batch, execution.signal)); checkpoint(); this.assertReadable(principal, documents); }
        const bundle = await buildLocalSearchIndex({ corpus, indexId: `index_${identity}`, generationId: `generation_${requestHash}`, kind: indexKind, ...(profile ? { embeddingProfile: profile, embeddings: corpus.chunks.map((chunk, offset) => ({ chunkId: chunk.ref.chunkId, vector: vectors[offset]! })) } : {}) }); checkpoint();
        if (profile) this.assertReadable(principal, documents);
        const ref = await this.#store.stageGeneration({ ...bundle, documents }); checkpoint();
        checkpoint(); this.assertReadable(principal, documents);
        const activationAuthority = { subjectId: principal.subjectId, epoch: this.#store.readCurrent(principal.scope, principal.subjectId).epoch };
        await this.#store.activate(principal.scope, ref, null, activationAuthority); checkpoint();
        this.#ledger.complete(runId, operationId, ref);
        return { data: ref };
      }
      if (Object.keys(owned).some(key => !['index', ...(kind === 'search' ? ['query'] : [])].includes(key))) throw new RunnerError('RAG_INPUT_INVALID', '색인·검색어 외의 입력은 지원하지 않습니다.');
      if (kind === 'search' && !this.contextBuilder) throw new RunnerError('RAG_TOKENIZER_REQUIRED', '검증된 문맥 토큰 계산기가 연결되지 않았습니다.');
      // A foreign reference is rejected before looking up any authority for the current run.
      validateIndexRef(owned.index as IndexRef);
      if (canonicalDigest((owned.index as IndexRef).scope) !== canonicalDigest(principal.scope)) throw new RunnerError('RAG_RUN_SCOPE_DENIED', '색인은 현재 실행에서 만든 참조만 사용할 수 있습니다.', 403);
      this.disclosure?.pin(runId, this.currentDisclosure(runId)); checkpoint();
      const ref = await this.open(principal, owned.index); checkpoint();
      const previous = this.#ledger.reserve(runId, operationId, requestHash, kind, 0, 0); reserved = !previous;
      if (kind === 'open') { if (!previous) this.#ledger.complete(runId, operationId, ref); return { data: ref }; }
      if (node.type !== 'retrieval' || typeof owned.query !== 'string' || !owned.query.trim() || owned.query.length > 8192) throw new RunnerError('RAG_QUERY_INVALID', '8192자 이하의 검색어가 필요합니다.');
      if (previous && (node.config.mode !== 'keyword' || node.config.reranker)) throw new RunnerError('RAG_REPLAY_FORBIDDEN', '완료한 외부 모델 검색을 자동으로 재전송하지 않습니다. 새 실행을 시작하세요.');
      const data = await searchRunIndex({ store: this.#store, principal, ref, runId, nodeInstanceId, query: owned.query, config: node.config, execution, checkpoint, contextBuilder: this.contextBuilder!, embeddings: this.embeddings, reranker: this.reranker });
      if (!previous) this.#ledger.complete(runId, operationId, ref);
      return { data, text: data.context, sources: [...data.citations] };
    } catch (error) {
      if (this.disclosure && (error instanceof RunnerError || error instanceof RagStoreError) && error.code === 'RAG_ACCESS_REVOKED') {
        this.disclosure.block(runId, 'RAG_DISCLOSURE_CHANGED'); error = disclosureError('RAG_DISCLOSURE_CHANGED');
      }
      // Unknown storage failures may happen after staging/activation. Keep their intent unresolved and never guess rollback.
      if (reserved && !(error instanceof RunnerError || error instanceof RagContractError || error instanceof RagStoreError || error instanceof ModelError) && !execution.signal.aborted) throw new RunnerError('RAG_RECONCILIATION_REQUIRED', '색인 저장 결과를 확정하지 못했습니다. 자동 재실행하지 않습니다.');
      if (reserved) { try { this.#ledger.fail(runId, operationId); } catch { throw new RunnerError('RAG_RECONCILIATION_REQUIRED', '검색 중단 기록을 확정하지 못했습니다. 자동 재실행하지 않습니다.'); } }
      // A shared cancellation cannot prove that a dispatched model request was unbilled or unfinished.
      // Preserve unknown outcomes so the outer run remains attention_required with its reservation held.
      if (error instanceof ModelError && error.outcome === 'unknown') throw error;
      if (execution.signal.aborted) throw interruption(execution.signal);
      if (error instanceof RagContractError || error instanceof RagStoreError) throw new RunnerError(error.code, error.message);
      throw error;
    }
  }

  private ensureScope(principal: Principal): void {
    try { if (!this.#store.hasCurrentSubject(principal.scope, principal.subjectId)) throw new RunnerError('RAG_ACCESS_REVOKED', '현재 실행의 지식 접근 주체가 철회되었습니다.'); }
    catch (error) {
      if (!(error instanceof RagStoreError) || error.code !== 'RAG_SCOPE_NOT_FOUND') throw error;
      this.#store.createScope(principal.scope);
      this.#store.replaceAccess(principal.scope, { expectedEpoch: 1, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: [] });
    }
  }
  /** Rebuilding a revoked source cannot disclose it to an embedding provider or resurrect its tombstone. */
  private assertReadable(principal: Principal, documents: readonly Pick<DocumentInput, 'documentId' | 'revision'>[]): void {
    const current = this.#store.readCurrent(principal.scope, principal.subjectId);
    for (const document of documents) {
      const access = current.documents.find(value => value.documentId === document.documentId);
      if (!access || access.tombstoned || access.revision !== document.revision || !(access.allowedSubjects.includes(principal.subjectId) || access.allowedGroups.some(group => current.groupIds.includes(group)))) throw new RunnerError('RAG_ACCESS_REVOKED', '색인 원문 접근 권한이 철회되었습니다.');
    }
  }
  private async open(principal: Principal, value: unknown): Promise<IndexRef> {
    assertJsonData(value); validateIndexRef(value as IndexRef); const ref = structuredClone(value) as IndexRef;
    if (canonicalDigest(ref.scope) !== canonicalDigest(principal.scope)) throw new RunnerError('RAG_RUN_SCOPE_DENIED', '색인은 현재 실행에서 만든 참조만 사용할 수 있습니다.', 403);
    if (!this.#ledger.ownsIndex(principal.scope.projectId, ref)) throw new RunnerError('RAG_INDEX_NOT_OWNED', '현재 실행에서 생성 완료한 색인만 사용할 수 있습니다.');
    const active = this.#store.getActiveIndex(principal.scope, ref.indexId);
    if (!active || canonicalDigest(active.ref) !== canonicalDigest(ref)) throw new RunnerError('RAG_INDEX_NOT_ACTIVE', '현재 실행에서 검증·활성화한 고정 색인이 필요합니다.');
    const bundle = await this.#store.loadGeneration(principal.scope, ref);
    if (!['keyword', 'vector', 'hybrid'].includes(bundle.index.kind)) throw new RunnerError('RAG_MODE_UNSUPPORTED', '현재 실행용 키워드·벡터·혼합 색인만 열 수 있습니다.');
    if (bundle.index.embedding) {
      const pinned = bundle.index.embedding.profile; const current = this.embeddings?.profile(principal.scope.projectId, String(pinned.parameters.bindingAlias));
      if (!current || canonicalDigest(current) !== canonicalDigest(pinned)) throw new RunnerError('EMBEDDING_PROFILE_MISMATCH', '색인 생성 때 고정한 임베딩 연결과 현재 연결이 다릅니다.');
    }
    return ref;
  }
}
