import { setImmediate as yieldTurn } from 'node:timers/promises';
import { assertJsonData, validateJsonValue, type WorkflowNode } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import type { NodeOutput } from '@studio/workflow-core';
import { RunnerError, publicError } from '../errors.js';
import { ModelError } from '../providers/model-provider.js';
import type { CandidateRecord, CandidateSearchState, CandidateSearchStore, CandidateVerifierPin } from '../state/candidate-search-state.js';
import { interruption } from './concurrency.js';

export type CandidateSearchNode = Extract<WorkflowNode, { type: 'candidate_search' }>;
export interface CandidateGoal { task: string; acceptanceSchema: unknown }
export interface CandidateGeneratorInput { goal: CandidateGoal; parent: Pick<CandidateRecord, 'id' | 'value' | 'depth'> | null; depth: number; remaining: { candidates: number; verifications: number } }
const descriptor = { id: 'json-schema-v1', version: 1, validation: 'studio-bounded-json-schema', selection: 'breadth-first-first-accepted', scores: 'accepted-1-rejected-0', goal: ['task', 'acceptanceSchema'], result: ['candidates'] } as const;
export const CANDIDATE_VERIFIER: Readonly<CandidateVerifierPin> = Object.freeze({ id: descriptor.id, version: descriptor.version, contractHash: canonicalDigest(descriptor) });
export const CANDIDATE_CAPABILITIES = ['node.candidate_search@1', 'candidate_search.tree@1', 'verifier.json-schema-v1@1'] as const;
const MAX_VALUE_BYTES = 64 * 1024, MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

/** Saved runs may outlive a Runner update; a descriptor pin is enforced, not merely displayed in the plan. */
export function assertCandidateVerifierPin(plan: unknown): void {
  const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  const pin = field(field(field(field(plan, 'resolved'), 'verifiedDependencies'), 'candidateVerifiers'), CANDIDATE_VERIFIER.id);
  if (!validateJsonValue({ const: CANDIDATE_VERIFIER }, pin).valid) throw new RunnerError('CANDIDATE_VERIFIER_CHANGED', '저장된 계획의 검증기 버전과 현재 Runner가 다릅니다. 새 실행 계획이 필요합니다.');
}

/** Probe validates the schema itself before generation; a valid schema rejecting null is not a configuration error. */
export function readCandidateGoal(value: unknown): CandidateGoal {
  const shape = { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: 20000 }, acceptanceSchema: {} }, required: ['task', 'acceptanceSchema'], additionalProperties: false };
  if (!validateJsonValue(shape, value).valid) throw new RunnerError('CANDIDATE_GOAL_INVALID', '목표에는 task와 acceptanceSchema만 필요합니다.');
  const goal = value as CandidateGoal;
  if (!goal.task.trim() || Buffer.byteLength(JSON.stringify(goal)) > 256 * 1024) throw new RunnerError('CANDIDATE_GOAL_INVALID', '목표 설명과 검증 형식의 크기를 확인하세요.');
  const probe = validateJsonValue(goal.acceptanceSchema, null);
  if (probe.issues.some(issue => issue.code === 'UNSUPPORTED_SCHEMA_OR_VALUE')) throw new RunnerError('CANDIDATE_SCHEMA_UNSUPPORTED', '등록 검증기가 안전하게 검사할 수 없는 JSON Schema입니다.');
  return structuredClone(goal);
}

/** Bounds cover both admitted data and pending generator output; excessive results are never silently truncated. */
export function boundedCandidates(value: unknown, maximum: number, previous: readonly unknown[] = []): unknown[] {
  try { assertJsonData(value); } catch { throw new RunnerError('CANDIDATE_INPUT_INVALID', '후보는 일반 JSON 값 목록이어야 합니다.'); }
  if (!Array.isArray(value)) throw new RunnerError('CANDIDATE_INPUT_INVALID', '후보 목록이 필요합니다.');
  if (value.length > maximum) throw new RunnerError('CANDIDATE_LIMIT', '후보 수가 예약한 한도를 초과했습니다.');
  let bytes = previous.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  for (const item of value) { const size = Buffer.byteLength(JSON.stringify(item)); if (size > MAX_VALUE_BYTES) throw new RunnerError('CANDIDATE_LIMIT', '후보 하나는 64 KiB를 넘을 수 없습니다.'); bytes += size; }
  if (bytes > MAX_CANDIDATE_BYTES) throw new RunnerError('CANDIDATE_LIMIT', '전체 후보 내용은 2 MiB를 넘을 수 없습니다.');
  return structuredClone(value);
}
export function validateCandidateSearchNode(node: CandidateSearchNode): void {
  if (node.config.mode !== 'tree' || node.config.verifierId !== CANDIDATE_VERIFIER.id || node.config.generatorFlowRef.kind !== 'local') throw new RunnerError('CANDIDATE_MODE_UNSUPPORTED', '등록된 json-schema-v1 검증기와 로컬 생성 흐름을 사용하는 tree 탐색만 지원합니다.');
  if (node.inputBindings.goal?.from === 'literal') readCandidateGoal(node.inputBindings.goal.value);
  if (node.inputBindings.initialCandidates?.from === 'literal') boundedCandidates(node.inputBindings.initialCandidates.value, node.config.maxCandidates);
}

export interface CandidateExecution {
  runId: string; nodeId: string; store: CandidateSearchStore; signal: AbortSignal; checkpoint: () => void;
  generate: (key: string, input: CandidateGeneratorInput, signal: AbortSignal) => Promise<NodeOutput>;
}

/** All generation uses the parent's scoped executor; this module cannot call a model, Worker, tool or arbitrary module itself. */
export async function executeCandidateSearch(node: CandidateSearchNode, inputs: Record<string, unknown>, context: CandidateExecution): Promise<NodeOutput> {
  validateCandidateSearchNode(node); const goal = readCandidateGoal(inputs.goal);
  const seeds = boundedCandidates(Object.hasOwn(inputs, 'initialCandidates') ? inputs.initialCandidates : [], node.config.maxCandidates);
  const checkpoint = () => { if (context.signal.aborted) throw interruption(context.signal); context.checkpoint(); };
  checkpoint();
  let state = context.store.begin(context.runId, context.nodeId, canonicalDigest({ config: node.config, goal, seeds, verifier: CANDIDATE_VERIFIER }), node.config, CANDIDATE_VERIFIER, seeds);
  if (state.status === 'succeeded') return { data: state.result };
  const finish = (reason: NonNullable<CandidateSearchState['result']>['stopReason'], selectedId: string | null = null): NodeOutput => {
    checkpoint(); state = context.store.complete(context.runId, context.nodeId, state.revision, reason, selectedId); return { data: state.result };
  };
  try {
    while (true) {
      checkpoint();
      // Accepted candidates are checked in a stable BFS order; no generated or unverified value is chosen as a fallback winner.
      const pending = state.candidates.filter(item => !item.verification).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
      for (const item of pending) {
        if (state.verifications >= state.limits.maxVerifications) return finish('max_verifications');
        state = context.store.reserveVerification(context.runId, context.nodeId, state.revision, item.id);
        checkpoint(); const checked = validateJsonValue(goal.acceptanceSchema, item.value);
        if (checked.issues.some(issue => issue.code === 'UNSUPPORTED_SCHEMA_OR_VALUE')) throw new RunnerError('CANDIDATE_VERIFIER_FAILED', '후보 검증을 완료할 수 없습니다.');
        state = context.store.verified(context.runId, context.nodeId, state.revision, item.id, checked.valid);
        if (checked.valid) return finish('accepted', item.id);
        await yieldTurn(); checkpoint();
      }
      const frontier = state.candidates.filter(item => !item.expanded && item.verification?.accepted === false).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
      const parent = frontier.find(item => item.depth < state.limits.maxDepth);
      const initial = state.candidates.length === 0 && state.generations === 0;
      if (!initial && !parent) return finish(frontier.length ? 'max_depth' : 'exhausted');
      if (state.candidates.length >= state.limits.maxCandidates) return finish('max_candidates');
      if (state.verifications >= state.limits.maxVerifications) return finish('max_verifications');
      state = context.store.reserveGeneration(context.runId, context.nodeId, state.revision, parent?.id ?? null);
      const reservation = state.generation!;
      const generated = await context.generate(reservation.key, { goal: structuredClone(goal), parent: parent ? { id: parent.id, value: structuredClone(parent.value), depth: parent.depth } : null, depth: reservation.depth, remaining: { candidates: reservation.slots, verifications: state.limits.maxVerifications - state.verifications } }, context.signal);
      checkpoint();
      if (!validateJsonValue({ type: 'object', properties: { candidates: { type: 'array' } }, required: ['candidates'], additionalProperties: false }, generated.data).valid) throw new RunnerError('CANDIDATE_GENERATION_INVALID', '생성 흐름은 candidates 목록만 가진 객체를 반환해야 합니다.');
      const values = boundedCandidates((generated.data as { candidates: unknown[] }).candidates, reservation.slots, state.candidates.map(item => item.value));
      state = context.store.generated(context.runId, context.nodeId, state.revision, values);
      await yieldTurn();
    }
  } catch (error) {
    const detail = error instanceof ModelError ? { code: error.code, message: error.message } : publicError(error);
    const uncertain = error instanceof ModelError && error.outcome === 'unknown' || ['RAG_RECONCILIATION_REQUIRED', 'AGENTIC_RECONCILIATION_REQUIRED'].includes(detail.code);
    const cancelled = context.signal.aborted && ['RUN_CANCELLED', 'CHILD_CANCELLED'].includes(publicError(interruption(context.signal)).code);
    context.store.stop(context.runId, context.nodeId, uncertain ? 'attention_required' : cancelled ? 'cancelled' : 'failed', detail);
    throw error;
  }
}
