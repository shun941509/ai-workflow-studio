import { assertJsonData, type WorkflowNode } from '@studio/spec';
import { assertScope, equal, identifier, immutable, integer, object, requireCondition, validateScope, type AccessScope } from './common.js';
import { validateIndexRef, type IndexRef } from './corpus.js';

type AgentConfig = Extract<WorkflowNode, { type: 'agent' }>['config'];
export type RetrievalPolicy = NonNullable<AgentConfig['retrievalPolicy']>;
export interface AgenticLimits { maxRounds: number; maxQueriesPerRound: number; maxRetrievedChunks: number; maxContextTokens: number; maxSteps: number }
export interface AgenticReservation { operationId: string; kind: 'query' | 'tool'; index?: IndexRef; toolId?: string; maxChunks: number; maxContextTokens: number }
export interface AgenticOperation { request: AgenticReservation; round: number; status: 'reserved' | 'unknown' | 'settled'; actualChunks?: number; actualContextTokens?: number }
export interface AgenticSession { id: string; revision: number; scope: AccessScope; limits: AgenticLimits; allowedIndexes: IndexRef[]; allowedTools: string[]; phase: 'running' | 'waiting_clarification' | 'completed'; round: number; operations: AgenticOperation[] }
export interface AgenticUsage { rounds: number; steps: number; queries: number; queriesThisRound: number; retrievedChunks: number; contextTokens: number }

function validateLimits(limits: AgenticLimits): void {
  object(limits, ['maxRounds', 'maxQueriesPerRound', 'maxRetrievedChunks', 'maxContextTokens', 'maxSteps']);
  integer(limits.maxRounds, 1, 20); integer(limits.maxQueriesPerRound, 1, 20); integer(limits.maxRetrievedChunks, 1, 1000); integer(limits.maxContextTokens, 1, 200000); integer(limits.maxSteps, 1, 100);
}

/** The persisted session, not model context or a clarification turn, owns the cumulative budget. */
export function createAgenticSession(input: { id: string; scope: AccessScope; limits: AgenticLimits; allowedIndexes: IndexRef[]; allowedTools: string[] }): Readonly<AgenticSession> {
  assertJsonData(input); object(input, ['id', 'scope', 'limits', 'allowedIndexes', 'allowedTools']); identifier(input.id); validateScope(input.scope); validateLimits(input.limits);
  requireCondition(Array.isArray(input.allowedIndexes) && input.allowedIndexes.length > 0 && input.allowedIndexes.length <= 20 && Array.isArray(input.allowedTools) && input.allowedTools.length <= 100, 'AGENT_ALLOWLIST', 'Agent requires bounded explicit index/tool allowlists');
  const ids = new Set<string>();
  for (const ref of input.allowedIndexes) { validateIndexRef(ref); assertScope(ref.scope, input.scope); requireCondition(!ids.has(ref.indexId), 'AGENT_ALLOWLIST', 'Only one pinned generation of each index is allowed'); ids.add(ref.indexId); }
  for (const tool of input.allowedTools) identifier(tool);
  requireCondition(new Set(input.allowedTools).size === input.allowedTools.length, 'AGENT_ALLOWLIST', 'Duplicate allowed tool');
  return immutable({ ...input, revision: 1, phase: 'running', round: 0, operations: [] });
}

function validateRequest(request: AgenticReservation, session: AgenticSession): void {
  object(request, ['operationId', 'kind', 'index', 'toolId', 'maxChunks', 'maxContextTokens']); identifier(request.operationId);
  integer(request.maxChunks, 0, session.limits.maxRetrievedChunks); integer(request.maxContextTokens, 0, session.limits.maxContextTokens);
  if (request.kind === 'query') {
    requireCondition(request.index && request.toolId === undefined && request.maxChunks > 0, 'QUERY_RESERVATION', 'Query requires a pinned index and positive chunk bound');
    validateIndexRef(request.index); assertScope(request.index.scope, session.scope);
    requireCondition(session.allowedIndexes.some(index => equal(index, request.index)), 'INDEX_NOT_ALLOWED', 'Agent cannot search an unlisted generation');
  } else {
    requireCondition(request.kind === 'tool' && request.index === undefined && typeof request.toolId === 'string' && session.allowedTools.includes(request.toolId), 'TOOL_NOT_ALLOWED', 'Agent cannot call an unlisted tool');
  }
}

/** Unknown external outcomes retain the full reservation; callers must reconcile, never auto-refund. */
function calculateUsage(session: AgenticSession): AgenticUsage {
  const usage = { rounds: session.round, steps: session.operations.length, queries: 0, queriesThisRound: 0, retrievedChunks: 0, contextTokens: 0 };
  for (const operation of session.operations) {
    if (operation.request.kind === 'query') { usage.queries++; if (operation.round === session.round) usage.queriesThisRound++; }
    usage.retrievedChunks += operation.status === 'settled' ? operation.actualChunks! : operation.request.maxChunks;
    usage.contextTokens += operation.status === 'settled' ? operation.actualContextTokens! : operation.request.maxContextTokens;
  }
  return immutable(usage);
}

function validateSession(session: AgenticSession): void {
  assertJsonData(session); object(session, ['id', 'revision', 'scope', 'limits', 'allowedIndexes', 'allowedTools', 'phase', 'round', 'operations']);
  createAgenticSession({ id: session.id, scope: session.scope, limits: session.limits, allowedIndexes: session.allowedIndexes, allowedTools: session.allowedTools });
  integer(session.revision, 1, Number.MAX_SAFE_INTEGER); integer(session.round, 0, session.limits.maxRounds);
  requireCondition(['running', 'waiting_clarification', 'completed'].includes(session.phase) && Array.isArray(session.operations) && session.operations.length <= session.limits.maxSteps, 'AGENT_STATE', 'Invalid agent phase or operation ledger');
  const ids = new Set<string>(); const roundQueries = new Map<number, number>();
  for (const operation of session.operations) {
    object(operation, ['request', 'round', 'status', 'actualChunks', 'actualContextTokens']); validateRequest(operation.request, session); integer(operation.round, operation.request.kind === 'query' ? 1 : 0, session.round);
    requireCondition(!ids.has(operation.request.operationId) && ['reserved', 'unknown', 'settled'].includes(operation.status), 'AGENT_STATE', 'Duplicate operation or invalid status'); ids.add(operation.request.operationId);
    if (operation.status === 'settled') { integer(operation.actualChunks, 0, operation.request.maxChunks); integer(operation.actualContextTokens, 0, operation.request.maxContextTokens); }
    else requireCondition(operation.actualChunks === undefined && operation.actualContextTokens === undefined, 'AGENT_STATE', 'Unsettled operation cannot contain confirmed usage');
    if (operation.request.kind === 'query') roundQueries.set(operation.round, (roundQueries.get(operation.round) ?? 0) + 1);
  }
  const usage = calculateUsage(session);
  requireCondition([...roundQueries.values()].every(count => count <= session.limits.maxQueriesPerRound) && usage.retrievedChunks <= session.limits.maxRetrievedChunks && usage.contextTokens <= session.limits.maxContextTokens, 'AGENT_BUDGET_EXCEEDED', 'Persisted agent usage exceeds limits');
}

/** Usage is derived from a validated ledger, never accepted as a caller-supplied aggregate counter. */
export function agenticUsage(session: AgenticSession): AgenticUsage { validateSession(session); return calculateUsage(session); }

function running(session: AgenticSession): void { validateSession(session); requireCondition(session.phase === 'running', 'AGENT_NOT_RUNNING', 'Agent is waiting or completed'); }
function updated(session: AgenticSession, change: Partial<AgenticSession>): Readonly<AgenticSession> { const next = { ...session, ...change, revision: session.revision + 1 }; validateSession(next); return immutable(next); }

/** Persist each returned revision using compare-and-swap; parallel callers cannot commit the same previous revision twice. */
export function beginAgenticRound(session: AgenticSession): Readonly<AgenticSession> {
  running(session); requireCondition(session.round < session.limits.maxRounds, 'AGENT_ROUND_LIMIT', 'Retrieval round budget is exhausted');
  return updated(session, { round: session.round + 1 });
}

export function reserveAgenticOperation(session: AgenticSession, request: AgenticReservation): Readonly<AgenticSession> {
  running(session); assertJsonData(request); validateRequest(request, session);
  const existing = session.operations.find(operation => operation.request.operationId === request.operationId);
  if (existing) { requireCondition(equal(existing.request, request), 'OPERATION_ID_CONFLICT', 'Same operation ID has different reservation details'); return immutable(session); }
  requireCondition(request.kind !== 'query' || session.round > 0, 'ROUND_REQUIRED', 'Begin a retrieval round before issuing a query');
  const usage = calculateUsage(session);
  requireCondition(usage.steps < session.limits.maxSteps && (request.kind !== 'query' || usage.queriesThisRound < session.limits.maxQueriesPerRound) && usage.retrievedChunks + request.maxChunks <= session.limits.maxRetrievedChunks && usage.contextTokens + request.maxContextTokens <= session.limits.maxContextTokens, 'AGENT_BUDGET_EXCEEDED', 'Reserve query/chunk/token/step budget before an external call');
  return updated(session, { operations: [...session.operations, { request, round: session.round, status: 'reserved' }] });
}

export function settleAgenticOperation(session: AgenticSession, operationId: string, result: { status: 'unknown' } | { status: 'confirmed'; actualChunks: number; actualContextTokens: number }): Readonly<AgenticSession> {
  validateSession(session); assertJsonData(result); identifier(operationId);
  requireCondition(session.phase !== 'completed', 'AGENT_COMPLETED', 'Completed session cannot change usage');
  const found = session.operations.find(operation => operation.request.operationId === operationId); requireCondition(found, 'UNKNOWN_OPERATION', 'No matching budget reservation');
  if (result.status === 'unknown') {
    object(result, ['status']); requireCondition(found.status !== 'settled', 'SETTLEMENT_CONFLICT', 'Confirmed usage cannot become unknown');
    if (found.status === 'unknown') return immutable(session);
    return updated(session, { operations: session.operations.map(operation => operation === found ? { ...operation, status: 'unknown' } : operation) });
  }
  object(result, ['status', 'actualChunks', 'actualContextTokens']); requireCondition(result.status === 'confirmed', 'INVALID_SETTLEMENT', 'Unknown settlement status');
  integer(result.actualChunks, 0, found.request.maxChunks); integer(result.actualContextTokens, 0, found.request.maxContextTokens);
  if (found.status === 'settled') { requireCondition(found.actualChunks === result.actualChunks && found.actualContextTokens === result.actualContextTokens, 'SETTLEMENT_CONFLICT', 'Settled operation cannot be changed'); return immutable(session); }
  return updated(session, { operations: session.operations.map(operation => operation === found ? { ...operation, status: 'settled', actualChunks: result.actualChunks, actualContextTokens: result.actualContextTokens } : operation) });
}

export function pauseForClarification(session: AgenticSession): Readonly<AgenticSession> { running(session); return updated(session, { phase: 'waiting_clarification' }); }
export function resumeAfterClarification(session: AgenticSession): Readonly<AgenticSession> { validateSession(session); requireCondition(session.phase === 'waiting_clarification', 'AGENT_NOT_WAITING', 'No clarification is pending'); return updated(session, { phase: 'running' }); }
export function completeAgenticSession(session: AgenticSession): Readonly<AgenticSession> { running(session); requireCondition(session.operations.every(operation => operation.status === 'settled'), 'UNRESOLVED_OPERATION', 'Unknown or reserved operations require reconciliation'); return updated(session, { phase: 'completed' }); }
