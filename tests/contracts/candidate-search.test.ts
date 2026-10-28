import { afterEach, describe, expect, it } from 'vitest';
import { createNode, type WorkflowNode } from '@studio/spec';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { boundedCandidates, CANDIDATE_VERIFIER, executeCandidateSearch, readCandidateGoal, assertCandidateVerifierPin } from '../../apps/runner/src/execution/candidate-search.js';

const stores: RunStore[] = [], directories: string[] = [];
const limits = { maxCandidates: 4, maxDepth: 2, maxVerifications: 4 };
function setup(filename = ':memory:') {
  const store = new RunStore(filename); stores.push(store);
  store.savePackage({ handle: 'fixture', filename: 'unused.zip', sha256: 'a'.repeat(64), name: 'internal ledger', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'root', requestHash: 'root', packageHandle: 'fixture', planHash: 'plan', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['search'], maxModelCalls: 2, maxTotalTokens: 5000 }); store.transitionRun(run.id, 'running');
  return { store, runId: run.id, ledger: store.candidateSearch };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) { const path = resolve(directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-candidate-contract-')) throw new Error('Unsafe cleanup'); rmSync(path, { recursive: true, force: true }); }
});

/** SQLite is real here: only the generator callback is a test boundary, and it observes reservations before returning. */
describe('candidate search contracts and ledger', () => {
  it('enforces the saved verifier pin instead of accepting a matching display name alone', () => {
    const plan = (pin: unknown) => ({ resolved: { verifiedDependencies: { candidateVerifiers: { 'json-schema-v1': pin } } } });
    expect(() => assertCandidateVerifierPin(plan(CANDIDATE_VERIFIER))).not.toThrow();
    for (const pin of [undefined, { id: 'json-schema-v1', version: 1 }, { ...CANDIDATE_VERIFIER, contractHash: '0'.repeat(64) }, { ...CANDIDATE_VERIFIER, version: 2 }]) expect(() => assertCandidateVerifierPin(plan(pin))).toThrowError(/버전/);
  });
  it.each([{}, { task: '', acceptanceSchema: true }, { task: 'x', acceptanceSchema: true, verifierCode: 'run()' }, { task: 'x', acceptanceSchema: { $ref: 'https://private.invalid/schema' } }, { task: 'x', acceptanceSchema: { pattern: 'a+' } }, { task: 'x', acceptanceSchema: null }])('rejects malformed or unsupported goals before generation %#', goal => {
    expect(() => readCandidateGoal(goal)).toThrow();
  });
  it('allows false schemas as intentional rejection, bounds data and preserves JSON null', () => {
    expect(readCandidateGoal({ task: 'reject all', acceptanceSchema: false })).toEqual({ task: 'reject all', acceptanceSchema: false });
    expect(boundedCandidates([null, false, 0], 3)).toEqual([null, false, 0]);
    expect(() => boundedCandidates(['a'.repeat(65536)], 1)).toThrow();
    expect(() => boundedCandidates([1, 2], 1)).toThrow();
    expect(() => boundedCandidates([{ invalid: undefined }], 1)).toThrow();
    expect(() => boundedCandidates(Array(34).fill('a'.repeat(63000)), 40)).toThrow();
  });
  it('atomically admits initial candidates and reserves/settles generation capacity', () => {
    const { ledger, runId } = setup(); let state = ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [1]);
    state = ledger.reserveVerification(runId, 'search', state.revision, state.candidates[0]!.id);
    expect(ledger.get(runId, 'search').verifications).toBe(1);
    state = ledger.verified(runId, 'search', state.revision, state.candidates[0]!.id, false);
    state = ledger.reserveGeneration(runId, 'search', state.revision, state.candidates[0]!.id);
    expect(ledger.get(runId, 'search')).toMatchObject({ generations: 1, reservedCandidates: 3, generation: { depth: 1, slots: 3 } });
    expect(() => ledger.generated(runId, 'search', state.revision, [2, 3, 4, 5])).toThrow();
    expect(ledger.get(runId, 'search').reservedCandidates).toBe(3);
    state = ledger.generated(runId, 'search', state.revision, [2]);
    expect(state.reservedCandidates).toBe(0); expect(state.candidates[1]).toMatchObject({ id: 'candidate_000002', parentId: 'candidate_000001', depth: 1, value: 2 });
  });
  it('serializes independent DB handles with revision checks and never refunds failed reservations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-candidate-contract-')); directories.push(directory); const filename = join(directory, 'state.db');
    const { ledger, runId } = setup(filename); const other = new RunStore(filename); stores.push(other);
    const state = ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [1]);
    const reserved = other.candidateSearch.reserveVerification(runId, 'search', state.revision, state.candidates[0]!.id);
    expect(() => ledger.reserveVerification(runId, 'search', state.revision, state.candidates[0]!.id)).toThrowError(/이미 변경/);
    expect(() => ledger.complete(runId, 'search', reserved.revision, 'exhausted', null)).toThrow();
    ledger.stop(runId, 'search', 'failed', { code: 'TEST_FAILURE', message: 'test only' });
    expect(other.candidateSearch.get(runId, 'search')).toMatchObject({ status: 'failed', verifications: 1 });
    expect(() => ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [1])).toThrowError(/자동 재실행/);
  });
  it('returns only identical completed requests and rejects cross-scope lookups', () => {
    const { ledger, runId } = setup(); let state = ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [true]);
    state = ledger.reserveVerification(runId, 'search', state.revision, state.candidates[0]!.id); state = ledger.verified(runId, 'search', state.revision, state.candidates[0]!.id, true);
    state = ledger.complete(runId, 'search', state.revision, 'accepted', state.candidates[0]!.id);
    expect(ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [true])).toEqual(state);
    expect(() => ledger.begin(runId, 'search', 'changed', limits, CANDIDATE_VERIFIER, [true])).toThrowError(/다른 요청/);
    expect(() => ledger.get('other-run', 'search')).toThrow(); expect(() => ledger.get(runId, 'other/search')).toThrow();
  });
  it('rejects a terminal reason that is not supported by actual counters and frontier', () => {
    const { ledger, runId } = setup(); let state = ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [false]);
    expect(() => ledger.complete(runId, 'search', state.revision, 'max_verifications', null)).toThrow();
    state = ledger.reserveVerification(runId, 'search', state.revision, state.candidates[0]!.id); state = ledger.verified(runId, 'search', state.revision, state.candidates[0]!.id, false);
    for (const reason of ['exhausted', 'max_candidates', 'max_depth'] as const) expect(() => ledger.complete(runId, 'search', state.revision, reason, null)).toThrow();
    expect(ledger.get(runId, 'search').status).toBe('running');
  });
  it('records reservations before invoking a generator and never re-invokes a completed search', async () => {
    const { ledger, runId } = setup(); const search = { ...createNode('candidate_search'), id: 'search' } as Extract<WorkflowNode, { type: 'candidate_search' }>;
    search.config = { mode: 'tree', generatorFlowRef: { kind: 'local', flowId: 'generator' }, verifierId: 'json-schema-v1', ...limits };
    let calls = 0; const context = { runId, nodeId: 'search', store: ledger, signal: new AbortController().signal, checkpoint: () => {}, generate: async (_key: string, input: unknown) => {
      calls++; expect(ledger.get(runId, 'search')).toMatchObject({ generations: 1, reservedCandidates: 4 }); expect(input).toMatchObject({ parent: null, depth: 0, remaining: { candidates: 4, verifications: 4 } }); return { data: { candidates: [7] } };
    } };
    const inputs = { goal: { task: 'number', acceptanceSchema: { type: 'number' } } };
    const first = await executeCandidateSearch(search, inputs, context); const second = await executeCandidateSearch(search, inputs, context);
    expect(first).toEqual(second); expect(calls).toBe(1); expect(ledger.get(runId, 'search').result!.selected!.value).toBe(7);
  });
  it('preserves generated values and pending slots through interrupted run recovery without dispatch', () => {
    const { store, ledger, runId } = setup(); let state = ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, []);
    state = ledger.reserveGeneration(runId, 'search', state.revision, null); store.recoverInterruptedRuns();
    expect(ledger.get(runId, 'search')).toMatchObject({ status: 'attention_required', generations: 1, reservedCandidates: 4, generation: state.generation });
    expect(store.getRun(runId).status).toBe('attention_required'); expect(() => ledger.begin(runId, 'search', 'hash', limits, CANDIDATE_VERIFIER, [])).toThrow();
  });
});
