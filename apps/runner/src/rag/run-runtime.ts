import { join } from 'node:path';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { assertJsonData, type FileRef } from '@studio/spec';
import type { NodeOutput } from '@studio/workflow-core';
import { canonicalDigest } from '@studio/package-kit';
import { buildCitations, buildLocalSearchIndex, createCorpusGeneration, RagContractError, validateIndexRef, type Candidate, type DocumentInput, type IndexRef, type Principal } from '@studio/rag-core';
import { RunnerError } from '../errors.js';
import { interruption } from '../execution/concurrency.js';
import { RagStoreError } from './contracts.js';
import { SqliteRagStore } from './store.js';
import { RunRagLedger } from './run-ledger.js';
import { chunkUtf8, decodeManagedText, RUN_RAG_LIMITS, validateRunRagNode, type RunRagNode } from './run-contract.js';

export interface ManagedRagFile { reference: FileRef; bytes: Uint8Array }
export interface RunRagExecution { signal: AbortSignal; checkpoint(): void }
export type RunContextBuilder = (candidates: readonly Candidate[], maxTokens: number) => { text: string; candidates: readonly Candidate[]; tokenCount: number; tokenizerFingerprint: string; encoding: string; omittedCount: number };
type ReadManagedFile = (runId: string, reference: unknown) => ManagedRagFile;

/** Run-only keyword runtime. Identity, original bytes, authority changes and operation keys originate in the service. */
export class RunRagRuntime {
  readonly #ledger: RunRagLedger;
  readonly #store: SqliteRagStore;
  constructor(directory: string, private readonly readFile: ReadManagedFile, private readonly contextBuilder?: RunContextBuilder) {
    this.#ledger = new RunRagLedger(join(directory, 'operations.sqlite'));
    try { this.#store = new SqliteRagStore(join(directory, 'generations.sqlite')); }
    catch (error) { this.#ledger.close(); throw error; }
  }
  close(): void { this.#store.close(); this.#ledger.close(); }

  /** Completed search repeats are recomputed with current ACL; failed/uncertain intents never automatically replay. */
  async execute(runId: string, nodeInstanceId: string, node: RunRagNode, input: Record<string, unknown>, execution: RunRagExecution): Promise<NodeOutput> {
    assertJsonData(node); node = structuredClone(node); validateRunRagNode(node); assertJsonData(input);
    const owned = structuredClone(input); const principal = this.#ledger.principal(runId);
    const kind = node.type === 'retrieval' ? 'search' : node.config.operation as 'build' | 'open';
    const operationId = `op_${canonicalDigest({ runId, nodeInstanceId, kind })}`;
    const requestHash = canonicalDigest({ config: node.config, input: owned });
    const checkpoint = () => { if (execution.signal.aborted) throw interruption(execution.signal); execution.checkpoint(); };
    checkpoint(); let reserved = false;
    try {
      if (kind === 'build' && node.type === 'knowledge') {
        const settings = node.config.indexSettings!;
        if (Object.keys(owned).some(key => key !== 'documents') || !Array.isArray(owned.documents) || !owned.documents.length || owned.documents.length > RUN_RAG_LIMITS.files) throw new RunnerError('RAG_INPUT_LIMIT', '색인에는 현재 실행에서 선택한 1~32개 파일이 필요합니다.');
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
        const identity = canonicalDigest({ operationId });
        const corpus = await createCorpusGeneration({ scope: principal.scope, corpusId: `corpus_${identity}`, generationId: `generation_${requestHash}`, documents, chunks }); checkpoint();
        const bundle = await buildLocalSearchIndex({ corpus, indexId: `index_${identity}`, generationId: `generation_${requestHash}`, kind: 'keyword' }); checkpoint();
        const ref = await this.#store.stageGeneration({ ...bundle, documents }); checkpoint();
        this.grantNewFiles(principal, documents); checkpoint();
        await this.#store.activate(principal.scope, ref, null); checkpoint();
        this.#ledger.complete(runId, operationId, ref);
        return { data: ref };
      }
      if (Object.keys(owned).some(key => !['index', ...(kind === 'search' ? ['query'] : [])].includes(key))) throw new RunnerError('RAG_INPUT_INVALID', '색인·검색어 외의 입력은 지원하지 않습니다.');
      if (kind === 'search' && !this.contextBuilder) throw new RunnerError('RAG_TOKENIZER_REQUIRED', '검증된 문맥 토큰 계산기가 연결되지 않았습니다.');
      const ref = await this.open(principal, owned.index); checkpoint();
      const previous = this.#ledger.reserve(runId, operationId, requestHash, kind, 0, 0); reserved = !previous;
      if (kind === 'open') { if (!previous) this.#ledger.complete(runId, operationId, ref); return { data: ref }; }
      if (node.type !== 'retrieval' || typeof owned.query !== 'string' || !owned.query.trim() || owned.query.length > 8192) throw new RunnerError('RAG_QUERY_INVALID', '8192자 이하의 검색어가 필요합니다.');
      const result = await this.#store.search(principal, ref, { query: owned.query, channel: 'keyword', limit: node.config.topK }, execution.signal); checkpoint();
      // The service injects a fingerprinted tokenizer; bytes/characters are never mislabeled as model token counts.
      const context = this.contextBuilder!(result.candidates, node.config.maxContextTokens);
      if (!Number.isSafeInteger(context.tokenCount) || context.tokenCount < 0 || context.tokenCount > node.config.maxContextTokens || !/^[a-f0-9]{64}$/.test(context.tokenizerFingerprint) || Buffer.byteLength(context.text) > 2 * 1024 * 1024 || context.candidates.some(candidate => !result.candidates.some(original => canonicalDigest(original) === canonicalDigest(candidate)))) throw new RunnerError('RAG_TOKENIZER_INVALID', '문맥 토큰 계산 결과가 고정 검색 근거·한도와 일치하지 않습니다.');
      const selected = context.candidates;
      const bundle = await this.#store.loadGeneration(principal.scope, ref); checkpoint();
      const citations = selected.length ? await buildCitations(selected.map(candidate => candidate.id), { principal, corpus: bundle.corpus, index: bundle.index }, selected, this.#store.authority) : []; checkpoint();
      const authorizationEpoch = citations[0]?.authorizationEpoch ?? this.#store.readCurrent(principal.scope, principal.subjectId).epoch;
      const data = { index: ref, candidates: selected, citations, context: context.text, authorizationEpoch, contextBudget: { limit: node.config.maxContextTokens, tokenCount: context.tokenCount, tokenizerFingerprint: context.tokenizerFingerprint, encoding: context.encoding, omittedCount: context.omittedCount } };
      if (!previous) this.#ledger.complete(runId, operationId, ref);
      return { data, text: context.text, sources: [...citations] };
    } catch (error) {
      // Unknown storage failures may happen after staging/activation. Keep their intent unresolved and never guess rollback.
      if (reserved && !(error instanceof RunnerError || error instanceof RagContractError || error instanceof RagStoreError) && !execution.signal.aborted) throw new RunnerError('RAG_RECONCILIATION_REQUIRED', '색인 저장 결과를 확정하지 못했습니다. 자동 재실행하지 않습니다.');
      if (reserved) { try { this.#ledger.fail(runId, operationId); } catch { throw new RunnerError('RAG_RECONCILIATION_REQUIRED', '검색 중단 기록을 확정하지 못했습니다. 자동 재실행하지 않습니다.'); } }
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
  private grantNewFiles(principal: Principal, documents: readonly DocumentInput[]): void {
    if (!this.#store.hasCurrentSubject(principal.scope, principal.subjectId)) throw new RunnerError('RAG_ACCESS_REVOKED', '현재 실행의 지식 접근 주체가 철회되었습니다.');
    const current = this.#store.readCurrent(principal.scope, principal.subjectId);
    // Preserve existing ACL and tombstones; rebuilding a source never resurrects access that trusted administration revoked.
    const known = new Set(current.documents.map(document => document.documentId));
    this.#store.replaceAccess(principal.scope, { expectedEpoch: current.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: current.groupIds }], documents: [...current.documents, ...documents.filter(document => !known.has(document.documentId)).map(document => ({ documentId: document.documentId, revision: document.revision, tombstoned: false, allowedSubjects: [principal.subjectId], allowedGroups: [] }))] });
  }
  private async open(principal: Principal, value: unknown): Promise<IndexRef> {
    assertJsonData(value); validateIndexRef(value as IndexRef); const ref = structuredClone(value) as IndexRef;
    if (canonicalDigest(ref.scope) !== canonicalDigest(principal.scope)) throw new RunnerError('RAG_RUN_SCOPE_DENIED', '색인은 현재 실행에서 만든 참조만 사용할 수 있습니다.', 403);
    if (!this.#ledger.ownsIndex(principal.scope.projectId, ref)) throw new RunnerError('RAG_INDEX_NOT_OWNED', '현재 실행에서 생성 완료한 색인만 사용할 수 있습니다.');
    const active = this.#store.getActiveIndex(principal.scope, ref.indexId);
    if (!active || canonicalDigest(active.ref) !== canonicalDigest(ref)) throw new RunnerError('RAG_INDEX_NOT_ACTIVE', '현재 실행에서 검증·활성화한 고정 색인이 필요합니다.');
    const bundle = await this.#store.loadGeneration(principal.scope, ref);
    if (bundle.index.kind !== 'keyword') throw new RunnerError('RAG_MODE_UNSUPPORTED', '현재 실행용 키워드 색인만 열 수 있습니다.');
    return ref;
  }
}
