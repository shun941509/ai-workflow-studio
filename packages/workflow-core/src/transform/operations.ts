import { assertJsonData, parseStrictJson, validateJsonValue, type WorkflowNode } from '@studio/spec';
import { assertAllowedKeys, assertSafeKey, copyJson, CoreOperationError, lookupPointer, requireRecord } from './json.js';

export type TransformStep = Extract<WorkflowNode, { type: 'transform' }>['config']['steps'][number];
const operations = new Set(['pick', 'omit', 'rename', 'map', 'format', 'parse_json', 'stringify_json']);

/** Only the seven schema-declared operations are accepted. Options are closed per operation. */
function validateSteps(steps: unknown, depth = 0): asserts steps is TransformStep[] {
  if (depth > 8 || !Array.isArray(steps) || !steps.length || steps.length > 64) throw new CoreOperationError('TRANSFORM_LIMIT', 'A transform needs 1 to 64 steps and at most 8 nested maps');
  for (const raw of steps) {
    const step = requireRecord(raw, 'INVALID_TRANSFORM'); assertAllowedKeys(step, ['op', 'options']);
    if (typeof step.op !== 'string' || !operations.has(step.op)) throw new CoreOperationError('UNSUPPORTED_TRANSFORM', `Unsupported transform: ${String(step.op)}`);
    const options = step.options === undefined ? {} : requireRecord(step.options, 'INVALID_TRANSFORM_OPTIONS');
    if (step.op === 'pick' || step.op === 'omit') {
      assertAllowedKeys(options, step.op === 'pick' ? ['keys', 'missing'] : ['keys']);
      if (!Array.isArray(options.keys) || options.keys.length > 1000 || options.keys.some(key => typeof key !== 'string')) throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'keys must be a bounded string array');
      if (new Set(options.keys).size !== options.keys.length) throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'Duplicate transform keys');
      for (const key of options.keys) assertSafeKey(key as string);
      if (options.missing !== undefined && options.missing !== 'error' && options.missing !== 'omit') throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'pick.missing must be error or omit');
    } else if (step.op === 'rename') {
      assertAllowedKeys(options, ['mapping']);
      const mapping = requireRecord(options.mapping, 'INVALID_TRANSFORM_OPTIONS');
      if (!Object.keys(mapping).length || Object.keys(mapping).length > 1000) throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'rename requires 1 to 1000 mappings');
      const targets = new Set<string>();
      for (const [source, target] of Object.entries(mapping)) {
        assertSafeKey(source);
        if (typeof target !== 'string') throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'rename targets must be strings');
        assertSafeKey(target);
        if (targets.has(target)) throw new CoreOperationError('TRANSFORM_COLLISION', 'Two fields cannot be renamed to the same target');
        targets.add(target);
      }
    } else if (step.op === 'map') {
      assertAllowedKeys(options, ['steps']); validateSteps(options.steps, depth + 1);
    } else if (step.op === 'format') {
      assertAllowedKeys(options, ['template']);
      if (typeof options.template !== 'string' || options.template.length > 100000) throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'format.template must be a bounded string');
      const unmatched = options.template.replace(/\{\{([^{}]*)\}\}/g, '');
      if (unmatched.includes('{{') || unmatched.includes('}}')) throw new CoreOperationError('INVALID_TEMPLATE', 'Template contains unmatched placeholder delimiters');
      for (const match of options.template.matchAll(/\{\{([^{}]*)\}\}/g)) lookupPointer({}, match[1]!.trim());
    } else if (step.op === 'parse_json') assertAllowedKeys(options, []);
    else {
      assertAllowedKeys(options, ['indent']);
      if (options.indent !== undefined && (!Number.isInteger(options.indent) || (options.indent as number) < 0 || (options.indent as number) > 8)) throw new CoreOperationError('INVALID_TRANSFORM_OPTIONS', 'indent must be an integer from 0 to 8');
    }
  }
}

/** Check the complete transform program without requiring or evaluating any input data. */
export function validateTransformSteps(steps: unknown): asserts steps is TransformStep[] {
  assertJsonData(steps); validateSteps(steps);
}

/** Execute bounded JSON transforms without shell, JavaScript expressions, implicit coercion or input mutation. */
export function applyTransform(value: unknown, steps: readonly TransformStep[], resultSchema?: unknown): unknown {
  assertJsonData(value); validateTransformSteps(steps);
  let operationCount = 0;
  const run = (input: unknown, pipeline: readonly TransformStep[]): unknown => {
    let current = input;
    for (const step of pipeline) {
      if (++operationCount > 10000) throw new CoreOperationError('TRANSFORM_LIMIT', 'Transform operation budget exceeded');
      const options = (step.options ?? {}) as Record<string, unknown>;
      if (step.op === 'pick' || step.op === 'omit') {
        const source = requireRecord(current); const keys = options.keys as string[];
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        if (step.op === 'pick') {
          for (const key of keys) {
            if (!Object.hasOwn(source, key)) { if (options.missing === 'omit') continue; throw new CoreOperationError('TRANSFORM_MISSING_FIELD', `Missing pick field: ${key}`); }
            result[key] = source[key];
          }
        } else for (const [key, item] of Object.entries(source)) if (!keys.includes(key)) result[key] = item;
        current = result;
      } else if (step.op === 'rename') {
        const source = requireRecord(current); const mapping = options.mapping as Record<string, string>;
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        // All renames read the original object, so an explicit a↔b swap is well-defined.
        for (const key of Object.keys(mapping)) if (!Object.hasOwn(source, key)) throw new CoreOperationError('TRANSFORM_MISSING_FIELD', `Missing rename field: ${key}`);
        for (const [key, item] of Object.entries(source)) {
          const target = Object.hasOwn(mapping, key) ? mapping[key]! : key;
          if (Object.hasOwn(result, target)) throw new CoreOperationError('TRANSFORM_COLLISION', `Rename would overwrite field: ${target}`);
          result[target] = item;
        }
        current = result;
      } else if (step.op === 'map') {
        if (!Array.isArray(current) || current.length > 10000) throw new CoreOperationError('TRANSFORM_TYPE', 'map requires an array of at most 10000 items');
        current = current.map(item => run(item, options.steps as TransformStep[]));
      } else if (step.op === 'format') {
        current = (options.template as string).replace(/\{\{([^{}]*)\}\}/g, (_match, pointer: string) => {
          const found = lookupPointer(current, pointer.trim());
          if (!found.found) throw new CoreOperationError('TRANSFORM_MISSING_FIELD', `Template pointer is missing: ${pointer.trim()}`);
          if (found.value !== null && !['string', 'number', 'boolean'].includes(typeof found.value)) throw new CoreOperationError('TRANSFORM_TYPE', 'Template values must be scalars; stringify objects explicitly');
          return found.value === null ? 'null' : String(found.value);
        });
      } else if (step.op === 'parse_json') {
        if (typeof current !== 'string') throw new CoreOperationError('TRANSFORM_TYPE', 'parse_json requires a string');
        current = parseStrictJson(current);
      } else if (step.op === 'stringify_json') current = JSON.stringify(current, null, (options.indent as number | undefined) ?? 0);
      assertJsonData(current);
      if (new TextEncoder().encode(JSON.stringify(current)).byteLength > 8 * 1024 * 1024) throw new CoreOperationError('TRANSFORM_LIMIT', 'Transform output exceeds 8 MiB');
    }
    return current;
  };
  const result = run(copyJson(value), steps);
  if (resultSchema !== undefined && !validateJsonValue(resultSchema, result).valid) throw new CoreOperationError('TRANSFORM_OUTPUT_INVALID', 'Transform output violates its declared result schema');
  return copyJson(result);
}
