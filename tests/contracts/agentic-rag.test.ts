import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '@studio/package-kit';
import { createAgenticSession, reserveAgenticOperation, settleAgenticOperation, beginAgenticRound, completeAgenticSession, agenticUsage, type IndexRef } from '@studio/rag-core';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { AGENTIC_CONTRACT, assertAgenticProfile, decodeAgenticDecision, prepareAgenticDecision } from '../../apps/runner/src/agentic/contracts.js';

const closed: (() => void)[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-agentic-state-')); const filename = join(directory, 'state.sqlite'); const store = new RunStore(filename);
  store.savePackage({ handle: 'p', filename: 'p.zip', sha256: '0'.repeat(64), name: 'internal', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'request', requestHash: 'request', packageHandle: 'p', planHash: 'plan', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['agent'], maxModelCalls: 4, maxTotalTokens: 5000 }); store.transitionRun(run.id, 'running');
  const scope = { tenantId: 'installation', projectId: run.id }; const index: IndexRef = { scope, indexId: 'index', generationId: 'generation', manifestHash: '0'.repeat(64), formatVersion: '1.0.0' };
  const session = createAgenticSession({ id: 'session', scope, limits: { maxRounds: 2, maxQueriesPerRound: 2, maxRetrievedChunks: 10, maxContextTokens: 100, maxSteps: 3 }, allowedIndexes: [index], allowedTools: [] });
  closed.push(() => { store.close(); if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); }); return { store, run, index, session, filename };
}
afterEach(() => { for (const close of closed.splice(0)) close(); });
const model = (operationId: string) => ({ operationId, kind: 'model' as const, maxChunks: 0, maxContextTokens: 0 });

describe('Agentic model steps and durable no-replay journal', () => {
  it('model decisions and searches share maxSteps without pretending that models are tools', () => {
    const item = fixture(); let state = reserveAgenticOperation(item.session, model('plan')); state = settleAgenticOperation(state, 'plan', { status: 'confirmed', actualChunks: 0, actualContextTokens: 0 }); state = beginAgenticRound(state);
    state = reserveAgenticOperation(state, { operationId: 'search', kind: 'query', index: item.index, maxChunks: 4, maxContextTokens: 60 }); state = settleAgenticOperation(state, 'search', { status: 'confirmed', actualChunks: 2, actualContextTokens: 30 }); state = reserveAgenticOperation(state, model('answer'));
    expect(agenticUsage(state)).toMatchObject({ steps: 3, queries: 1, retrievedChunks: 2, contextTokens: 30 }); expect(() => reserveAgenticOperation(state, model('extra'))).toThrow(expect.objectContaining({ code: 'AGENT_BUDGET_EXCEEDED' }));
  });
  it.each([{ index: true }, { tool: true }, { tokens: true }])('model reservation cannot acquire a hidden authority or retrieval allowance %j', option => {
    const item = fixture(); expect(() => reserveAgenticOperation(item.session, { ...model('plan'), ...(option.index ? { index: item.index } : {}), ...(option.tool ? { toolId: 'hidden' } : {}), ...(option.tokens ? { maxContextTokens: 1 } : {}) })).toThrow(expect.objectContaining({ code: 'MODEL_RESERVATION' }));
  });
  it('reserves atomically, rejects stale CAS and operation replay, and keeps metadata logs private', () => {
    const item = fixture(); let state = item.store.agentic.begin(item.run.id, 'agent', 'request-hash', item.session); const old = state.revision;
    state = item.store.agentic.reserve(item.run.id, 'agent', old, model('plan'), canonicalDigest('private task')); expect(() => item.store.agentic.reserve(item.run.id, 'agent', old, model('other'), 'hash')).toThrow(expect.objectContaining({ code: 'AGENTIC_STATE_CONFLICT' }));
    expect(item.store.agentic.get(item.run.id, 'agent').records).toHaveLength(1); state = item.store.agentic.settle(item.run.id, 'agent', state.revision, 'plan', 0, 0, 'response-hash');
    expect(() => item.store.agentic.reserve(item.run.id, 'agent', state.revision, model('plan'), 'same')).toThrow(expect.objectContaining({ code: 'AGENTIC_REPLAY_FORBIDDEN' })); expect(() => item.store.agentic.begin(item.run.id, 'agent', 'request-hash', item.session)).toThrow(expect.objectContaining({ code: 'AGENTIC_REPLAY_FORBIDDEN' })); expect(JSON.stringify(item.store.listEvents(item.run.id))).not.toContain('private task');
  });
  it('rejects changed requests, foreign scopes and unlisted generations', () => {
    const item = fixture(); item.store.agentic.begin(item.run.id, 'agent', 'original', item.session); expect(() => item.store.agentic.begin(item.run.id, 'agent', 'changed', item.session)).toThrow(expect.objectContaining({ code: 'AGENTIC_REQUEST_CONFLICT' }));
    expect(() => createAgenticSession({ id: 'new', scope: item.session.scope, limits: item.session.limits, allowedTools: [], allowedIndexes: [{ ...item.index, scope: { ...item.index.scope, projectId: 'other' } }] })).toThrow(expect.objectContaining({ code: 'SCOPE_MISMATCH' }));
    expect(() => reserveAgenticOperation(beginAgenticRound(item.session), { operationId: 'q', kind: 'query', index: { ...item.index, generationId: 'later' }, maxChunks: 1, maxContextTokens: 20 })).toThrow(expect.objectContaining({ code: 'INDEX_NOT_ALLOWED' }));
  });
  it('startup preserves an unfinished operation as unknown and never resets its cumulative reservation', () => {
    const item = fixture(); let state = item.store.agentic.begin(item.run.id, 'agent', 'hash', item.session); state = item.store.agentic.round(item.run.id, 'agent', state.revision); item.store.agentic.reserve(item.run.id, 'agent', state.revision, { operationId: 'q', kind: 'query', index: item.index, maxChunks: 4, maxContextTokens: 60 }, 'query-hash');
    const other = new RunStore(item.filename); try { expect(other.recoverInterruptedRuns()).toBe(1); const recovered = other.agentic.get(item.run.id, 'agent'); expect(recovered.status).toBe('attention_required'); expect(recovered.session.operations[0]!.status).toBe('unknown'); expect(agenticUsage(recovered.session)).toMatchObject({ steps: 1, queries: 1, retrievedChunks: 4, contextTokens: 60 }); expect(() => completeAgenticSession(recovered.session)).toThrow(expect.objectContaining({ code: 'UNRESOLVED_OPERATION' })); expect(other.recoverInterruptedRuns()).toBe(0); } finally { other.close(); }
  });
  it.each(['hash', 'version', 'json'])('tampered persisted %s fails closed', mode => {
    const item = fixture(); item.store.agentic.begin(item.run.id, 'agent', 'hash', item.session); const db = new DatabaseSync(item.filename); const row = db.prepare('SELECT body FROM agentic_sessions').get()!; const body = JSON.parse(String(row.body)); if (mode === 'version') body.version = 2;
    db.prepare('UPDATE agentic_sessions SET body=?,body_hash=?').run(mode === 'json' ? '{' : JSON.stringify(body), mode === 'version' ? canonicalDigest(body) : 'bad'); db.close(); expect(() => item.store.agentic.get(item.run.id, 'agent')).toThrow(expect.objectContaining({ code: 'AGENTIC_STATE_INVALID' }));
  });
  it('accepts only the fixed explicit chat profile and bounds the serialized prompt before any count', () => {
    expect(() => assertAgenticProfile({ id: 'p', name: 'p', provider: 'openai', model: AGENTIC_CONTRACT.model, credentialRef: 'c', kind: 'reranker' })).toThrow();
    expect(() => prepareAgenticDecision({ task: 'x'.repeat(140000), context: null, instructions: '', indexes: ['i1'], evidence: [], remaining: {}, resultSchema: true })).toThrow(expect.objectContaining({ code: 'AGENTIC_INPUT_LIMIT' }));
  });
  it('an answer without observed evidence and malformed JSON are rejected instead of becoming abstention', () => {
    const prepared = prepareAgenticDecision({ task: 'task', context: null, instructions: '', indexes: ['i1'], evidence: [], remaining: {}, resultSchema: { type: 'string' } });
    for (const text of ['{', JSON.stringify({ action: 'answer', queries: [], resultJson: '"guess"', evidenceIds: [] }), JSON.stringify({ action: 'search', queries: [{ index: 'other', query: 'x' }], resultJson: '', evidenceIds: [] })]) expect(() => decodeAgenticDecision({ model: AGENTIC_CONTRACT.model, text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, prepared)).toThrow();
  });
});
