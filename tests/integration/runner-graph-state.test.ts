import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { executeGuardrail, validateGuardrail } from '../../apps/runner/src/handlers/guardrail.js';

/** Durable branch decisions and protected-rule semantics are tested independently of any external model. */
describe('graph transactions and protection rules', () => {
  function prepare(store: RunStore) {
    store.savePackage({ handle: 'pkg_graph', filename: 'pkg_graph.zip', sha256: 'b'.repeat(64), name: 'graph', createdAt: new Date().toISOString() });
    return store.createRun({ requestId: 'graph', requestHash: 'graph', packageHandle: 'pkg_graph', planHash: 'graph', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['work', 'next'], edges: [{ id: 'edge', from: { nodeId: 'work', port: 'next' }, to: { nodeId: 'next', port: 'in' } }], maxModelCalls: 1, maxTotalTokens: 100 });
  }

  it('rolls back node completion, earlier edge updates and events when a later edge change fails', () => {
    const store = new RunStore(':memory:');
    try {
      const run = prepare(store); store.transitionRun(run.id, 'running'); store.transitionNode(run.id, 'work', 'running'); const before = store.listEvents(run.id);
      expect(() => store.completeGraphStep(run.id, { nodeId: 'work', status: 'succeeded', result: { data: 'done' } }, [{ edgeId: 'edge', state: 'active', outcome: 'succeeded' }, { edgeId: 'missing', state: 'inactive' }], [])).toThrow();
      expect(store.graphState(run.id)).toMatchObject({ nodes: expect.arrayContaining([{ nodeId: 'work', status: 'running', result: null }]), edges: [{ edgeId: 'edge', state: 'pending' }] }); expect(store.listEvents(run.id)).toEqual(before);
    } finally { store.close(); }
  });

  it('preserves decided edges and confirmed predecessor results across database reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-graph-state-test-')); let store: RunStore | undefined;
    try {
      const path = join(directory, 'state.sqlite'); store = new RunStore(path); const run = prepare(store); store.transitionRun(run.id, 'running'); store.transitionNode(run.id, 'work', 'running');
      store.completeGraphStep(run.id, { nodeId: 'work', status: 'succeeded', result: { data: { confirmed: true } } }, [{ edgeId: 'edge', state: 'active', outcome: 'succeeded' }], []); store.close(); store = new RunStore(path);
      expect(store.graphState(run.id)).toMatchObject({ nodes: expect.arrayContaining([{ nodeId: 'work', status: 'succeeded', result: { data: { confirmed: true } } }]), edges: [{ edgeId: 'edge', state: 'active', outcome: 'succeeded' }] });
      expect(store.recoverInterruptedRuns()).toBe(1); expect(store.getRun(run.id).status).toBe('attention_required'); expect(store.graphState(run.id).nodes.find((item) => item.nodeId === 'next')!.status).toBe('pending');
    } finally {
      store?.close(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-graph-state-test-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true });
    }
  });

  it('rejects a future database version before adding current schema tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-graph-state-test-'));
    try {
      const path = join(directory, 'future.sqlite'); const db = new DatabaseSync(path); db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES(99,'future');"); db.close();
      expect(() => new RunStore(path)).toThrow(/더 새로운/); const inspection = new DatabaseSync(path); expect(inspection.prepare("SELECT name FROM sqlite_master WHERE name='edge_instances'").get()).toBeUndefined(); inspection.close();
    } finally { const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-graph-state-test-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); }
  });

  it('counts Unicode code points and array items explicitly for length rules', () => {
    const config: Parameters<typeof executeGuardrail>[1] = { rules: [{ id: 'length', kind: 'length', parameters: { min: 1, max: 1 } }], onViolation: 'block' };
    expect(executeGuardrail('😀', config).data).toBe('😀'); expect(executeGuardrail([null], config).data).toEqual([null]); expect(() => executeGuardrail(1, config)).toThrow(/보호 규칙/);
  });

  it('uses structural JSON allowed values and own-field presence without treating null as missing', () => {
    expect(executeGuardrail({ b: 2, a: 1 }, { rules: [{ id: 'allowed', kind: 'allowed_values', parameters: { values: [{ a: 1, b: 2 }] } }], onViolation: 'block' }).data).toEqual({ a: 1, b: 2 });
    expect(executeGuardrail({ present: null }, { rules: [{ id: 'required', kind: 'required_fields', parameters: { fields: ['present'] } }], onViolation: 'block' }).data).toEqual({ present: null });
    expect(() => executeGuardrail({}, { rules: [{ id: 'required', kind: 'required_fields', parameters: { fields: ['present'] } }], onViolation: 'block' })).toThrow(/보호 규칙/);
  });

  it('rejects unknown protection options and unsafe schemas instead of weakening a rule', () => {
    expect(() => validateGuardrail({ rules: [{ id: 'length', kind: 'length', parameters: { min: 1, ignoreFailure: true } }], onViolation: 'block' })).toThrow(/지원하지 않는/);
    expect(() => validateGuardrail({ rules: [{ id: 'schema', kind: 'schema', parameters: { schema: { $ref: 'https://untrusted.invalid/schema' } } }], onViolation: 'block' })).toThrow(/유효한 JSON Schema/);
  });
});
