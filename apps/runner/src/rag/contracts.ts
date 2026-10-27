import { assertJsonData, FORBIDDEN_KEYS } from '@studio/spec';
import type { AccessScope, DocumentAccess, DocumentInput, IndexRef, LocalSearchBundle, Principal } from '@studio/rag-core';

/** Storage errors are stable and safe to report; source contents, query text and credentials never become messages. */
export class RagStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RagStoreError'; }
}
export function requireStore(value: unknown, code: string, message: string): asserts value { if (!value) throw new RagStoreError(code, message); }
export function id(value: unknown): asserts value is string { requireStore(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !FORBIDDEN_KEYS.has(value), 'RAG_ID_INVALID', 'A bounded RAG identifier is required.'); }
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireStore(value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)), 'RAG_INPUT_INVALID', 'Expected a plain contract object.');
  for (const key of Reflect.ownKeys(value)) { const property = Object.getOwnPropertyDescriptor(value, key)!; requireStore(typeof key === 'string' && keys.includes(key) && !FORBIDDEN_KEYS.has(key) && property.enumerable && 'value' in property, 'RAG_INPUT_INVALID', 'Unexpected contract field.'); }
}
export function scope(value: AccessScope): void { exact(value, ['tenantId', 'projectId']); id(value.tenantId); id(value.projectId); }
export function sameScope(actual: AccessScope, expected: AccessScope): void { scope(actual); scope(expected); requireStore(actual.tenantId === expected.tenantId && actual.projectId === expected.projectId, 'RAG_SCOPE_MISMATCH', 'Tenant/project scopes do not match.'); }
export function checkedPrincipal(value: Principal): Principal { assertJsonData(value); exact(value, ['scope', 'subjectId']); scope(value.scope); id(value.subjectId); return structuredClone(value); }
export function integer(value: unknown, min: number, max: number): asserts value is number { requireStore(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, 'RAG_LIMIT_INVALID', 'Value is outside the bounded integer range.'); }

/** Limits are per local database, including inactive immutable generations; no silent eviction destroys provenance. */
export interface RagStoreLimits { maxStoreBytes: number; maxGenerationBytes: number; maxGenerations: number; maxScopes: number; maxSubjectsPerScope: number; maxAccessDocumentsPerScope: number }
export const DEFAULT_RAG_STORE_LIMITS: Readonly<RagStoreLimits> = Object.freeze({ maxStoreBytes: 512 * 1024 * 1024, maxGenerationBytes: 64 * 1024 * 1024, maxGenerations: 128, maxScopes: 64, maxSubjectsPerScope: 1000, maxAccessDocumentsPerScope: 10000 });
export function checkedLimits(input: Partial<RagStoreLimits> = {}): RagStoreLimits {
  exact(input, Object.keys(DEFAULT_RAG_STORE_LIMITS));
  const result = { ...DEFAULT_RAG_STORE_LIMITS, ...input };
  for (const key of Object.keys(result) as (keyof RagStoreLimits)[]) integer(result[key], 1, DEFAULT_RAG_STORE_LIMITS[key]);
  return Object.freeze(result);
}
export interface StagedGeneration extends LocalSearchBundle { documents: DocumentInput[] }
export interface ActiveIndex { ref: IndexRef; revision: number }
export interface SubjectMembership { subjectId: string; groupIds: string[] }
export interface AccessReplacement { expectedEpoch: number; subjects: SubjectMembership[]; documents: DocumentAccess[] }

/** This whole-scope replacement must come from a trusted service identity adapter, never a workflow/AI tool payload. */
export function checkedAccess(input: AccessReplacement, limits: RagStoreLimits): AccessReplacement {
  assertJsonData(input); exact(input, ['expectedEpoch', 'subjects', 'documents']); integer(input.expectedEpoch, 1, Number.MAX_SAFE_INTEGER - 1);
  requireStore(Array.isArray(input.subjects) && input.subjects.length <= limits.maxSubjectsPerScope && Array.isArray(input.documents) && input.documents.length <= limits.maxAccessDocumentsPerScope, 'RAG_ACCESS_LIMIT', 'Access snapshot exceeds configured bounds.');
  const subjectIds = new Set<string>(); const documentIds = new Set<string>();
  const ids = (values: unknown): void => { requireStore(Array.isArray(values) && values.length <= 1000 && new Set(values).size === values.length, 'RAG_ACCESS_INVALID', 'Access lists require bounded unique identifiers.'); for (const value of values) id(value); };
  for (const subject of input.subjects) { exact(subject, ['subjectId', 'groupIds']); id(subject.subjectId); requireStore(!subjectIds.has(subject.subjectId), 'RAG_ACCESS_INVALID', 'Duplicate subject.'); subjectIds.add(subject.subjectId); ids(subject.groupIds); }
  for (const document of input.documents) { exact(document, ['documentId', 'revision', 'tombstoned', 'allowedSubjects', 'allowedGroups']); id(document.documentId); integer(document.revision, 1, Number.MAX_SAFE_INTEGER); requireStore(typeof document.tombstoned === 'boolean' && !documentIds.has(document.documentId), 'RAG_ACCESS_INVALID', 'Invalid or duplicate document access record.'); documentIds.add(document.documentId); ids(document.allowedSubjects); ids(document.allowedGroups); }
  return structuredClone(input);
}
