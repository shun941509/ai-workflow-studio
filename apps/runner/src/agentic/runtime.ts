import { canonicalDigest } from '@studio/package-kit';
import { assertJsonData, type WorkflowNode } from '@studio/spec';
import { validateAgenticRag, type NodeOutput } from '@studio/workflow-core';
import { agenticUsage, createAgenticSession, RagContractError } from '@studio/rag-core';
import { RunnerError, publicError } from '../errors.js';
import { ModelError, type ModelRequest, type ModelResponse } from '../providers/model-provider.js';
import type { RunStore } from '../state/store.js';
import type { AgenticResult, AgenticState } from '../state/agentic-state.js';
import type { RunRagExecution, RunRagRuntime } from '../rag/run-runtime.js';
import { AGENTIC_CONTRACT_HASH, prepareAgenticDecision, decodeAgenticDecision } from './contracts.js';

/** Sequential bounded planning uses the same root model/node/time budget and disclosure fence; models only propose data. */
export async function executeAgenticRag(input: { runId: string; nodeId: string; node: Extract<WorkflowNode, { type: 'agent' }>; inputs: Record<string, unknown>; store: RunStore; rag: RunRagRuntime; execution: RunRagExecution; invoke(request: Omit<ModelRequest, 'model'>): Promise<ModelResponse> }): Promise<NodeOutput> {
  const { runId, nodeId, node, inputs, store, rag, execution, invoke } = input; validateAgenticRag(node); assertJsonData(inputs);
  if (typeof inputs.task !== 'string' || !inputs.task.trim() || inputs.task.length > 16000 || Buffer.byteLength(JSON.stringify(inputs.context ?? null)) > 16384) throw new RunnerError('AGENTIC_INPUT_LIMIT', '작업은1~16000자, 추가 문맥은16 KiB 이하여야 합니다.');
  const checkpoint = () => { execution.signal.throwIfAborted(); execution.checkpoint(); }; checkpoint();
  const indexes = await rag.agenticIndexes(runId, inputs.indexes, execution); checkpoint();
  const policy = node.config.retrievalPolicy!; const limits = { maxSteps: node.config.maxSteps, maxRounds: policy.maxRounds, maxQueriesPerRound: policy.maxQueriesPerRound, maxRetrievedChunks: policy.maxRetrievedChunks, maxContextTokens: policy.maxContextTokens };
  const session = createAgenticSession({ id: `agentic_${canonicalDigest({ runId, nodeId })}`, scope: indexes[0]!.scope, limits, allowedIndexes: indexes, allowedTools: [] });
  let state: AgenticState = store.agentic.begin(runId, nodeId, canonicalDigest({ config: node.config, inputs, contractHash: AGENTIC_CONTRACT_HASH }), session);
  const aliases = indexes.map((_, i) => `i${i + 1}`);
  const finish = (status: AgenticResult['status'], result: unknown, evidenceIds: string[], stopReason: string): NodeOutput => {
    checkpoint(); const citations = evidenceIds.map(id => state.evidence.find(value => value.id === id)!.citation);
    const data: AgenticResult = { status, result, citations, stopReason, usage: agenticUsage(state.session) }; state = store.agentic.complete(runId, nodeId, state.revision, data);
    return { data, sources: citations, ...(typeof result === 'string' ? { text: result } : {}) };
  };
  try {
    for (;;) {
      checkpoint(); let usage = agenticUsage(state.session);
      if (usage.steps >= limits.maxSteps) return finish('insufficient_evidence', null, [], 'max_steps');
      // Evidence bytes retain original provenance. Prompt framing/count is separately measured by the shared remote broker.
      const prepared = prepareAgenticDecision({ task: inputs.task, context: inputs.context ?? null, instructions: node.config.instructions, indexes: aliases, evidence: state.evidence, remaining: { rounds: limits.maxRounds - usage.rounds, steps: limits.maxSteps - usage.steps, queriesPerRound: limits.maxQueriesPerRound, chunks: limits.maxRetrievedChunks - usage.retrievedChunks, retrievedContextTokens: limits.maxContextTokens - usage.contextTokens }, resultSchema: node.config.resultSchema });
      const modelOperation = `decision_${state.records.length + 1}`;
      state = store.agentic.reserve(runId, nodeId, state.revision, { operationId: modelOperation, kind: 'model', maxChunks: 0, maxContextTokens: 0 }, canonicalDigest(prepared.request));
      const response = await invoke(prepared.request);
      // Commit the confirmed response hash before interpretation. Invalid JSON/IDs cannot trigger a repeated paid decision.
      state = store.agentic.settle(runId, nodeId, state.revision, modelOperation, 0, 0, canonicalDigest({ text: response.text, model: response.model ?? null })); checkpoint();
      const decision = decodeAgenticDecision(response, prepared);
      if (decision.action === 'answer') return finish('answered', decision.result, decision.evidenceIds, 'answered');
      if (decision.action === 'abstain') return finish('insufficient_evidence', null, [], 'model_abstained');
      if (decision.action === 'conflict') return finish('conflicting_evidence', null, decision.evidenceIds, 'conflicting_evidence');
      usage = agenticUsage(state.session);
      if (decision.queries.length > limits.maxQueriesPerRound) throw new RunnerError('AGENTIC_QUERY_LIMIT', '계획이 회당 허용 질의 수를 초과했습니다.');
      // Retain one decision slot after the whole proposed query batch; never silently truncate or widen the plan.
      if (usage.rounds >= limits.maxRounds) return finish('insufficient_evidence', null, [], 'max_rounds');
      if (usage.steps + decision.queries.length + 1 > limits.maxSteps) return finish('insufficient_evidence', null, [], 'max_steps');
      if (limits.maxRetrievedChunks - usage.retrievedChunks < decision.queries.length || limits.maxContextTokens - usage.contextTokens < decision.queries.length * 20) return finish('insufficient_evidence', null, [], 'retrieval_budget');
      state = store.agentic.round(runId, nodeId, state.revision);
      for (let i = 0; i < decision.queries.length; i++) {
        checkpoint(); const query = decision.queries[i]!; const index = indexes[aliases.indexOf(query.index)]!; usage = agenticUsage(state.session); const remainingQueries = decision.queries.length - i;
        const chunks = Math.min(8, limits.maxRetrievedChunks - usage.retrievedChunks - remainingQueries + 1);
        const tokens = Math.min(4000, limits.maxContextTokens - usage.contextTokens - 20 * (remainingQueries - 1));
        const operationId = `query_${state.session.round}_${i + 1}`;
        state = store.agentic.reserve(runId, nodeId, state.revision, { operationId, kind: 'query', index, maxChunks: chunks, maxContextTokens: tokens }, canonicalDigest({ index, query: query.query, chunks, tokens, contractHash: AGENTIC_CONTRACT_HASH }));
        const result = await rag.agenticSearch(runId, nodeId, index, query.query, chunks, tokens, execution); checkpoint();
        const evidence = result.citations.map(citation => {
          const id = `e_${canonicalDigest({ index: citation.index, candidateId: citation.candidateId })}`;
          // Query-local source-1/source-2 ranks may change on a rewrite. Stable identity preserves every other byte/provenance/ACL field.
          return { id, citation: { ...citation, id } };
        });
        state = store.agentic.settle(runId, nodeId, state.revision, operationId, result.retrievedChunks, result.contextBudget.tokenCount, canonicalDigest(result), evidence);
      }
    }
  } catch (error) {
    const unknown = error instanceof ModelError && error.outcome === 'unknown' || !(error instanceof ModelError || error instanceof RunnerError || error instanceof RagContractError) && !execution.signal.aborted;
    const code = error instanceof ModelError || error instanceof RagContractError ? error.code : publicError(error).code;
    // Unknown paid outcomes outrank concurrent cancellation and preserve both reservation ledgers across restart.
    try { store.agentic.stop(runId, nodeId, state.revision, code, unknown ? 'attention_required' : execution.signal.aborted ? 'cancelled' : 'failed'); }
    catch { throw new RunnerError('AGENTIC_RECONCILIATION_REQUIRED', '에이전트 중단 기록을 확정하지 못했습니다. 자동 재실행하지 않습니다.'); }
    if (error instanceof ModelError && error.outcome === 'unknown') throw error;
    if (unknown) throw new RunnerError('AGENTIC_RECONCILIATION_REQUIRED', '에이전트 결과를 확정하지 못했습니다. 자동 재실행하지 않습니다.');
    if (error instanceof RagContractError) throw new RunnerError(error.code, error.message);
    throw error;
  }
}
