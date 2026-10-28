import type { WorkflowNode } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { authorizeCurrent, embeddingFingerprint, fuseRrf, buildCitations, type Principal, type IndexRef } from '@studio/rag-core';
import { RunnerError } from '../errors.js';
import type { SqliteRagStore } from './store.js';
import type { RunEmbeddings } from './embedding-session.js';
import type { RunReranker, RerankDetail } from './rerank-session.js';
import type { RunContextBuilder, RunRagExecution } from './run-runtime.js';

/** Shared actual search/authorization/context kernel. Callers must first validate run ownership and active immutable generation. */
export async function searchRunIndex(input: { store: SqliteRagStore; principal: Principal; ref: IndexRef; runId: string; nodeInstanceId: string; query: string; config: Extract<WorkflowNode,{type:'retrieval'}>['config']; execution: RunRagExecution; checkpoint():void; contextBuilder: RunContextBuilder; embeddings?: RunEmbeddings; reranker?: RunReranker }) {
  const { store, principal, ref, runId, nodeInstanceId, query, config, execution, checkpoint, contextBuilder, embeddings, reranker } = input;
      const bundle = await store.loadGeneration(principal.scope, ref); checkpoint();
      const embedding = bundle.index.embedding;
      const embedder = { embed: async (query: string, profile: NonNullable<typeof embedding>['profile'], signal: AbortSignal) => {
        if (!embeddings) throw new RunnerError('EMBEDDING_PROFILE_UNSUPPORTED', '검색 임베딩 연결이 필요합니다.');
        const vectors = await embeddings.embed(runId, nodeInstanceId, profile, [query], signal);
        return { fingerprint: await embeddingFingerprint(profile), vector: vectors[0]! };
      } };
      let result;
      if (config.mode === 'hybrid') {
        const keyword = await store.search(principal, ref, { query: query, channel: 'keyword', limit: config.keywordTopK! }, execution.signal); checkpoint();
        const vector = await store.search(principal, ref, { query: query, channel: 'vector', limit: config.vectorTopK! }, execution.signal, embedder); checkpoint();
        if (keyword.authorizationEpoch !== vector.authorizationEpoch) throw new RunnerError('RAG_AUTHORIZATION_CHANGED', '두 검색 중 접근 권한이 바뀌어 혼합 결과를 반환하지 않았습니다.');
        const fused = fuseRrf({ keyword: keyword.candidates, vector: vector.candidates }, { k: config.fusion!.k, candidateLimit: config.candidateLimit! });
        result = await authorizeCurrent({ principal, corpus: bundle.corpus, index: bundle.index }, fused, store.authority); checkpoint();
        if (!config.reranker) result = { ...result, candidates: result.candidates.slice(0, config.topK) };
      } else result = await store.search(principal, ref, { query: query, channel: config.mode as 'keyword' | 'vector', limit: config.reranker ? config.candidateLimit! : config.topK }, execution.signal, embedder);
      checkpoint();
      const expectedEpoch = result.authorizationEpoch;
      // Search already verified each candidate against the sealed corpus. A synchronous current epoch check closes the
      // async count/generate gap without trusting stale session groups or silently editing the frozen request inventory.
      const authorizeDisclosure = () => {
        checkpoint(); const current = store.readCurrent(principal.scope, principal.subjectId);
        if (current.subjectId !== principal.subjectId || current.epoch !== expectedEpoch) throw new RunnerError('RAG_AUTHORIZATION_CHANGED', '후보 접근 권한이 바뀌어 재순위 전송·결과 공개를 중단했습니다.');
      };
      let rerank: RerankDetail | undefined;
      if (config.reranker) {
        if (!reranker) throw new RunnerError('RERANK_PROFILE_UNSUPPORTED', '재순위 실행 중계가 연결되지 않았습니다.');
        const ranked = await reranker.rerank(runId, nodeInstanceId, config.reranker.modelProfile, query, result.candidates, { ...config.reranker, topK: config.topK }, execution.signal, authorizeDisclosure);
        result = { ...result, candidates: ranked.candidates }; rerank = ranked.detail; checkpoint();
      }
      // The service injects a fingerprinted tokenizer; bytes/characters are never mislabeled as model token counts.
      const context = contextBuilder!(result.candidates, config.maxContextTokens);
      if (!Number.isSafeInteger(context.tokenCount) || context.tokenCount < 0 || context.tokenCount > config.maxContextTokens || !/^[a-f0-9]{64}$/.test(context.tokenizerFingerprint) || Buffer.byteLength(context.text) > 2 * 1024 * 1024 || context.candidates.some(candidate => !result.candidates.some(original => canonicalDigest(original) === canonicalDigest(candidate)))) throw new RunnerError('RAG_TOKENIZER_INVALID', '문맥 토큰 계산 결과가 고정 검색 근거·한도와 일치하지 않습니다.');
      const selected = context.candidates;
      const citations = selected.length ? await buildCitations(selected.map(candidate => candidate.id), { principal, corpus: bundle.corpus, index: bundle.index }, selected, store.authority) : []; checkpoint();
      if (rerank) authorizeDisclosure();
      const authorizationEpoch = citations[0]?.authorizationEpoch ?? store.readCurrent(principal.scope, principal.subjectId).epoch;
      const data = { index: ref, candidates: selected, retrievedChunks: result.candidates.length, citations, context: context.text, authorizationEpoch, ...(rerank ? { rerank } : {}), contextBudget: { limit: config.maxContextTokens, tokenCount: context.tokenCount, tokenizerFingerprint: context.tokenizerFingerprint, encoding: context.encoding, omittedCount: context.omittedCount } };
  return data;
}
