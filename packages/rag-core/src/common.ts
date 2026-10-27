import { assertJsonData, FORBIDDEN_KEYS } from '@studio/spec';
import { canonicalize } from 'json-canonicalize';

/** Pure contract failures: consumers must not convert ACL, generation, or provenance failures into empty success. */
export class RagContractError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RagContractError'; }
}

export function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new RagContractError(code, message);
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT', 'Expected a plain object');
  const prototype = Object.getPrototypeOf(value);
  requireCondition(prototype === null || prototype === Object.prototype, 'INVALID_OBJECT', 'Expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireCondition(typeof key === 'string' && !FORBIDDEN_KEYS.has(key) && allowed.includes(key) && 'value' in descriptor && descriptor.enumerable, 'INVALID_FIELD', 'Unexpected or unsafe contract field');
  }
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !FORBIDDEN_KEYS.has(value), 'INVALID_ID', 'Expected a bounded identifier');
}
export function text(value: unknown, max = 2000): asserts value is string {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= max, 'INVALID_TEXT', 'Expected bounded nonempty text'); assertJsonData(value);
}
export function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  requireCondition(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum, 'INVALID_INTEGER', `Expected integer in ${minimum}..${maximum}`);
}
export function digest(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_DIGEST', 'Expected lower-case SHA-256');
}
export function equal(left: unknown, right: unknown): boolean { return canonicalize(left) === canonicalize(right); }
export function compareId(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/** Clone before freezing/hashing so callers cannot mutate a snapshot while an async digest is pending. */
export function immutable<T>(value: T): Readonly<T> {
  assertJsonData(value); const clone = structuredClone(value);
  const visit = (entry: unknown): void => { if (entry && typeof entry === 'object') { for (const child of Object.values(entry)) visit(child); Object.freeze(entry); } };
  visit(clone); return clone;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', owned);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
export async function jsonDigest(value: unknown): Promise<string> { assertJsonData(value); return sha256(new TextEncoder().encode(canonicalize(value))); }

export interface AccessScope { tenantId: string; projectId: string }
export function validateScope(scope: AccessScope): void { object(scope, ['tenantId', 'projectId']); identifier(scope.tenantId); identifier(scope.projectId); }
export function assertScope(actual: AccessScope, expected: AccessScope): void {
  validateScope(actual); validateScope(expected); requireCondition(equal(actual, expected), 'SCOPE_MISMATCH', 'Tenant/project scope mismatch');
}
