import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, parse as parsePath } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { assertJsonData, parseStrictJson } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { createCorpusGeneration, openLocalSearchProvider, planIndexActivation, searchCurrentChannel, validateCorpusRef, validateIndexRef, verifyCorpusGeneration, verifyIndexArtifacts, type AccessAuthority, type AccessScope, type AuthorizationResult, type AuthorizationSnapshot, type CorpusGeneration, type DocumentAccess, type DocumentInput, type IndexGeneration, type IndexRef, type LocalSearchBundle, type Principal, type QueryEmbedder, type SearchChannel } from '@studio/rag-core';
import { checkedAccess, checkedLimits, checkedPrincipal, exact, id, integer, RagStoreError, requireStore, sameScope, scope as checkScope, type AccessReplacement, type ActiveIndex, type RagStoreLimits, type StagedGeneration } from './contracts.js';
import { RAG_APPLICATION_ID, RAG_DATABASE_VERSION, RAG_MIGRATION, RAG_TABLES } from './schema.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface OwnedGeneration extends StagedGeneration { corpusJson: string; indexJson: string; extracted: Uint8Array[]; extractionJson: string[] }
interface StoredSnapshot extends OwnedGeneration { receipt: string }
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const utf8 = (text: string) => new TextEncoder().encode(text);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const coordinates = (scope: AccessScope) => [scope.tenantId, scope.projectId] as const;
const generationKey = (ref: IndexRef) => [...coordinates(ref.scope), ref.indexId, ref.generationId] as const;
const sameRef = (a: IndexRef, b: IndexRef) => a.scope.tenantId === b.scope.tenantId && a.scope.projectId === b.scope.projectId && a.indexId === b.indexId && a.generationId === b.generationId && a.formatVersion === b.formatVersion && a.manifestHash === b.manifestHash;

/** Keep SQLite files in a trusted service-owned directory; workflow data never chooses this path. This is not OS sandboxing. */
export function storagePath(filename: string): string {
  requireStore(isAbsolute(filename), 'RAG_STORAGE_PATH', 'RAG storage requires an absolute service-configured database path.');
  const target = resolve(filename); let parent = dirname(target);
  while (parent !== parsePath(parent).root) { if (existsSync(parent)) requireStore(!lstatSync(parent).isSymbolicLink(), 'RAG_STORAGE_LINK', 'RAG storage cannot traverse linked directories.'); parent = dirname(parent); }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  for (const file of [target, `${target}-wal`, `${target}-shm`]) if (existsSync(file)) { const stat = lstatSync(file); requireStore(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'RAG_STORAGE_LINK', 'RAG database files cannot be links or shared hard links.'); }
  return target;
}
function json<T>(value: unknown): T {
  requireStore(typeof value === 'string' && Buffer.byteLength(value) <= MAX_JSON_BYTES, 'RAG_STORED_DATA_INVALID', 'Stored JSON is missing or exceeds the supported bound.');
  try { return parseStrictJson(value) as T; } catch { throw new RagStoreError('RAG_STORED_DATA_INVALID', 'Stored JSON is malformed or ambiguous.'); }
}
function decode(value: Uint8Array): string { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); } catch { throw new RagStoreError('RAG_STORED_DATA_INVALID', 'RAG extraction must preserve every valid UTF-8 byte, including its BOM.'); } }
function number(row: Row | undefined, key: string): number { const value = Number(row?.[key]); requireStore(Number.isSafeInteger(value) && value >= 0, 'RAG_STORED_DATA_INVALID', 'Stored integer is invalid.'); return value; }
function bytes(value: unknown): Uint8Array { requireStore(value instanceof Uint8Array, 'RAG_STORED_DATA_INVALID', 'Stored source/artifact bytes are missing.'); return new Uint8Array(value); }

/**
 * A local durable, bounded store for trusted service callers. Staging writes complete BLOBs in one transaction;
 * activation is a distinct CAS. No workflow fields can update identities, ACLs, paths or active generations.
 */
export class SqliteRagStore {
  readonly limits: Readonly<RagStoreLimits>;
  readonly authority: AccessAuthority;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(filename: string, limits: Partial<RagStoreLimits> = {}) {
    this.limits = checkedLimits(limits);
    this.#db = new DatabaseSync(storagePath(filename), { allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      // Version and ownership are inspected before any migration or journal-mode mutation of an existing database.
      const version = number(this.#get('PRAGMA user_version'), 'user_version');
      const applicationId = number(this.#get('PRAGMA application_id'), 'application_id');
      requireStore(version <= RAG_DATABASE_VERSION, 'RAG_DATABASE_VERSION', 'This RAG database requires a newer service.');
      const existing = this.#all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      requireStore(version === 0 ? applicationId === 0 && existing.length === 0 : applicationId === RAG_APPLICATION_ID && existing.length === RAG_TABLES.length && existing.every(row => RAG_TABLES.includes(row.name as typeof RAG_TABLES[number])), 'RAG_DATABASE_FORMAT', 'Database is not a recognized RAG store.');
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=8388608;');
      const pageSize = number(this.#get('PRAGMA page_size'), 'page_size');
      requireStore(pageSize > 0 && number(this.#get('PRAGMA page_count'), 'page_count') * pageSize <= MAX_DATABASE_BYTES, 'RAG_STORE_QUOTA', 'RAG database exceeds its physical page limit.');
      this.#db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
      if (version === 0) this.#transaction(() => this.#db.exec(RAG_MIGRATION));
      requireStore(this.#get('PRAGMA quick_check')?.quick_check === 'ok' && this.#all('PRAGMA foreign_key_check').length === 0, 'RAG_DATABASE_INTEGRITY', 'RAG database integrity check failed.');
      this.#checkStoreLimits(0, 0);
      this.authority = Object.freeze({ readCurrent: async (scope: AccessScope, subjectId: string) => this.readCurrent(scope, subjectId) });
    } catch (error) { this.#db.close(); this.#closed = true; throw error; }
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  /** Trusted service identity checks must distinguish a removed subject from a subject with no readable documents. */
  hasCurrentSubject(scope: AccessScope, subjectId: string): boolean {
    checkScope(scope); id(subjectId); this.#scopeEpoch(scope);
    return Boolean(this.#get('SELECT subject FROM rag_subjects WHERE tenant=? AND project=? AND subject=?', ...coordinates(scope), subjectId));
  }

  /** Trusted administration creates an empty-deny scope; merely staging documents grants no access. */
  createScope(scope: AccessScope): void {
    checkScope(scope);
    this.#transaction(() => {
      requireStore(!this.#get('SELECT epoch FROM rag_scopes WHERE tenant=? AND project=?', ...coordinates(scope)), 'RAG_SCOPE_EXISTS', 'Scope already exists.');
      requireStore(number(this.#get('SELECT COUNT(*) AS count FROM rag_scopes'), 'count') < this.limits.maxScopes, 'RAG_STORE_QUOTA', 'Scope quota exceeded.');
      this.#db.prepare('INSERT INTO rag_scopes(tenant,project,epoch) VALUES(?,?,1)').run(...coordinates(scope));
    });
  }

  /**
   * Trusted identity/ACL adapter only. Memberships and documents share one epoch and atomic transaction.
   * Omitted documents become durable tombstones; reviving one requires a strictly newer revision.
   */
  replaceAccess(scope: AccessScope, replacement: AccessReplacement): number {
    checkScope(scope); const owned = checkedAccess(replacement, this.limits);
    return this.#transaction(() => {
      const epoch = this.#scopeEpoch(scope);
      requireStore(epoch === owned.expectedEpoch, 'RAG_ACCESS_CONFLICT', 'Access authority changed before this replacement.');
      integer(epoch + 1, 1, Number.MAX_SAFE_INTEGER - 1);
      const existing = this.#all('SELECT document,revision,tombstoned FROM rag_access WHERE tenant=? AND project=?', ...coordinates(scope));
      const previous = new Map(existing.map(row => [String(row.document), row]));
      requireStore(new Set([...previous.keys(), ...owned.documents.map(document => document.documentId)]).size <= this.limits.maxAccessDocumentsPerScope, 'RAG_ACCESS_LIMIT', 'Durable access/tombstone inventory exceeds configured bounds.');
      for (const document of owned.documents) {
        const old = previous.get(document.documentId);
        requireStore(!old || document.revision >= number(old, 'revision'), 'RAG_REVISION_ROLLBACK', 'Current document revisions cannot move backwards.');
        requireStore(!old || !Number(old.tombstoned) || document.tombstoned || document.revision > number(old, 'revision'), 'RAG_TOMBSTONE_FINAL', 'Restoring a deleted document requires a newer revision.');
      }
      this.#db.prepare('DELETE FROM rag_subjects WHERE tenant=? AND project=?').run(...coordinates(scope));
      for (const subject of owned.subjects) this.#db.prepare('INSERT INTO rag_subjects(tenant,project,subject,groups_json) VALUES(?,?,?,?)').run(...coordinates(scope), subject.subjectId, JSON.stringify(subject.groupIds));
      // Mark absent documents deleted instead of losing their deletion history and accidentally permitting same-revision resurrection.
      this.#db.prepare('UPDATE rag_access SET tombstoned=1,subjects_json=\'[]\',groups_json=\'[]\' WHERE tenant=? AND project=?').run(...coordinates(scope));
      for (const document of owned.documents) this.#db.prepare('INSERT INTO rag_access(tenant,project,document,revision,tombstoned,subjects_json,groups_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant,project,document) DO UPDATE SET revision=excluded.revision,tombstoned=excluded.tombstoned,subjects_json=excluded.subjects_json,groups_json=excluded.groups_json').run(...coordinates(scope), document.documentId, document.revision, Number(document.tombstoned), JSON.stringify(document.allowedSubjects), JSON.stringify(document.allowedGroups));
      this.#db.prepare('UPDATE rag_scopes SET epoch=? WHERE tenant=? AND project=? AND epoch=?').run(epoch + 1, ...coordinates(scope), epoch);
      this.#checkStoreLimits(0, 0);
      return epoch + 1;
    });
  }

  /** Reads current subject membership and ACL in one SQLite snapshot; missing subjects deny even direct ACL grants. */
  readCurrent(scope: AccessScope, subjectId: string): AuthorizationSnapshot {
    checkScope(scope); id(subjectId);
    return this.#transaction(() => {
      const epoch = this.#scopeEpoch(scope);
      const subject = this.#get('SELECT groups_json FROM rag_subjects WHERE tenant=? AND project=? AND subject=?', ...coordinates(scope), subjectId);
      if (!subject) return { scope: structuredClone(scope), subjectId, groupIds: [], epoch, documents: [] };
      const rows = this.#all('SELECT document,revision,tombstoned,subjects_json,groups_json FROM rag_access WHERE tenant=? AND project=? ORDER BY document LIMIT ?', ...coordinates(scope), this.limits.maxAccessDocumentsPerScope + 1);
      requireStore(rows.length <= this.limits.maxAccessDocumentsPerScope, 'RAG_ACCESS_LIMIT', 'Stored ACL inventory exceeds configured bounds.');
      requireStore(rows.every(row => row.tombstoned === 0 || row.tombstoned === 1), 'RAG_ACCESS_INVALID', 'Stored deletion state is invalid.');
      const result: AuthorizationSnapshot = { scope: structuredClone(scope), subjectId, groupIds: json<string[]>(subject.groups_json), epoch, documents: rows.map(row => ({ documentId: String(row.document), revision: number(row, 'revision'), tombstoned: row.tombstoned === 1, allowedSubjects: json<string[]>(row.subjects_json), allowedGroups: json<string[]>(row.groups_json) })) };
      checkedAccess({ expectedEpoch: epoch, subjects: [{ subjectId, groupIds: result.groupIds }], documents: result.documents }, this.limits);
      return result;
    }, true);
  }

  /** Verify source bytes, reconstructed UTF-8 chunk provenance, and actual local artifact semantics before durable staging. */
  async stageGeneration(input: StagedGeneration): Promise<IndexRef> {
    const owned = this.#own(input);
    await this.#verify(owned);
    const ref = owned.index.ref; const corpusRef = owned.corpus.ref; const scope = ref.scope;
    this.#transaction(() => {
      this.#scopeEpoch(scope);
      requireStore(!this.#get('SELECT hash FROM rag_indexes WHERE tenant=? AND project=? AND index_id=? AND generation=?', ...generationKey(ref)), 'RAG_GENERATION_EXISTS', 'Index generation IDs cannot be reused.');
      const corpusKey = [...coordinates(scope), corpusRef.corpusId, corpusRef.generationId] as const;
      const priorCorpus = this.#get('SELECT hash,length(CAST(body AS BLOB)) AS size FROM rag_corpora WHERE tenant=? AND project=? AND corpus=? AND generation=?', ...corpusKey);
      if (priorCorpus) {
        // A damaged existing corpus is bounded before reading its body, just like the normal load path.
        requireStore(number(priorCorpus, 'size') <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Existing corpus metadata exceeds the JSON bound.');
        requireStore(priorCorpus.hash === corpusRef.manifestHash && this.#get('SELECT body FROM rag_corpora WHERE tenant=? AND project=? AND corpus=? AND generation=?', ...corpusKey)?.body === owned.corpusJson, 'RAG_CORPUS_GENERATION_EXISTS', 'A corpus generation ID already identifies different content.');
        this.#checkReusedCorpus(owned);
      }
      for (const document of owned.corpus.documents) {
        const identities = this.#all('SELECT DISTINCT original_hash,text_hash,extraction_hash,source_uri FROM rag_sources WHERE tenant=? AND project=? AND document=? AND revision=? LIMIT 2', ...coordinates(scope), document.documentId, document.revision);
        requireStore(identities.every(row => row.original_hash === document.originalSha256 && row.text_hash === document.textSha256 && row.extraction_hash === document.extractionFingerprint && row.source_uri === document.sourceUri), 'RAG_DOCUMENT_REVISION_REUSED', 'A document revision cannot identify different source or extraction content.');
      }
      const corpusBytes = Buffer.byteLength(owned.corpusJson) + owned.documents.reduce((sum, document, index) => sum + document.originalBytes.byteLength + owned.extracted[index]!.byteLength + Buffer.byteLength(owned.extractionJson[index]!), 0);
      const indexBytes = Buffer.byteLength(owned.indexJson) + owned.artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
      this.#checkStoreLimits(indexBytes + (priorCorpus ? 0 : corpusBytes), 1);
      if (!priorCorpus) {
        this.#db.prepare('INSERT INTO rag_corpora(tenant,project,corpus,generation,hash,body) VALUES(?,?,?,?,?,?)').run(...coordinates(scope), corpusRef.corpusId, corpusRef.generationId, corpusRef.manifestHash, owned.corpusJson);
        for (const [index, document] of owned.documents.entries()) {
          const source = owned.corpus.documents.find(item => item.documentId === document.documentId)!;
          this.#db.prepare('INSERT INTO rag_sources(tenant,project,corpus,generation,document,revision,original_hash,text_hash,extraction_hash,source_uri,original,extracted,extraction) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...coordinates(scope), corpusRef.corpusId, corpusRef.generationId, document.documentId, document.revision, source.originalSha256, source.textSha256, source.extractionFingerprint, document.sourceUri, document.originalBytes, owned.extracted[index]!, owned.extractionJson[index]!);
        }
      }
      this.#db.prepare('INSERT INTO rag_indexes(tenant,project,index_id,generation,hash,corpus,corpus_generation,body) VALUES(?,?,?,?,?,?,?,?)').run(...generationKey(ref), ref.manifestHash, corpusRef.corpusId, corpusRef.generationId, owned.indexJson);
      for (const artifact of owned.artifacts) this.#db.prepare('INSERT INTO rag_artifacts(tenant,project,index_id,generation,artifact,bytes) VALUES(?,?,?,?,?,?)').run(...generationKey(ref), artifact.id, artifact.bytes);
    });
    return structuredClone(ref);
  }

  /** Each load rereads bounded stored bytes and verifies them; no shared cache can retain revoked permissions or corrupted content. */
  async loadGeneration(scope: AccessScope, reference: IndexRef): Promise<LocalSearchBundle> {
    checkScope(scope); validateIndexRef(reference); sameScope(reference.scope, scope);
    const snapshot = this.#transaction(() => this.#readSnapshot(scope, reference), true);
    await this.#verify(snapshot);
    return { corpus: snapshot.corpus, index: snapshot.index, artifacts: snapshot.artifacts };
  }

  /** Metadata lookup pins a generation; callers must use loadGeneration/search to trust its contents. */
  getActiveIndex(scope: AccessScope, indexId: string): ActiveIndex | null {
    checkScope(scope); id(indexId); this.#scopeEpoch(scope);
    const row = this.#get('SELECT generation,hash,revision FROM rag_active WHERE tenant=? AND project=? AND index_id=?', ...coordinates(scope), indexId);
    if (!row) return null;
    const ref: IndexRef = { scope: structuredClone(scope), indexId, generationId: String(row.generation), formatVersion: '1.0.0', manifestHash: String(row.hash) };
    validateIndexRef(ref); const revision = number(row, 'revision'); integer(revision, 1, Number.MAX_SAFE_INTEGER); return { ref, revision };
  }

  /**
   * Verify outside the write lock, then re-read a byte receipt and compare the full active revision inside BEGIN IMMEDIATE.
   * A concurrent activation or byte mutation cannot publish a stale/partially staged generation, and no await holds the lock.
   */
  async activate(scope: AccessScope, reference: IndexRef, expected: ActiveIndex | null): Promise<ActiveIndex> {
    checkScope(scope); scope = structuredClone(scope); validateIndexRef(reference); sameScope(reference.scope, scope);
    if (expected) { assertJsonData(expected); exact(expected, ['ref', 'revision']); validateIndexRef(expected.ref); sameScope(expected.ref.scope, scope); requireStore(expected.ref.indexId === reference.indexId, 'RAG_SCOPE_MISMATCH', 'Expected active index identity differs.'); integer(expected.revision, 1, Number.MAX_SAFE_INTEGER - 1); }
    const pinnedRef = structuredClone(reference); const ownedExpected = expected ? structuredClone(expected) : null;
    const snapshot = this.#transaction(() => this.#readSnapshot(scope, pinnedRef), true);
    await this.#verify(snapshot);
    await planIndexActivation(ownedExpected?.ref ?? null, snapshot.index, ownedExpected?.ref.manifestHash ?? null, snapshot.artifacts);
    return this.#transaction(() => {
      const current = this.getActiveIndex(scope, pinnedRef.indexId);
      requireStore(current === null && ownedExpected === null || current !== null && ownedExpected !== null && current.revision === ownedExpected.revision && sameRef(current.ref, ownedExpected.ref), 'RAG_ACTIVATION_CONFLICT', 'Active generation changed before activation.');
      requireStore(this.#readSnapshot(scope, pinnedRef).receipt === snapshot.receipt, 'RAG_STAGING_CHANGED', 'Stored generation changed after verification.');
      const revision = (current?.revision ?? 0) + 1; integer(revision, 1, Number.MAX_SAFE_INTEGER);
      this.#db.prepare('INSERT INTO rag_active(tenant,project,index_id,generation,hash,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,project,index_id) DO UPDATE SET generation=excluded.generation,hash=excluded.hash,revision=excluded.revision').run(...coordinates(scope), pinnedRef.indexId, pinnedRef.generationId, pinnedRef.manifestHash, revision);
      return { ref: pinnedRef, revision };
    });
  }

  /** Service-authenticated principal only; neither allowed-document IDs nor session-cached groups are accepted. */
  async search(principal: Principal, reference: IndexRef, options: { query: string; channel: SearchChannel; limit: number }, signal: AbortSignal, embedder?: QueryEmbedder): Promise<AuthorizationResult> {
    const ownedPrincipal = checkedPrincipal(principal); validateIndexRef(reference); const ref = structuredClone(reference); sameScope(ref.scope, ownedPrincipal.scope);
    assertJsonData(options); const ownedOptions = structuredClone(options); signal.throwIfAborted();
    const bundle = await this.loadGeneration(ownedPrincipal.scope, ref); signal.throwIfAborted();
    const provider = await openLocalSearchProvider(bundle, embedder); signal.throwIfAborted();
    return searchCurrentChannel({ principal: ownedPrincipal, corpus: bundle.corpus, index: bundle.index }, provider, this.authority, ownedOptions, signal);
  }

  /** Pin the current pointer once; a concurrent activation never silently replaces an in-flight query's generation. */
  async searchActive(principal: Principal, indexId: string, options: { query: string; channel: SearchChannel; limit: number }, signal: AbortSignal, embedder?: QueryEmbedder): Promise<AuthorizationResult> {
    const ownedPrincipal = checkedPrincipal(principal); const active = this.getActiveIndex(ownedPrincipal.scope, indexId);
    requireStore(active, 'RAG_INDEX_NOT_ACTIVE', 'No active generation is available.');
    return this.search(ownedPrincipal, active.ref, options, signal, embedder);
  }

  /** Counts are operational metadata only; no document text, ACL subjects or queries are exposed here. */
  statistics(): { generations: number; corpora: number; bytes: number } { return { generations: number(this.#get('SELECT COUNT(*) AS count FROM rag_indexes'), 'count'), corpora: number(this.#get('SELECT COUNT(*) AS count FROM rag_corpora'), 'count'), bytes: this.#storedBytes() }; }

  #get(sql: string, ...parameters: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...parameters) as Row | undefined; }
  #all(sql: string, ...parameters: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...parameters) as Row[]; }
  #transaction<T>(action: () => T, readOnly = false): T {
    this.#db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const result = action(); requireStore(!(result && typeof result === 'object' && 'then' in result), 'RAG_TRANSACTION_ASYNC', 'SQLite transactions cannot contain asynchronous callbacks.'); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #scopeEpoch(scope: AccessScope): number { const row = this.#get('SELECT epoch FROM rag_scopes WHERE tenant=? AND project=?', ...coordinates(scope)); requireStore(row, 'RAG_SCOPE_NOT_FOUND', 'RAG scope is not registered.'); const epoch = number(row, 'epoch'); integer(epoch, 1, Number.MAX_SAFE_INTEGER - 1); return epoch; }
  #storedBytes(): number {
    return number(this.#get(`SELECT (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM rag_corpora)+(SELECT COALESCE(SUM(length(original)+length(extracted)+length(CAST(extraction AS BLOB))),0) FROM rag_sources)+(SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM rag_indexes)+(SELECT COALESCE(SUM(length(bytes)),0) FROM rag_artifacts)+(SELECT COALESCE(SUM(length(CAST(groups_json AS BLOB))),0) FROM rag_subjects)+(SELECT COALESCE(SUM(length(CAST(subjects_json AS BLOB))+length(CAST(groups_json AS BLOB))),0) FROM rag_access) AS bytes`), 'bytes');
  }
  #checkStoreLimits(additionalBytes: number, additionalGenerations: number): void {
    requireStore(this.#storedBytes() + additionalBytes <= this.limits.maxStoreBytes && number(this.#get('SELECT COUNT(*) AS count FROM rag_indexes'), 'count') + additionalGenerations <= this.limits.maxGenerations, 'RAG_STORE_QUOTA', 'Stored generations exceed the configured byte or count quota.');
    requireStore(number(this.#get('SELECT COUNT(*) AS count FROM rag_scopes'), 'count') <= this.limits.maxScopes && number(this.#get('SELECT COALESCE(MAX(count),0) AS count FROM (SELECT COUNT(*) AS count FROM rag_subjects GROUP BY tenant,project)'), 'count') <= this.limits.maxSubjectsPerScope && number(this.#get('SELECT COALESCE(MAX(count),0) AS count FROM (SELECT COUNT(*) AS count FROM rag_access GROUP BY tenant,project)'), 'count') <= this.limits.maxAccessDocumentsPerScope, 'RAG_STORE_QUOTA', 'Stored scope or authority inventory exceeds configured bounds.');
  }

  /** Reusing a sealed corpus for another index verifies its durable source bytes as well as its metadata. */
  #checkReusedCorpus(input: OwnedGeneration): void {
    const ref = input.corpus.ref; const key = [...coordinates(ref.scope), ref.corpusId, ref.generationId] as const;
    const sizes = this.#all('SELECT document,length(original) AS original_size,length(extracted) AS text_size,length(CAST(extraction AS BLOB)) AS extraction_size FROM rag_sources WHERE tenant=? AND project=? AND corpus=? AND generation=? LIMIT 1001', ...key);
    requireStore(sizes.length === input.documents.length && sizes.every(row => { const offset = input.documents.findIndex(document => document.documentId === row.document); return offset >= 0 && number(row, 'original_size') === input.documents[offset]!.originalBytes.byteLength && number(row, 'text_size') === input.extracted[offset]!.byteLength && number(row, 'extraction_size') <= MAX_JSON_BYTES; }), 'RAG_SOURCE_MISMATCH', 'Stored corpus source inventory differs from the sealed input.');
    requireStore(sizes.reduce((total, row) => total + number(row, 'original_size') + number(row, 'text_size') + number(row, 'extraction_size'), 0) <= this.limits.maxGenerationBytes, 'RAG_GENERATION_LIMIT', 'Existing corpus source bytes exceed the generation bound.');
    for (const row of this.#all('SELECT document,revision,source_uri,original_hash,text_hash,extraction_hash,original,extracted,extraction FROM rag_sources WHERE tenant=? AND project=? AND corpus=? AND generation=?', ...key)) {
      const expected = input.corpus.documents.find(document => document.documentId === row.document)!;
      requireStore(expected.revision === row.revision && expected.sourceUri === row.source_uri && expected.originalSha256 === row.original_hash && expected.textSha256 === row.text_hash && expected.extractionFingerprint === row.extraction_hash, 'RAG_STORED_IDENTITY', 'Existing source identity columns differ from the sealed corpus.');
      requireStore(hash(bytes(row.original)) === expected.originalSha256 && hash(bytes(row.extracted)) === expected.textSha256 && canonicalDigest(json(row.extraction)) === expected.extractionFingerprint, 'RAG_SOURCE_MISMATCH', 'Existing corpus source bytes were modified.');
    }
  }

  /** Own and bound every caller-provided byte before the first hash await to prevent mutation races. */
  #own(input: StagedGeneration): OwnedGeneration {
    exact(input, ['corpus', 'index', 'documents', 'artifacts']); assertJsonData(input.corpus); assertJsonData(input.index);
    requireStore(Array.isArray(input.documents) && input.documents.length > 0 && input.documents.length <= 1000 && Array.isArray(input.artifacts) && input.artifacts.length === 1, 'RAG_GENERATION_LIMIT', 'Local staged indexes require 1..1000 sources and one bounded artifact.');
    const corpusJson = JSON.stringify(input.corpus); const indexJson = JSON.stringify(input.index);
    requireStore(Buffer.byteLength(corpusJson) <= MAX_JSON_BYTES && Buffer.byteLength(indexJson) <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Generation metadata exceeds the JSON size limit.');
    let total = Buffer.byteLength(corpusJson) + Buffer.byteLength(indexJson);
    const extracted: Uint8Array[] = []; const extractionJson: string[] = [];
    const documents = input.documents.map(document => {
      exact(document, ['documentId', 'revision', 'sourceUri', 'originalBytes', 'extractedText', 'extraction']);
      requireStore(document.originalBytes instanceof Uint8Array && document.originalBytes.byteLength <= this.limits.maxGenerationBytes && typeof document.extractedText === 'string' && document.extractedText.length <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Source bytes/text exceed configured bounds.');
      assertJsonData(document.extraction); const extraction = JSON.stringify(document.extraction); const text = utf8(document.extractedText);
      requireStore(Buffer.byteLength(extraction) <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Extraction metadata exceeds its UTF-8 JSON bound.');
      total += document.originalBytes.byteLength + text.byteLength + Buffer.byteLength(extraction); requireStore(total <= this.limits.maxGenerationBytes, 'RAG_GENERATION_LIMIT', 'Staged generation exceeds its byte quota.');
      extracted.push(text); extractionJson.push(extraction);
      return { ...document, originalBytes: new Uint8Array(document.originalBytes), extraction: structuredClone(document.extraction) };
    });
    const artifacts = input.artifacts.map(artifact => { exact(artifact, ['id', 'bytes']); id(artifact.id); requireStore(artifact.bytes instanceof Uint8Array && artifact.bytes.byteLength > 0 && artifact.bytes.byteLength <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Artifact requires at most 8 MiB of actual bytes.'); total += artifact.bytes.byteLength; requireStore(total <= this.limits.maxGenerationBytes, 'RAG_GENERATION_LIMIT', 'Staged generation exceeds its byte quota.'); return { id: artifact.id, bytes: new Uint8Array(artifact.bytes) }; });
    return { corpus: json<CorpusGeneration>(corpusJson), index: json<IndexGeneration>(indexJson), corpusJson, indexJson, documents, extracted, extractionJson, artifacts };
  }

  async #verify(input: OwnedGeneration): Promise<void> {
    await verifyCorpusGeneration(input.corpus); await verifyIndexArtifacts(input.index, input.artifacts);
    sameScope(input.corpus.ref.scope, input.index.ref.scope);
    requireStore(input.index.corpus.manifestHash === input.corpus.ref.manifestHash && input.index.corpus.corpusId === input.corpus.ref.corpusId && input.index.corpus.generationId === input.corpus.ref.generationId, 'RAG_CORPUS_MISMATCH', 'Index does not pin the supplied corpus generation.');
    const rebuilt = await createCorpusGeneration({ scope: input.corpus.ref.scope, corpusId: input.corpus.ref.corpusId, generationId: input.corpus.ref.generationId, documents: input.documents, chunks: input.corpus.chunks.map(chunk => ({ chunkId: chunk.ref.chunkId, documentId: chunk.ref.document.documentId, start: chunk.ref.location.start, end: chunk.ref.location.end })) });
    requireStore(rebuilt.ref.manifestHash === input.corpus.ref.manifestHash, 'RAG_SOURCE_MISMATCH', 'Stored source bytes/extraction do not reconstruct the pinned corpus.');
    await openLocalSearchProvider({ corpus: input.corpus, index: input.index, artifacts: input.artifacts });
  }

  /** Size queries run before fetching BLOBs; a corrupted size column cannot bypass bounds because actual SQLite lengths are used. */
  #readSnapshot(scope: AccessScope, reference: IndexRef): StoredSnapshot {
    this.#scopeEpoch(scope);
    const header = this.#get('SELECT hash,corpus,corpus_generation,length(CAST(body AS BLOB)) AS size FROM rag_indexes WHERE tenant=? AND project=? AND index_id=? AND generation=?', ...generationKey(reference));
    requireStore(header && header.hash === reference.manifestHash, 'RAG_GENERATION_NOT_FOUND', 'Pinned index generation is unavailable.');
    const corpusKey = [...coordinates(scope), String(header.corpus), String(header.corpus_generation)] as const;
    const corpusHeader = this.#get('SELECT hash,length(CAST(body AS BLOB)) AS size FROM rag_corpora WHERE tenant=? AND project=? AND corpus=? AND generation=?', ...corpusKey);
    requireStore(corpusHeader && number(header, 'size') <= MAX_JSON_BYTES && number(corpusHeader, 'size') <= MAX_JSON_BYTES, 'RAG_GENERATION_LIMIT', 'Stored metadata exceeds supported bounds.');
    const sourceSizes = this.#all('SELECT document,length(original) AS original_size,length(extracted) AS text_size,length(CAST(extraction AS BLOB)) AS extraction_size FROM rag_sources WHERE tenant=? AND project=? AND corpus=? AND generation=? ORDER BY document LIMIT 1001', ...corpusKey);
    const artifactSizes = this.#all('SELECT artifact,length(bytes) AS size FROM rag_artifacts WHERE tenant=? AND project=? AND index_id=? AND generation=? ORDER BY artifact LIMIT 2', ...generationKey(reference));
    requireStore(sourceSizes.length > 0 && sourceSizes.length <= 1000 && artifactSizes.length === 1, 'RAG_GENERATION_LIMIT', 'Stored local generation inventory is incomplete or exceeds limits.');
    const total = number(header, 'size') + number(corpusHeader, 'size') + sourceSizes.reduce((sum, row) => sum + number(row, 'original_size') + number(row, 'text_size') + number(row, 'extraction_size'), 0) + artifactSizes.reduce((sum, row) => sum + number(row, 'size'), 0);
    requireStore(total <= this.limits.maxGenerationBytes && artifactSizes.every(row => number(row, 'size') <= MAX_JSON_BYTES), 'RAG_GENERATION_LIMIT', 'Stored generation exceeds configured byte bounds.');
    const indexJson = String(this.#get('SELECT body FROM rag_indexes WHERE tenant=? AND project=? AND index_id=? AND generation=?', ...generationKey(reference))!.body);
    const corpusJson = String(this.#get('SELECT body FROM rag_corpora WHERE tenant=? AND project=? AND corpus=? AND generation=?', ...corpusKey)!.body);
    const corpus = json<CorpusGeneration>(corpusJson); const index = json<IndexGeneration>(indexJson);
    validateCorpusRef(corpus.ref); validateIndexRef(index.ref); sameScope(corpus.ref.scope, scope); sameScope(index.ref.scope, scope);
    requireStore(sameRef(index.ref, reference) && corpus.ref.corpusId === header.corpus && corpus.ref.generationId === header.corpus_generation && corpus.ref.manifestHash === corpusHeader.hash, 'RAG_STORED_IDENTITY', 'Stored keys do not match their pinned metadata.');
    const rows = this.#all('SELECT document,revision,source_uri,original,extracted,extraction,original_hash,text_hash,extraction_hash FROM rag_sources WHERE tenant=? AND project=? AND corpus=? AND generation=? ORDER BY document', ...corpusKey);
    requireStore(Array.isArray(corpus.documents) && corpus.documents.length > 0 && corpus.documents.length <= 1000, 'RAG_STORED_DATA_INVALID', 'Stored corpus document inventory is malformed.');
    for (const row of rows) {
      const expected = corpus.documents.find(document => document && typeof document === 'object' && document.documentId === row.document);
      requireStore(expected && expected.revision === row.revision && expected.sourceUri === row.source_uri && expected.originalSha256 === row.original_hash && expected.textSha256 === row.text_hash && expected.extractionFingerprint === row.extraction_hash, 'RAG_STORED_IDENTITY', 'Source identity columns differ from the sealed corpus.');
    }
    const artifacts = this.#all('SELECT artifact,bytes FROM rag_artifacts WHERE tenant=? AND project=? AND index_id=? AND generation=? ORDER BY artifact', ...generationKey(reference)).map(row => ({ id: String(row.artifact), bytes: bytes(row.bytes) }));
    const extracted = rows.map(row => bytes(row.extracted)); const extractionJson = rows.map(row => String(row.extraction));
    const documents: DocumentInput[] = rows.map((row, offset) => ({ documentId: String(row.document), revision: number(row, 'revision'), sourceUri: String(row.source_uri), originalBytes: bytes(row.original), extractedText: decode(extracted[offset]!), extraction: json<DocumentInput['extraction']>(row.extraction) }));
    // The receipt covers actual bytes and all storage identity columns and is recomputed under the activation lock.
    const receipt = hash(JSON.stringify({ indexJson, corpusJson, sources: rows.map((row, offset) => ({ ...row, original: hash(documents[offset]!.originalBytes), extracted: hash(extracted[offset]!) })), artifacts: artifacts.map(artifact => ({ id: artifact.id, sha256: hash(artifact.bytes) })) }));
    return { corpus, index, documents, artifacts, corpusJson, indexJson, extracted, extractionJson, receipt };
  }
}
