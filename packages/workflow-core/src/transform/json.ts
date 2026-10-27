import { assertJsonData, FORBIDDEN_KEYS } from '@studio/spec';

/** Pure-operation failures carry stable codes without depending on the public barrel or Runner state. */
export class CoreOperationError extends Error {
  constructor(readonly code: string, message: string, readonly instancePath = '') {
    super(message); this.name = 'CoreOperationError';
  }
}

export function requireRecord(value: unknown, code = 'OBJECT_REQUIRED'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CoreOperationError(code, 'A JSON object is required');
  return value as Record<string, unknown>;
}

/** Field names never become JavaScript prototype access or writes. */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string') throw new CoreOperationError('INVALID_PROPERTY', 'Property names must be strings');
  if (FORBIDDEN_KEYS.has(key)) throw new CoreOperationError('UNSAFE_PROPERTY', 'Prototype-related properties are forbidden');
}

export function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new CoreOperationError('UNSUPPORTED_OPTION', `Unsupported option: ${key}`);
}

/** Lookup preserves missing/null and copies no data; callers decide whether a missing value is legal. */
export function lookupPointer(root: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) throw new CoreOperationError('INVALID_POINTER', 'JSON Pointer must start with / or be empty');
  const keys = pointer.slice(1).split('/').map(raw => {
    if (/~(?:[^01]|$)/.test(raw)) throw new CoreOperationError('INVALID_POINTER', 'Malformed JSON Pointer escape');
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~'); assertSafeKey(key); return key;
  });
  let value = root;
  for (const key of keys) {
    if (value === null || typeof value !== 'object') return { found: false };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { found: false };
    if (!Object.hasOwn(value, key)) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value')) throw new CoreOperationError('UNSAFE_PROPERTY', 'Accessors are not JSON data');
    value = descriptor.value;
  }
  return { found: true, value };
}

/** Clone only finite bounded JSON; this also prevents later handlers from mutating predecessor results. */
export function copyJson(value: unknown): unknown {
  assertJsonData(value);
  return structuredClone(value);
}
