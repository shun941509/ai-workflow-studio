/** Reject ambiguous JSON before hashing or validating it; JSON.parse alone silently accepts duplicate keys. */
export class StrictJsonError extends Error {
  readonly code = 'JSON_INVALID';
  constructor(message: string, readonly offset: number) {
    super(`${message} (offset ${offset})`);
    this.name = 'StrictJsonError';
  }
}

export const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Parse bounded I-JSON-like data without invoking getters, evaluating code, or accepting prototype keys. */
export function parseStrictJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) throw new StrictJsonError('JSON exceeds 8 MiB', 0);
  let cursor = 0;
  let count = 0;
  const fail = (message: string): never => { throw new StrictJsonError(message, cursor); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1; };
  const string = (): string => {
    const start = cursor;
    if (text[cursor++] !== '"') return fail('Expected a string');
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') {
        let value: string;
        try { value = JSON.parse(text.slice(start, cursor)) as string; } catch { return fail('Invalid JSON string'); }
        // JCS cannot safely sign unpaired UTF-16 surrogate code units.
        for (let index = 0; index < value.length; index += 1) {
          const code = value.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('Unpaired Unicode surrogate');
          } else if (code >= 0xdc00 && code <= 0xdfff) return fail('Unpaired Unicode surrogate');
        }
        return value;
      }
    }
    return fail('Unterminated string');
  };
  const value = (depth: number): unknown => {
    whitespace();
    if (depth > 64 || ++count > 100000) return fail('JSON complexity limit exceeded');
    const char = text[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor += 1;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      whitespace();
      if (text[cursor] === '}') { cursor += 1; return result; }
      while (cursor < text.length) {
        whitespace();
        const key = string();
        if (FORBIDDEN_KEYS.has(key)) return fail('Prototype-related property is forbidden');
        if (Object.hasOwn(result, key)) return fail(`Duplicate JSON key: ${key}`);
        whitespace();
        if (text[cursor++] !== ':') return fail('Expected colon');
        result[key] = value(depth + 1);
        whitespace();
        const separator = text[cursor++];
        if (separator === '}') return result;
        if (separator !== ',') return fail('Expected comma or closing brace');
      }
      return fail('Unterminated object');
    }
    if (char === '[') {
      cursor += 1;
      const result: unknown[] = [];
      whitespace();
      if (text[cursor] === ']') { cursor += 1; return result; }
      while (cursor < text.length) {
        result.push(value(depth + 1));
        whitespace();
        const separator = text[cursor++];
        if (separator === ']') return result;
        if (separator !== ',') return fail('Expected comma or closing bracket');
      }
      return fail('Unterminated array');
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, cursor)) { cursor += token.length; return result; }
    }
    const numeric = text.slice(cursor).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!numeric) return fail('Expected JSON value');
    cursor += numeric[0].length;
    const result = Number(numeric[0]);
    if (!Number.isFinite(result)) return fail('Non-finite number');
    return result;
  };
  const result = value(0);
  whitespace();
  if (cursor !== text.length) return fail('Unexpected trailing content');
  return result;
}

/** HTTP callers may pass objects directly; reject non-JSON objects before validators read properties. */
export function assertJsonData(value: unknown): void {
  const seen = new Set<object>();
  let count = 0;
  let textUnits = 0;
  const text = (input: string) => {
    textUnits += input.length;
    if (textUnits > 8 * 1024 * 1024) throw new Error('JSON text limit exceeded');
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Unpaired Unicode surrogate');
    }
  };
  const walk = (current: unknown, depth: number): void => {
    if (depth > 64 || ++count > 100000) throw new Error('JSON complexity limit exceeded');
    if (typeof current === 'string') { text(current); return; }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object') throw new Error('Value is not JSON data');
    if (seen.has(current)) throw new Error('Cyclic JSON data');
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) throw new Error('Non-plain JSON object');
    if (Object.getOwnPropertySymbols(current).length) throw new Error('Symbol properties are not JSON data');
    const ownKeys = Object.keys(current);
    if (Array.isArray(current) && (ownKeys.length !== current.length || ownKeys.some(key => !/^(0|[1-9][0-9]*)$/.test(key)))) throw new Error('Sparse or decorated arrays are not JSON data');
    for (const key of Object.getOwnPropertyNames(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (!Object.getOwnPropertyDescriptor(current, key)!.enumerable) throw new Error('Hidden properties are not JSON data');
    }
    seen.add(current);
    for (const key of ownKeys) {
      text(key);
      if (FORBIDDEN_KEYS.has(key)) throw new Error('Prototype-related property is forbidden');
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('Accessors are not JSON data');
      walk(descriptor.value, depth + 1);
    }
    seen.delete(current);
  };
  walk(value, 0);
}
