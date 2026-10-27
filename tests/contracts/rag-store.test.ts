import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, linkSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildLocalSearchIndex, createCorpusGeneration, embeddingFingerprint, type AccessScope, type DocumentAccess, type DocumentInput, type EmbeddingProfile } from '@studio/rag-core';
import { SqliteRagStore, type StagedGeneration } from '../../apps/runner/src/rag/index.js';

const scope = { tenantId: 'tenant', projectId: 'project' };
const principal = { scope, subjectId: 'alice' };
const controller = () => new AbortController().signal;
const utf8 = (text: string) => new TextEncoder().encode(text);
const directories: string[] = [];
const stores: SqliteRagStore[] = [];
const profile: EmbeddingProfile = { providerId: 'internal-test', modelId: 'explicit-vectors', modelRevision: 'test-v1', dimensions: 2, distance: 'cosine', normalization: 'l2', tokenizerRevision: 'test-v1', preprocessingRevision: 'identity-v1', parameters: {} };

/** All files are newly created test data; recursive cleanup checks their resolved parent/prefix before removing them. */
function database(): string { const path = mkdtempSync(join(tmpdir(), 'studio-rag-store-')); directories.push(path); return join(path, 'rag.sqlite'); }
function open(filename = database(), limits: ConstructorParameters<typeof SqliteRagStore>[1] = {}) { const store = new SqliteRagStore(filename, limits); stores.push(store); return store; }
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) { const target = resolve(path); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('studio-rag-store-')) throw new Error('Unsafe test cleanup path'); rmSync(target, { recursive: true, force: true }); }
});

/** Explicit vectors test persistence/arithmetic, not a real embedding provider or official example. */
async function fixture(options: { generation?: string; corpusGeneration?: string; scope?: AccessScope; texts?: string[]; kind?: 'keyword' | 'hybrid'; revision?: number } = {}): Promise<StagedGeneration> {
  const targetScope = options.scope ?? scope; const texts = options.texts ?? ['서울 alpha alpha beta', '부산 beta gamma', '비공개 private alpha'];
  const documents: DocumentInput[] = texts.map((text, index) => ({ documentId: `d${index}`, revision: options.revision ?? 1, sourceUri: `urn:test:d${index}`, originalBytes: utf8(`원본: ${text}`), extractedText: text, extraction: { id: 'text', version: '1', options: {} } }));
  const corpus = await createCorpusGeneration({ scope: targetScope, corpusId: 'corpus', generationId: options.corpusGeneration ?? 'c1', documents, chunks: documents.map((document, index) => ({ chunkId: `chunk${index}`, documentId: document.documentId, start: 0, end: utf8(document.extractedText).byteLength })) });
  const bundle = await buildLocalSearchIndex({ corpus, indexId: 'index', generationId: options.generation ?? 'g1', kind: options.kind ?? 'keyword', ...(options.kind === 'hybrid' ? { embeddingProfile: profile, embeddings: documents.map((_, index) => ({ chunkId: `chunk${index}`, vector: index === 0 ? [1, 0] : index === 1 ? [0, 1] : [-1, 0] })) } : {}) });
  return { ...bundle, documents };
}
function records(bundle: StagedGeneration): DocumentAccess[] { return bundle.corpus.documents.map((document, index) => ({ documentId: document.documentId, revision: document.revision, tombstoned: false, allowedSubjects: [], allowedGroups: index < 2 ? ['team'] : ['private'] })); }
function grant(store: SqliteRagStore, bundle: StagedGeneration, expectedEpoch = 1) { return store.replaceAccess(bundle.corpus.ref.scope, { expectedEpoch, subjects: [{ subjectId: 'alice', groupIds: ['team'] }], documents: records(bundle) }); }
const query = { query: 'alpha', channel: 'keyword' as const, limit: 10 };

describe('durable local RAG generations', () => {
  it('stages actual bytes, denies without ACL, activates atomically and searches after a fresh reopen', async () => {
    const filename = database(); const first = open(filename); first.createScope(scope); const bundle = await fixture();
    const ref = await first.stageGeneration(bundle);
    expect(first.getActiveIndex(scope, 'index')).toBeNull();
    expect((await first.search(principal, ref, query, controller())).candidates).toEqual([]);
    await expect(first.searchActive(principal, 'index', query, controller())).rejects.toMatchObject({ code: 'RAG_INDEX_NOT_ACTIVE' });
    grant(first, bundle); const activated = await first.activate(scope, ref, null); first.close();
    const restarted = open(filename);
    expect(restarted.getActiveIndex(scope, 'index')).toEqual(activated);
    const loaded = await restarted.loadGeneration(scope, ref);
    expect(loaded.artifacts[0]!.bytes).toEqual(bundle.artifacts[0]!.bytes);
    expect(loaded.corpus.chunks[0]!.ref.location).toEqual({ encoding: 'utf8', start: 0, end: utf8(bundle.documents[0]!.extractedText).byteLength });
    const result = await restarted.searchActive(principal, 'index', query, controller());
    expect(result.candidates.map(candidate => candidate.chunk.document.documentId)).toEqual(['d0']);
    expect((await restarted.searchActive(principal, 'index', { ...query, query: 'private' }, controller())).candidates).toEqual([]);
  });

  it('owns staging and loading bytes without sharing mutable buffers with a caller', async () => {
    const store = open(); store.createScope(scope); const original = await fixture(); const copy = structuredClone(original);
    const pending = store.stageGeneration(copy); copy.documents[0]!.originalBytes.fill(0); copy.artifacts[0]!.bytes.fill(0);
    const ref = await pending; const loaded = await store.loadGeneration(scope, ref); loaded.artifacts[0]!.bytes.fill(0); loaded.corpus.chunks[0]!.text = 'changed';
    const again = await store.loadGeneration(scope, ref);
    expect(again.artifacts[0]!.bytes).toEqual(original.artifacts[0]!.bytes); expect(again.corpus.chunks[0]!.text).toBe(original.corpus.chunks[0]!.text);
  });

  it('rejects original/extraction mismatch before writing any incomplete generation', async () => {
    const store = open(); store.createScope(scope); const bundle = await fixture(); bundle.documents[0]!.originalBytes[0] = 0;
    await expect(store.stageGeneration(bundle)).rejects.toMatchObject({ code: 'RAG_SOURCE_MISMATCH' });
    expect(store.statistics()).toEqual({ generations: 0, corpora: 0, bytes: 0 });
  });

  it('rejects generation ID reuse and conflicting document revisions across corpus generations', async () => {
    const store = open(); store.createScope(scope); const first = await fixture(); await store.stageGeneration(first);
    await expect(store.stageGeneration(first)).rejects.toMatchObject({ code: 'RAG_GENERATION_EXISTS' });
    const changed = await fixture({ generation: 'g2', corpusGeneration: 'c2', texts: ['changed alpha', '부산 beta gamma', '비공개 private alpha'] });
    await expect(store.stageGeneration(changed)).rejects.toMatchObject({ code: 'RAG_DOCUMENT_REVISION_REUSED' });
    expect(store.statistics()).toMatchObject({ generations: 1, corpora: 1 });
    const changedCorpusId = await fixture({ generation: 'g2', texts: ['changed alpha', '부산 beta gamma', '비공개 private alpha'] });
    await expect(store.stageGeneration(changedCorpusId)).rejects.toMatchObject({ code: 'RAG_CORPUS_GENERATION_EXISTS' });
  });

  it('serializes two activation CAS attempts on separate database connections', async () => {
    const filename = database(); const first = open(filename); first.createScope(scope); const g1 = await fixture(); const g2 = await fixture({ generation: 'g2' });
    await first.stageGeneration(g1); await first.stageGeneration(g2); const second = open(filename);
    const attempts = await Promise.allSettled([first.activate(scope, g1.index.ref, null), second.activate(scope, g2.index.ref, null)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(attempt => attempt.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'RAG_ACTIVATION_CONFLICT' } });
    const active = first.getActiveIndex(scope, 'index')!; expect(second.getActiveIndex(scope, 'index')).toEqual(active);
    await first.loadGeneration(scope, active.ref);
  });

  it('rejects stale CAS even after an explicit rollback returns to the same manifest hash', async () => {
    const store = open(); store.createScope(scope); const first = await fixture(); const second = await fixture({ generation: 'g2' }); const third = await fixture({ generation: 'g3' });
    for (const bundle of [first, second, third]) await store.stageGeneration(bundle);
    const a = await store.activate(scope, first.index.ref, null); const b = await store.activate(scope, second.index.ref, a); const restored = await store.activate(scope, first.index.ref, b);
    expect(restored.ref.manifestHash).toBe(a.ref.manifestHash); expect(restored.revision).toBe(3);
    await expect(store.activate(scope, third.index.ref, a)).rejects.toMatchObject({ code: 'RAG_ACTIVATION_CONFLICT' });
    await expect(store.activate(scope, first.index.ref, restored)).rejects.toMatchObject({ code: 'GENERATION_REUSE' });
  });

  it('rolls back source/corpus/index rows when artifact insertion fails', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const raw = new DatabaseSync(filename);
    try {
      raw.exec("CREATE TRIGGER internal_test_fail BEFORE INSERT ON rag_artifacts BEGIN SELECT RAISE(ABORT,'internal test storage failure'); END;");
      const bundle = await fixture(); await expect(store.stageGeneration(bundle)).rejects.toThrow(/internal test storage failure/);
      expect(store.statistics()).toEqual({ generations: 0, corpora: 0, bytes: 0 });
      raw.exec('DROP TRIGGER internal_test_fail'); await store.stageGeneration(bundle);
      expect(store.statistics()).toMatchObject({ generations: 1, corpora: 1 });
    } finally { raw.close(); }
  });

  it('detects damaged artifact bytes and leaves the active generation untouched', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const first = await fixture(); const next = await fixture({ generation: 'g2' });
    await store.stageGeneration(first); await store.stageGeneration(next); const active = await store.activate(scope, first.index.ref, null);
    const raw = new DatabaseSync(filename);
    try {
      expect(() => raw.prepare('UPDATE rag_artifacts SET bytes=? WHERE generation=?').run(utf8('damaged'), 'g2')).toThrow(/IMMUTABLE/);
      // Removing the trigger simulates damaged disk/imported DB bytes, not an application-supported mutation path.
      raw.exec('DROP TRIGGER rag_artifacts_update_immutable'); raw.prepare('UPDATE rag_artifacts SET bytes=? WHERE generation=?').run(utf8('damaged'), 'g2');
      await expect(store.loadGeneration(scope, next.index.ref)).rejects.toMatchObject({ code: 'INDEX_ARTIFACT_MISMATCH' });
      await expect(store.activate(scope, next.index.ref, active)).rejects.toMatchObject({ code: 'INDEX_ARTIFACT_MISMATCH' });
      expect(store.getActiveIndex(scope, 'index')).toEqual(active);
    } finally { raw.close(); }
  });

  it('rejects reusing a corpus whose durable source bytes have been damaged', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const first = await fixture(); await store.stageGeneration(first);
    const raw = new DatabaseSync(filename);
    try {
      raw.exec('DROP TRIGGER rag_sources_update_immutable'); raw.prepare('UPDATE rag_sources SET original=? WHERE document=?').run(new Uint8Array(first.documents[0]!.originalBytes.byteLength), 'd0');
      await expect(store.loadGeneration(scope, first.index.ref)).rejects.toMatchObject({ code: 'RAG_SOURCE_MISMATCH' });
      await expect(store.stageGeneration(await fixture({ generation: 'g2' }))).rejects.toMatchObject({ code: 'RAG_SOURCE_MISMATCH' });
      expect(store.statistics()).toMatchObject({ generations: 1, corpora: 1 });
    } finally { raw.close(); }
  });

  it('checks actual stored BLOB length before reading oversized damaged artifacts', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const bundle = await fixture(); await store.stageGeneration(bundle);
    const raw = new DatabaseSync(filename);
    try { raw.exec('DROP TRIGGER rag_artifacts_update_immutable'); raw.exec('UPDATE rag_artifacts SET bytes=zeroblob(9000000)'); await expect(store.loadGeneration(scope, bundle.index.ref)).rejects.toMatchObject({ code: 'RAG_GENERATION_LIMIT' }); }
    finally { raw.close(); }
  });

  it('rejects damaged corpus identities and oversized metadata when reusing existing sources', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const bundle = await fixture(); await store.stageGeneration(bundle);
    const next = await fixture({ generation: 'g2' }); const raw = new DatabaseSync(filename);
    try {
      raw.exec('DROP TRIGGER rag_sources_update_immutable'); raw.prepare('UPDATE rag_sources SET revision=? WHERE document=?').run(99, 'd0');
      await expect(store.stageGeneration(next)).rejects.toMatchObject({ code: 'RAG_STORED_IDENTITY' });
      raw.prepare('UPDATE rag_sources SET revision=? WHERE document=?').run(1, 'd0');
      raw.exec("DROP TRIGGER rag_corpora_update_immutable; UPDATE rag_corpora SET body=CAST(zeroblob(9000000) AS TEXT)");
      await expect(store.stageGeneration(next)).rejects.toMatchObject({ code: 'RAG_GENERATION_LIMIT' });
      expect(store.statistics()).toMatchObject({ generations: 1, corpora: 1 });
    } finally { raw.close(); }
  });

  it('rechecks actual staged bytes under the CAS lock after asynchronous verification', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const bundle = await fixture(); await store.stageGeneration(bundle);
    const pending = store.activate(scope, bundle.index.ref, null);
    const raw = new DatabaseSync(filename);
    try {
      // Activation has already captured its owned snapshot and yielded for SHA-256 verification.
      raw.exec('DROP TRIGGER rag_artifacts_update_immutable'); raw.prepare('UPDATE rag_artifacts SET bytes=?').run(utf8('changed after snapshot'));
      await expect(pending).rejects.toMatchObject({ code: 'RAG_STAGING_CHANGED' });
      expect(store.getActiveIndex(scope, 'index')).toBeNull();
    } finally { raw.close(); }
  });

  it('serializes duplicate staging and commits exactly one immutable generation', async () => {
    const filename = database(); const first = open(filename); first.createScope(scope); const second = open(filename); const bundle = await fixture();
    const results = await Promise.allSettled([first.stageGeneration(bundle), second.stageGeneration(bundle)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'RAG_GENERATION_EXISTS' } });
    expect(first.statistics()).toMatchObject({ generations: 1, corpora: 1 });
  });
});

describe('authoritative access, quotas and version boundaries', () => {
  it('enforces tenant/project isolation and refuses session-injected group memberships', async () => {
    const store = open(); store.createScope(scope); const bundle = await fixture(); await store.stageGeneration(bundle); grant(store, bundle);
    const other = { tenantId: scope.tenantId, projectId: 'other' }; store.createScope(other);
    await expect(store.loadGeneration(other, bundle.index.ref)).rejects.toMatchObject({ code: 'RAG_SCOPE_MISMATCH' });
    await expect(store.search({ ...principal, scope: other }, bundle.index.ref, query, controller())).rejects.toMatchObject({ code: 'RAG_SCOPE_MISMATCH' });
    await expect(store.search({ ...principal, groupIds: ['private'] } as typeof principal, bundle.index.ref, query, controller())).rejects.toMatchObject({ code: 'RAG_INPUT_INVALID' });
    expect(store.readCurrent(other, 'alice').documents).toEqual([]);
  });

  it('revokes group access without changing document ACL and persists deletion/tombstone history', async () => {
    const filename = database(); const store = open(filename); store.createScope(scope); const bundle = await fixture(); const ref = await store.stageGeneration(bundle); let epoch = grant(store, bundle);
    expect((await store.search(principal, ref, query, controller())).candidates).toHaveLength(1);
    epoch = store.replaceAccess(scope, { expectedEpoch: epoch, subjects: [{ subjectId: 'alice', groupIds: [] }], documents: records(bundle) });
    expect((await store.search(principal, ref, query, controller())).candidates).toEqual([]);
    epoch = grant(store, bundle, epoch);
    epoch = store.replaceAccess(scope, { expectedEpoch: epoch, subjects: [{ subjectId: 'alice', groupIds: ['team'] }], documents: records(bundle).filter(document => document.documentId !== 'd0') });
    expect(store.readCurrent(scope, 'alice').documents.find(document => document.documentId === 'd0')?.tombstoned).toBe(true);
    expect((await store.search(principal, ref, query, controller())).candidates).toEqual([]);
    expect(() => grant(store, bundle, epoch)).toThrow(/newer revision/);
    store.close(); const reopened = open(filename);
    expect((await reopened.search(principal, ref, query, controller())).candidates).toEqual([]);
  });

  it('requires a registered current subject even when an ACL names that subject directly', async () => {
    const store = open(); store.createScope(scope); const bundle = await fixture(); await store.stageGeneration(bundle);
    store.replaceAccess(scope, { expectedEpoch: 1, subjects: [], documents: records(bundle).map(document => ({ ...document, allowedSubjects: ['unregistered'] })) });
    expect((await store.search({ scope, subjectId: 'unregistered' }, bundle.index.ref, query, controller())).candidates).toEqual([]);
  });

  it('requires a newer document revision to restore a tombstone and excludes the old pinned generation', async () => {
    const store = open(); store.createScope(scope); const old = await fixture(); await store.stageGeneration(old); let epoch = grant(store, old);
    epoch = store.replaceAccess(scope, { expectedEpoch: epoch, subjects: [{ subjectId: 'alice', groupIds: ['team'] }], documents: [] });
    const fresh = await fixture({ generation: 'g2', corpusGeneration: 'c2', revision: 2 }); await store.stageGeneration(fresh); grant(store, fresh, epoch);
    expect((await store.search(principal, old.index.ref, query, controller())).candidates).toEqual([]);
    expect((await store.search(principal, fresh.index.ref, query, controller())).candidates.map(candidate => candidate.chunk.document.revision)).toEqual([2]);
  });

  it('reauthorizes after a delayed real adapter boundary and preserves provider errors/cancellation', async () => {
    const store = open(); store.createScope(scope); const bundle = await fixture({ kind: 'hybrid' }); await store.stageGeneration(bundle); const epoch = grant(store, bundle);
    const result = await store.search(principal, bundle.index.ref, { ...query, channel: 'vector' }, controller(), { embed: async () => { store.replaceAccess(scope, { expectedEpoch: epoch, subjects: [{ subjectId: 'alice', groupIds: [] }], documents: records(bundle) }); return { fingerprint: await embeddingFingerprint(profile), vector: [1, 0] }; } });
    expect(result.candidates).toEqual([]); expect(result.authorizationEpoch).toBe(epoch + 1);
    grant(store, bundle, epoch + 1);
    await expect(store.search(principal, bundle.index.ref, { ...query, channel: 'vector' }, controller())).rejects.toMatchObject({ code: 'QUERY_EMBEDDER_REQUIRED' });
    await expect(store.search(principal, bundle.index.ref, { ...query, channel: 'vector' }, controller(), { embed: async () => { throw new Error('internal test provider unavailable'); } })).rejects.toThrow('internal test provider unavailable');
    await expect(store.search(principal, bundle.index.ref, query, AbortSignal.abort())).rejects.toThrow();
  });

  it('rolls back a stale access replacement without partially changing memberships or ACLs', async () => {
    const store = open(); store.createScope(scope); const bundle = await fixture(); grant(store, bundle);
    const before = store.readCurrent(scope, 'alice');
    expect(() => store.replaceAccess(scope, { expectedEpoch: 1, subjects: [], documents: [] })).toThrow(/changed/);
    expect(store.readCurrent(scope, 'alice')).toEqual(before);
  });

  it('enforces generation, payload and access quotas without leaving partial state', async () => {
    const count = open(database(), { maxGenerations: 1 }); count.createScope(scope); await count.stageGeneration(await fixture());
    await expect(count.stageGeneration(await fixture({ generation: 'g2', corpusGeneration: 'c2' }))).rejects.toMatchObject({ code: 'RAG_STORE_QUOTA' });
    expect(count.statistics()).toMatchObject({ generations: 1, corpora: 1 });
    const bytes = open(database(), { maxStoreBytes: 1000 }); bytes.createScope(scope);
    await expect(bytes.stageGeneration(await fixture())).rejects.toMatchObject({ code: 'RAG_STORE_QUOTA' });
    expect(bytes.statistics()).toEqual({ generations: 0, corpora: 0, bytes: 0 });
    const generation = open(database(), { maxGenerationBytes: 1000 }); generation.createScope(scope);
    await expect(generation.stageGeneration(await fixture())).rejects.toMatchObject({ code: 'RAG_GENERATION_LIMIT' });
    const access = open(database(), { maxStoreBytes: 5 }); access.createScope(scope);
    const bundle = await fixture(); expect(() => grant(access, bundle)).toThrow();
    expect(access.readCurrent(scope, 'alice')).toEqual({ scope, subjectId: 'alice', groupIds: [], epoch: 1, documents: [] });
  });

  it('fails closed on future/foreign database schemas before changing stored bytes', () => {
    const filename = database(); const raw = new DatabaseSync(filename); raw.exec('PRAGMA application_id=1397899591; PRAGMA user_version=99'); raw.close();
    const before = readFileSync(filename);
    expect(() => open(filename)).toThrow(/newer service/); expect(readFileSync(filename)).toEqual(before);
    const foreign = database(); const other = new DatabaseSync(foreign); other.exec('CREATE TABLE unrelated(value TEXT)'); other.close();
    expect(() => open(foreign)).toThrow(/recognized RAG store/);
  });

  it('rejects linked database files and junction directory paths', () => {
    const filename = database(); const store = open(filename); store.close();
    const linked = join(dirname(filename), 'linked.sqlite'); linkSync(filename, linked);
    expect(() => open(linked)).toThrow(/links/);
    const real = join(dirname(filename), 'real'); mkdirSync(real); const junction = join(dirname(filename), 'junction'); symlinkSync(real, junction, 'junction');
    expect(() => open(join(junction, 'rag.sqlite'))).toThrow(/linked directories/);
  });
});
