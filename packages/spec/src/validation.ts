import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { schemaBundle } from './generated/schema-bundle.generated.js';
import type { Workflow, WorkflowNode } from './generated/types.generated.js';
import { assertJsonData, FORBIDDEN_KEYS, parseStrictJson } from './strict-json.js';

/** A common issue contract lets canvas fields, importers and Runner preflight show the same failure. */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  stage: string;
  code: string;
  message: string;
  nodeId?: string;
  instancePath: string;
  hint?: string;
}
export type ValidationResult<T> = { valid: true; value: T; issues: ValidationIssue[] } | { valid: false; issues: ValidationIssue[] };

/** Only trusted bundled schemas should be compiled directly; untrusted schemas use validateJsonValue. */
export function createSchemaValidator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

const ajv = createSchemaValidator();
const validateWorkflow = ajv.compile(schemaBundle);
const validateNode = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $ref: '#/$defs/node',
  $defs: schemaBundle.$defs,
});
const userAjv = createSchemaValidator();
const userValidators = new Map<string, ValidateFunction>();
const configValidators = new Map<string, ValidateFunction>();

/** Editors and execution readiness share the canonical closed config schema without constructing a fake node. */
export function validateNodeConfig(type: string, typeVersion: number, value: unknown): ValidationResult<unknown> {
  try {
    assertJsonData(value);
    const key = `nodes_${type}_v${typeVersion}`;
    const definitions = schemaBundle.$defs as Record<string, { properties?: { config?: unknown } }>;
    if (!Object.hasOwn(definitions, key) || !definitions[key]?.properties?.config) return { valid: false, issues: [issue('NODE_TYPE_UNSUPPORTED', 'Unsupported node config version')] };
    let validator = configValidators.get(key);
    if (!validator) {
      validator = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: `#/$defs/${key}/properties/config`, $defs: definitions });
      configValidators.set(key, validator);
    }
    return validator(value) ? { valid: true, value, issues: [] } : { valid: false, issues: fromAjv(validator.errors) };
  } catch (error) { return { valid: false, issues: [issue('JSON_INVALID', error instanceof Error ? error.message : 'Invalid JSON data')] }; }
}

function issue(code: string, message: string, instancePath = ''): ValidationIssue {
  return { severity: 'error', stage: 'schema', code, message, instancePath };
}

function fromAjv(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).slice(0, 24).map(error => issue('SCHEMA_INVALID', `${error.instancePath || '/'} ${error.message ?? 'does not satisfy the contract'}`, error.instancePath));
}

/** Bound schema compilation and forbid regex execution until a cancellable isolated validator exists. */
function assertSupportedSchema(schema: unknown): void {
  assertJsonData(schema);
  if (JSON.stringify(schema).length > 131072) throw new Error('User schema exceeds 128 KiB');
  let visited = 0;
  const mapKeywords = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
  const singleKeywords = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']);
  const arrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  const root = schema;
  const lookup = (pointer: string): unknown => {
    if (!pointer.startsWith('#/')) throw new Error('Only local JSON Pointer schema references are supported');
    let current: unknown = root;
    for (const raw of pointer.slice(2).split('/')) {
      if (/~(?:[^01]|$)/.test(raw)) throw new Error('Invalid schema JSON Pointer');
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (FORBIDDEN_KEYS.has(key) || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error('Unresolved local schema reference');
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  const walk = (current: unknown, depth: number, references: Set<object>): void => {
    if (++visited > 2000 || depth > 32) throw new Error('User schema complexity limit exceeded');
    if (typeof current === 'boolean') return;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new Error('Expected a JSON Schema object or boolean');
    const record = current as Record<string, unknown>;
    if (Object.hasOwn(record, 'pattern') || Object.hasOwn(record, 'patternProperties')) throw new Error('User regex schemas require an isolated validator and are not supported in this runtime');
    if (Object.hasOwn(record, '$id') || Object.hasOwn(record, '$dynamicRef') || Object.hasOwn(record, '$recursiveRef')) throw new Error('User schema identifier or dynamic reference is not supported');
    if (Object.hasOwn(record, '$ref')) {
      if (typeof record.$ref !== 'string') throw new Error('Schema reference must be a string');
      const target = lookup(record.$ref);
      if (target !== null && typeof target === 'object') {
        if (references.has(target)) throw new Error('Recursive user schema references are not supported');
        const next = new Set(references); next.add(target); walk(target, depth + 1, next);
      } else walk(target, depth + 1, references);
    }
    for (const [key, child] of Object.entries(record)) {
      if (mapKeywords.has(key)) {
        if (child === null || typeof child !== 'object' || Array.isArray(child)) throw new Error(`Invalid schema map: ${key}`);
        if (Object.keys(child).length > 200) throw new Error('Schema map exceeds 200 fields');
        for (const nested of Object.values(child)) walk(nested, depth + 1, references);
      } else if (singleKeywords.has(key)) walk(child, depth + 1, references);
      else if (arrayKeywords.has(key)) {
        if (!Array.isArray(child) || child.length > 20) throw new Error('Schema branch limit exceeded');
        for (const nested of child) walk(nested, depth + 1, references);
      }
    }
  };
  walk(schema, 0, new Set());
  if (!userAjv.validateSchema(schema as object | boolean)) throw new Error('Invalid JSON Schema');
}

function getUserValidator(schema: unknown): ValidateFunction {
  assertSupportedSchema(schema);
  const key = JSON.stringify(schema);
  let validator = userValidators.get(key);
  if (!validator) {
    validator = userAjv.compile(schema as object | boolean);
    if (userValidators.size >= 64) userValidators.delete(userValidators.keys().next().value!);
    userValidators.set(key, validator);
  }
  return validator;
}

/** Validate input/output data with the same bounded, non-coercing contract in web and Runner. */
export function validateJsonValue(schema: unknown, value: unknown): ValidationResult<unknown> {
  try {
    assertJsonData(value);
    const validator = getUserValidator(schema);
    return validator(value) ? { valid: true, value, issues: [] } : { valid: false, issues: fromAjv(validator.errors) };
  } catch (error) {
    return { valid: false, issues: [issue('UNSUPPORTED_SCHEMA_OR_VALUE', error instanceof Error ? error.message : 'Invalid schema or data')] };
  }
}

function embeddedSchemaIssues(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (schema: unknown, path: string, nodeId?: string) => {
    try { getUserValidator(schema); } catch (error) {
      issues.push({ ...issue('UNSUPPORTED_USER_SCHEMA', error instanceof Error ? error.message : 'Unsupported user schema', path), ...(nodeId ? { nodeId } : {}) });
    }
  };
  const flow = (definition: { inputs: unknown; outputs: unknown; nodes: WorkflowNode[] }, prefix: string) => {
    check(definition.inputs, `${prefix}/inputs`); check(definition.outputs, `${prefix}/outputs`);
    definition.nodes.forEach((node, index) => {
      const config = node.config as Record<string, unknown>;
      for (const key of ['schema', 'resultSchema', 'responseSchema']) if (Object.hasOwn(config, key)) check(config[key], `${prefix}/nodes/${index}/config/${key}`, node.id);
      const response = config.responseFormat;
      if (response !== null && typeof response === 'object' && Object.hasOwn(response, 'schema')) check((response as Record<string, unknown>).schema, `${prefix}/nodes/${index}/config/responseFormat/schema`, node.id);
    });
  };
  flow(workflow, '');
  for (const [alias, definition] of Object.entries(workflow.subworkflows)) if (definition) flow(definition, `/subworkflows/${alias}`);
  return issues;
}

/** Validate structure first; graph reachability and runtime availability are separate layers. */
export function validateWorkflowShape(value: unknown): ValidationResult<Workflow> {
  try {
    assertJsonData(value);
    if (!validateWorkflow(value)) return { valid: false, issues: fromAjv(validateWorkflow.errors) };
    const workflow = value as Workflow;
    const issues = embeddedSchemaIssues(workflow);
    return issues.length ? { valid: false, issues } : { valid: true, value: workflow, issues: [] };
  } catch (error) {
    return { valid: false, issues: [issue('JSON_INVALID', error instanceof Error ? error.message : 'Invalid JSON data')] };
  }
}

/** A shape-only node validator is useful for editor operations before the graph is connected. */
export function validateNodeShape(value: unknown): ValidationResult<WorkflowNode> {
  try {
    assertJsonData(value);
    return validateNode(value) ? { valid: true, value: value as WorkflowNode, issues: [] } : { valid: false, issues: fromAjv(validateNode.errors) };
  } catch (error) { return { valid: false, issues: [issue('JSON_INVALID', error instanceof Error ? error.message : 'Invalid JSON data')] }; }
}

/** Reject duplicate keys before casting to a generated Workflow type. */
export function parseWorkflowJson(text: string): ValidationResult<Workflow> {
  try { return validateWorkflowShape(parseStrictJson(text)); }
  catch (error) { return { valid: false, issues: [{ ...issue('JSON_INVALID', error instanceof Error ? error.message : 'Invalid JSON'), stage: 'parse' }] }; }
}
