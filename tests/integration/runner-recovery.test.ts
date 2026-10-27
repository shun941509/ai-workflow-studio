import { describe, expect, it } from 'vitest';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** These storage tests use real SQLite transactions, without replacing the state layer. */
describe('Runner durable state invariants', () => {
  function prepare(store: RunStore) {
    store.savePackage({ handle: 'pkg_test', filename: 'pkg_test.zip', sha256: 'a'.repeat(64), name: '검증용 패키지', createdAt: new Date().toISOString() });
    return store.createRun({ requestId: 'request', requestHash: 'hash', packageHandle: 'pkg_test', planHash: 'plan', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['work'], maxModelCalls: 1, maxTotalTokens: 100 });
  }

  it('does not replay interrupted work and preserves its reservation', () => {
    const store = new RunStore(':memory:');
    try {
      const run = prepare(store); store.transitionRun(run.id, 'running'); store.transitionNode(run.id, 'work', 'running'); store.beginAttempt(run.id, 'work');
      store.reserveModel(run.id, 'work', 60);
      expect(store.recoverInterruptedRuns()).toBe(1);
      expect(store.getRun(run.id)).toMatchObject({ status: 'attention_required', usage: { modelCalls: 1, reservedTokens: 60 } });
      expect(store.recoverInterruptedRuns()).toBe(0);
    } finally { store.close(); }
  });

  it('serializes competing usage reservations and rejects a second model call', () => {
    const store = new RunStore(':memory:');
    try { const run = prepare(store); store.reserveModel(run.id, 'work', 60); expect(() => store.reserveModel(run.id, 'work', 20)).toThrow(/한도/); expect(store.getRun(run.id).usage.modelCalls).toBe(1); }
    finally { store.close(); }
  });

  it('does not overwrite a successful result during recovery', () => {
    const store = new RunStore(':memory:');
    try { const run = prepare(store); store.transitionRun(run.id, 'running'); store.transitionRun(run.id, 'succeeded', { result: { data: '완료' } }); expect(store.recoverInterruptedRuns()).toBe(0); expect(store.getRun(run.id).result).toEqual({ data: '완료' }); expect(() => store.transitionRun(run.id, 'running')).toThrow(/완료된/); }
    finally { store.close(); }
  });

  it('recovers interrupted rows after closing and reopening the actual database file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-runner-recovery-test-'));
    let store: RunStore | undefined;
    try {
      const path = join(directory, 'state.sqlite'); store = new RunStore(path);
      const run = prepare(store); store.transitionRun(run.id, 'running'); store.transitionNode(run.id, 'work', 'running'); store.reserveModel(run.id, 'work', 40);
      store.close(); store = new RunStore(path);
      expect(store.recoverInterruptedRuns()).toBe(1);
      expect(store.getRun(run.id)).toMatchObject({ status: 'attention_required', usage: { reservedTokens: 40 } });
      expect(store.listEvents(run.id).at(-1)?.type).toBe('run.recovered');
    } finally {
      store?.close(); const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !absolute.includes('studio-runner-recovery-test-')) throw new Error('unsafe cleanup');
      await rm(absolute, { recursive: true, force: true });
    }
  });

  it('refuses a second daemon lease owned by a live process', () => {
    const store = new RunStore(':memory:');
    try { store.claimDaemon('first', process.pid); expect(() => store.claimDaemon('second', process.pid)).toThrow(/이미/); store.releaseDaemon('unrelated'); expect(() => store.claimDaemon('second', process.pid)).toThrow(); store.releaseDaemon('first'); expect(() => store.claimDaemon('second', process.pid)).not.toThrow(); }
    finally { store.close(); }
  });
});
