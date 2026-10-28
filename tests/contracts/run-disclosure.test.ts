import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunDisclosureGate, assertBrokerDisclosure, disclosureSnapshot, type DisclosureSnapshot } from '../../apps/runner/src/provenance/run-disclosure.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';
import { ModelBroker } from '../../apps/runner/src/providers/model-broker.js';
import { EmbeddingBroker } from '../../apps/runner/src/providers/embedding-broker.js';
import { EMBEDDING_CONTRACT } from '../../apps/runner/src/providers/embedding-contract.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const cleanup: (() => void)[] = [];
function fixture(persistent = false, rag = true) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'studio-disclosure-contract-')) : undefined;
  const filename = directory ? join(directory, 'state.sqlite') : ':memory:'; const store = new RunStore(filename);
  store.savePackage({ handle: 'package', filename: 'package.zip', sha256: '0'.repeat(64), name: 'test', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'request', requestHash: 'request', packageHandle: 'package', planHash: 'plan', plan: { workflow: { nodes: [{ type: rag ? 'retrieval' : 'input' }] } }, inputs: {}, modelBindings: {}, nodeIds: ['node'], maxModelCalls: 4, maxTotalTokens: 5000 });
  const snapshot = (): DisclosureSnapshot => disclosureSnapshot({ scope: { tenantId: 'installation', projectId: run.id }, subjectId: 'reader', groupIds: ['team'], epoch: 3, documents: [{ documentId: 'file', revision: 1, tombstoned: false, allowedSubjects: [], allowedGroups: ['team'] }] });
  cleanup.push(() => { store.close(); if (directory) { if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); } });
  return { store, run, snapshot, filename };
}
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe('root-run durable disclosure contract', () => {
  it('seals exactly once and refuses automatic replacement', () => {
    const { store, run, snapshot } = fixture(); let current = snapshot(); const gate = new RunDisclosureGate(store, () => current);
    expect(store.getDisclosureState(run.id)).toEqual({ state: 'unobserved' }); gate.pin(run.id, current); gate.pin(run.id, current);
    expect(store.listEvents(run.id).filter(event => event.type === 'rag.disclosure_pinned')).toHaveLength(1);
    current = { ...current, epoch: 4 }; expect(() => gate.assert(run.id)).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_CHANGED' }));
    current = snapshot(); expect(gate.status(run.id)).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_CHANGED' }); expect(() => gate.pin(run.id, current)).toThrow();
  });
  it.each(['subject', 'group', 'document', 'scope'] as const)('rejects %s changes even with a reused epoch', change => {
    const { store, run, snapshot } = fixture(); const initial = snapshot(); let current = initial; const gate = new RunDisclosureGate(store, () => current); gate.pin(run.id, initial);
    current = change === 'subject' ? { ...initial, subjectId: 'spoof' } : change === 'scope' ? { ...initial, scope: { ...initial.scope, tenantId: 'other' } } : { ...initial, aclHash: change === 'group' ? '1'.repeat(64) : '2'.repeat(64) };
    expect(gate.status(run.id)).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_CHANGED' });
  });
  it('retains the pin across reopening, and denies a missing authority without constructing a new one', () => {
    const { store, run, snapshot, filename } = fixture(true); store.pinDisclosure(run.id, snapshot());
    const reopened = new RunStore(filename); try { const gate = new RunDisclosureGate(reopened, () => { throw new Error('missing authority'); }); expect(gate.status(run.id)).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_UNAVAILABLE' }); expect(store.getDisclosureState(run.id).state).toBe('blocked'); } finally { reopened.close(); }
  });
  it.each(['{', 'null', '{"authority":"wrong"}'])('corrupt pinned state %s becomes a sticky safe denial', corrupt => {
    const { store, run, snapshot, filename } = fixture(true); store.pinDisclosure(run.id, snapshot()); const db = new DatabaseSync(filename); db.prepare('UPDATE run_disclosure SET snapshot=? WHERE run_id=?').run(corrupt, run.id); db.close();
    const gate = new RunDisclosureGate(store, snapshot); expect(gate.status(run.id)).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_UNAVAILABLE' }); expect(store.getDisclosureState(run.id).state).toBe('blocked');
  });
  it.each([true, false])('migration never backfills old runs: RAG=%s', rag => {
    const { store, run, snapshot, filename } = fixture(true, rag); const db = new DatabaseSync(filename); db.prepare('DELETE FROM run_disclosure WHERE run_id=?').run(run.id); db.exec('DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES(10,\'legacy\')'); db.close();
    const reopened = new RunStore(filename); try { expect(reopened.getDisclosureState(run.id).state).toBe('legacy'); const gate = new RunDisclosureGate(reopened, snapshot); expect(gate.status(run.id).allowed).toBe(!rag); if (rag) expect(reopened.getDisclosureState(run.id)).toMatchObject({ state: 'blocked', code: 'RAG_DISCLOSURE_STATE_REQUIRED' }); } finally { reopened.close(); }
  });
  it('a broker without its trusted gate cannot bypass a sealed run', () => { const { store, run, snapshot } = fixture(); store.pinDisclosure(run.id, snapshot()); expect(() => assertBrokerDisclosure(store, run.id)).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_UNAVAILABLE' })); });
  it('a count begun before first observation rechecks the newly pinned epoch before generation', async () => {
    const { store, run, snapshot } = fixture(); let current = snapshot(), generated = 0; const gate = new RunDisclosureGate(store, () => current);
    const credentials: CredentialStore = { available: true, async get() { return 'test-only'; }, async has() { return true; }, async set() {}, async delete() {} };
    const broker = new ModelBroker(store, credentials, { async countInputTokens() { expect(store.getDisclosureState(run.id).state).toBe('unobserved'); gate.pin(run.id, current); current = { ...current, epoch: current.epoch + 1 }; return 2; }, async generate() { generated++; throw new Error('must not dispatch'); } }, id => gate.assert(id));
    await expect(broker.invoke(run.id, 'node', { id: 'profile', name: 'test', provider: 'openai', model: 'test', credentialRef: 'test' }, { instructions: '', content: 'unrelated literal', maxOutputTokens: 100, responseFormat: { mode: 'text' } }, new AbortController().signal)).rejects.toMatchObject({ code: 'RAG_DISCLOSURE_CHANGED' });
    expect(generated).toBe(0); expect(store.getRun(run.id).usage).toMatchObject({ consumedTokens: 0, reservedTokens: 0 });
  });
  it('embedding credential await cannot bypass the current run fence or consume a reservation', async () => {
    const { store, run, snapshot } = fixture(); let current = snapshot(), sent = 0; const gate = new RunDisclosureGate(store, () => current); gate.pin(run.id, current);
    const credentials: CredentialStore = { available: true, async get() { current = { ...current, epoch: current.epoch + 1 }; return 'test-only'; }, async has() { return true; }, async set() {}, async delete() {} };
    const broker = new EmbeddingBroker(store, credentials, { async embed() { sent++; throw new Error('must not dispatch'); } }, id => gate.assert(id));
    await expect(broker.invoke(run.id, 'node', { id: 'profile', name: 'test', provider: 'openai', kind: 'embedding', model: EMBEDDING_CONTRACT.model, credentialRef: 'test' }, ['private'], new AbortController().signal)).rejects.toMatchObject({ code: 'RAG_DISCLOSURE_CHANGED' });
    expect(sent).toBe(0); expect(store.getRun(run.id).usage).toMatchObject({ modelCalls: 0, consumedTokens: 0, reservedTokens: 0 });
  });
  it('registration is no-op for existing documents and never resurrects tombstones or removed membership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-disclosure-contract-')); const db = new SqliteRagStore(join(directory, 'rag.sqlite')); const scope = { tenantId: 'tenant', projectId: 'project' };
    try {
      db.createScope(scope); db.replaceAccess(scope, { expectedEpoch: 1, subjects: [{ subjectId: 'reader', groupIds: [] }], documents: [{ documentId: 'file', revision: 2, tombstoned: true, allowedSubjects: [], allowedGroups: ['former'] }] });
      const initial = db.readCurrent(scope, 'reader'); db.registerManagedDocuments(scope, 'reader', ['file'], true); expect(db.readCurrent(scope, 'reader')).toEqual(initial);
      expect(() => db.registerManagedDocuments(scope, 'reader', ['new'], false)).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_SEALED' })); expect(db.readCurrent(scope, 'reader')).toEqual(initial);
      expect(() => db.registerManagedDocuments(scope, 'revoked', ['new'], true)).toThrow(expect.objectContaining({ code: 'RAG_ACCESS_REVOKED' }));
      db.registerManagedDocuments(scope, 'reader', ['new'], true); const changed = db.readCurrent(scope, 'reader'); expect(changed.documents.find(doc => doc.documentId === 'file')).toEqual(initial.documents[0]); expect(changed.epoch).toBe(initial.epoch + 1);
    } finally { db.close(); if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); }
  });
});
