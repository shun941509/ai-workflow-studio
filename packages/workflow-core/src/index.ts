import { canonicalize } from 'json-canonicalize';
import { validateCompletionSemantics } from './completion.js';
import { validateWorkDefinitionSemantics } from './work-definition.js';
import { validateWorkingContextSemantics } from './working-context.js';
export { validateWorkingContextSemantics, applyWorkingContextPreset, removeWorkingContextPreset, workingTaskContext, workingContextAttachments } from './working-context.js';
export { validateWorkDefinitionSemantics } from './work-definition.js';
export { validateCompletionSemantics, evaluateCompletion } from './completion.js';
export type { CompletionNodeEvidence, CompletionAssessment } from './completion.js';
import {
  assertJsonData, FORBIDDEN_KEYS, getNodeDefinition, validateJsonValue, validateWorkflowShape,
  type Binding, type FileRef, type FlowDefinition, type FlowRef, type ValidationIssue, type Workflow, type WorkflowNode,
} from '@studio/spec';

/** Execution envelopes carry data separately from Runner-owned evidence and artifact references. */
export interface NodeOutput { data: unknown; text?: string; files?: FileRef[]; sources?: unknown[]; effects?: unknown[] }
export interface BindingScope {
  workflowInput: unknown;
  nodeOutputs: Record<string, NodeOutput>;
  resources?: Record<string, unknown>;
  error?: unknown;
}
export class ContractError extends Error {
  constructor(readonly code: string, message: string, readonly instancePath = '', readonly nodeId?: string) {
    super(message); this.name = 'ContractError';
  }
}

const missing = Symbol('missing');

/** JSON Pointer only reads own JSON properties; it never walks the JavaScript prototype chain. */
export function readJsonPointer(root: unknown, pointer: string): unknown | typeof missing {
  if (pointer === '') return root === undefined ? missing : root;
  if (!pointer.startsWith('/')) throw new ContractError('INVALID_POINTER', 'JSON Pointer must be empty or start with /');
  let current = root;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(raw)) throw new ContractError('INVALID_POINTER', 'Invalid JSON Pointer escape');
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (FORBIDDEN_KEYS.has(key)) throw new ContractError('UNSAFE_POINTER', 'Prototype properties cannot be referenced');
    if (current === null || typeof current !== 'object') return missing;
    if (Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/.test(key)) return missing;
    if (!Object.hasOwn(current, key)) return missing;
    const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
    if (!Object.hasOwn(descriptor, 'value')) throw new ContractError('UNSAFE_POINTER', 'Accessor properties cannot be referenced');
    current = descriptor.value;
  }
  return current === undefined ? missing : current;
}

/** Missing/null/omit are distinct; handlers receive copies so they cannot mutate completed predecessors. */
export function resolveBindings(node: WorkflowNode, scope: BindingScope): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, binding] of Object.entries(node.inputBindings)) {
    if (!binding) continue;
    if (FORBIDDEN_KEYS.has(name)) throw new ContractError('UNSAFE_BINDING', 'Prototype binding key is forbidden', `/inputBindings/${name}`, node.id);
    let resolved: unknown | typeof missing;
    if (binding.from === 'literal') resolved = binding.value;
    else {
      let root: unknown;
      switch (binding.from) {
        case 'workflowInput': root = scope.workflowInput; break;
        case 'node': root = Object.hasOwn(scope.nodeOutputs, binding.nodeId) ? scope.nodeOutputs[binding.nodeId] : undefined; break;
        case 'resource': root = scope.resources && Object.hasOwn(scope.resources, binding.resource) ? scope.resources[binding.resource] : undefined; break;
        case 'error':
          if (node.type !== 'error') throw new ContractError('INVALID_ERROR_BINDING', 'Only an error handler can reference error context', `/inputBindings/${name}`, node.id);
          root = scope.error; break;
      }
      resolved = readJsonPointer(root, binding.pointer);
      if (resolved === missing) {
        if (binding.onMissing === 'omit') continue;
        if (binding.onMissing === 'default') resolved = binding.defaultValue;
        else throw new ContractError('BINDING_MISSING', `Required input is missing: ${name}`, `/inputBindings/${name}`, node.id);
      }
    }
    assertJsonData(resolved);
    result[name] = structuredClone(resolved);
  }
  const definition = getNodeDefinition(node.type, node.typeVersion)!;
  const validation = validateJsonValue({ ...definition.inputSchema, required: requiredInputFields(node) }, result);
  if (!validation.valid) throw new ContractError('NODE_INPUT_INVALID', validation.issues[0]?.message ?? 'Node input is invalid', '/inputBindings', node.id);
  return result;
}

function diagnostic(code: string, message: string, path: string, nodeId?: string): ValidationIssue {
  return { severity: 'error', stage: 'semantic', code, message, instancePath: path, ...(nodeId ? { nodeId } : {}) };
}

/** Child references are extracted from typed contract fields, never from arbitrary literal user data. */
function flowReferences(node: WorkflowNode): FlowRef[] {
  switch (node.type) {
    case 'subworkflow': return [node.config.flowRef];
    case 'loop': return [node.config.bodyFlowRef];
    case 'candidate_search': return [node.config.generatorFlowRef];
    case 'parallel': return node.config.branches.map(branch => branch.flowRef);
    case 'agent_team': return [...node.config.members.map(member => member.flowRef), ...(node.config.integrationFlowRef ? [node.config.integrationFlowRef] : [])];
    case 'orchestrator': return node.config.allowedFlows;
    case 'agent': return node.config.retrievalPolicy?.clarificationFlowRef ? [node.config.retrievalPolicy.clarificationFlowRef] : [];
    default: return [];
  }
}

function modelReferences(node: WorkflowNode): string[] {
  const result: string[] = [];
  const config = node.config as Record<string, unknown>;
  if (typeof config.modelProfile === 'string') result.push(config.modelProfile);
  if (node.type === 'retrieval' && node.config.reranker) result.push(node.config.reranker.modelProfile);
  if (node.type === 'knowledge' && node.config.indexSettings) {
    for (const key of ['embeddingProfile', 'graphExtractionProfile', 'graphSummaryProfile'] as const) {
      const profile = node.config.indexSettings[key]; if (profile) result.push(profile);
    }
  }
  return result;
}

function resourceReferences(node: WorkflowNode): string[] {
  const result = node.attachments.map(attachment => attachment.resource);
  for (const binding of Object.values(node.inputBindings)) if (binding?.from === 'resource') result.push(binding.resource);
  if (node.type === 'resource' || node.type === 'skill') result.push(node.config.resource);
  if (node.type === 'program') result.push(node.config.codeRef.resource);
  if (node.type === 'tool' && node.config.tool.kind === 'mcp') result.push(node.config.tool.connection);
  if (node.type === 'agent') for (const tool of node.config.toolAllowlist) if (tool.kind === 'mcp') result.push(tool.connection);
  return result;
}

function successPorts(node: WorkflowNode): string[] {
  if (node.type === 'error' && node.config.mode === 'rethrow') return [];
  if (node.type === 'classify') return [...node.config.labels.map(label => label.id), 'unclassified'];
  return getNodeDefinition(node.type)!.controlPorts.outputs;
}

/** Mode-specific required inputs are shared by static wiring checks and actual bound-input validation. */
function requiredInputFields(node: WorkflowNode): string[] {
  const required = [...(getNodeDefinition(node.type)!.inputSchema.required as string[])];
  if (node.type === 'retrieval' && node.config.mode !== 'web') required.push('index');
  if (node.type === 'knowledge') required.push(['build', 'update'].includes(node.config.operation) ? 'documents' : 'index');
  if (node.type === 'memory' && node.config.operation === 'put') required.push('value');
  if (node.type === 'file_output') required.push(node.config.format === 'copy' ? 'file' : 'content');
  if (node.type === 'loop') required.push(node.config.mode === 'foreach' ? 'items' : 'state');
  return required;
}

/** Return true only when the declared schema proves a pointer cannot exist; unknown shapes stay runtime-checked. */
function pointerImpossible(schema: unknown, pointer: string): boolean {
  if (!pointer) return false;
  let current = schema;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === true || current === undefined) return false;
    if (current === false) return true;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
    const contract = current as Record<string, unknown>;
    if (contract.$ref || contract.anyOf || contract.oneOf || contract.allOf) return false;
    if (contract.type === 'object') {
      const properties = contract.properties as Record<string, unknown> | undefined;
      if (properties && Object.hasOwn(properties, key)) current = properties[key];
      else if (contract.additionalProperties === false) return true;
      else current = contract.additionalProperties;
    } else if (contract.type === 'array') {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return true;
      current = contract.items;
    } else if (typeof contract.type === 'string') return true;
    else return false;
  }
  return false;
}

function outputContract(node: WorkflowNode, flow: FlowDefinition): unknown {
  let data: unknown = true;
  if (node.type === 'input') data = flow.inputs;
  if (node.type === 'output') data = flow.outputs;
  if (node.type === 'ai') data = node.config.responseFormat.mode === 'text' ? { type: 'string' } : node.config.responseFormat.schema;
  return { type: 'object', properties: { data, text: { type: 'string' }, files: { type: 'array' }, sources: { type: 'array' }, effects: { type: 'array' } }, additionalProperties: false };
}

/** Schema validation cannot prove graph reachability, dominance, resource existence, or recursion safety. */
export function analyzeWorkflow(workflow: Workflow): ValidationIssue[] {
  const shape = validateWorkflowShape(workflow);
  if (!shape.valid) return shape.issues;
  const issues: ValidationIssue[] = [];
  const flows = new Map<string, FlowDefinition>([['main', workflow]]);
  if (Object.hasOwn(workflow.subworkflows, 'main')) issues.push(diagnostic('RESERVED_FLOW_ID', 'main is reserved for the root flow', '/subworkflows/main'));
  for (const [alias, flow] of Object.entries(workflow.subworkflows)) if (flow && alias !== 'main') flows.set(alias, flow);
  const calls = new Map<string, Set<string>>();
  for (const [flowId, flow] of flows) {
    const prefix = flowId === 'main' ? '' : `/subworkflows/${flowId}`;
    const nodes = new Map<string, WorkflowNode>();
    const indexes = new Map<string, number>();
    flow.nodes.forEach((node, index) => {
      if (nodes.has(node.id)) issues.push(diagnostic('DUPLICATE_ID', `Duplicate node ID: ${node.id}`, `${prefix}/nodes/${index}/id`, node.id));
      nodes.set(node.id, node); indexes.set(node.id, index);
    });
    const nodePath = (id: string) => `${prefix}/nodes/${indexes.get(id) ?? 0}`;
    const entry = nodes.get(flow.entryNodeId);
    if (!entry) issues.push(diagnostic('ENTRY_NOT_FOUND', 'Entry node does not exist', `${prefix}/entryNodeId`));
    const starters = flow.nodes.filter(node => node.type === 'input' || node.type === 'trigger' || (node.type === 'form' && node.config.mode === 'initial'));
    if (starters.length !== 1 || starters[0]?.id !== flow.entryNodeId) issues.push(diagnostic('INVALID_ENTRY', 'Each flow requires exactly one input, initial form, or trigger entry', `${prefix}/entryNodeId`));
    const outputs = flow.nodes.filter(node => node.type === 'output');
    if (outputs.length !== 1) issues.push(diagnostic('INVALID_OUTPUT_COUNT', 'Each flow requires exactly one output node', `${prefix}/nodes`));
    const incoming = new Map(flow.nodes.map(node => [node.id, [] as string[]]));
    const outgoing = new Map(flow.nodes.map(node => [node.id, [] as string[]]));
    const portCounts = new Map<string, number>();
    const edgeIds = new Set<string>();
    flow.edges.forEach((edge, index) => {
      const path = `${prefix}/edges/${index}`;
      if (edgeIds.has(edge.id)) issues.push(diagnostic('DUPLICATE_ID', `Duplicate edge ID: ${edge.id}`, `${path}/id`));
      edgeIds.add(edge.id);
      const source = nodes.get(edge.from.nodeId); const target = nodes.get(edge.to.nodeId);
      if (!source || !target) { issues.push(diagnostic('INVALID_EDGE', 'Edge references a missing node', path)); return; }
      const ports = [...successPorts(source), ...(source.execution.onError === 'route' ? ['error'] : [])];
      if (!ports.includes(edge.from.port) || edge.to.port !== 'in') issues.push(diagnostic('INVALID_PORT', 'Edge references an unavailable control port', path));
      if (edge.from.port === 'error' && target.type !== 'error') issues.push(diagnostic('INVALID_ERROR_ROUTE', 'An error port must enter an error handler', path));
      incoming.get(target.id)!.push(source.id); outgoing.get(source.id)!.push(target.id);
      const key = `${source.id}:${edge.from.port}`; portCounts.set(key, (portCounts.get(key) ?? 0) + 1);
    });
    for (const node of flow.nodes) {
      const path = nodePath(node.id);
      const predecessors = incoming.get(node.id)!;
      if (node.id === flow.entryNodeId && predecessors.length) issues.push(diagnostic('ENTRY_HAS_PREDECESSOR', 'Entry cannot have incoming edges', path, node.id));
      if (node.type !== 'merge' && predecessors.length > 1) issues.push(diagnostic('MERGE_REQUIRED', 'Multiple incoming paths require an explicit merge node', path, node.id));
      for (const port of successPorts(node)) {
        const count = portCounts.get(`${node.id}:${port}`) ?? 0;
        if (count !== 1) issues.push(diagnostic(count ? 'PARALLEL_REQUIRED' : 'UNCONNECTED_PORT', `Control port ${port} requires exactly one connection`, path, node.id));
      }
      if (node.execution.onError === 'route' && (portCounts.get(`${node.id}:error`) ?? 0) !== 1) issues.push(diagnostic('INVALID_ERROR_ROUTE', 'Routed errors require one error connection', path, node.id));
      if (node.type === 'output' && node.execution.onError === 'route') issues.push(diagnostic('INVALID_ERROR_ROUTE', 'Final output validation cannot route back into the same flow', path, node.id));
      if (node.type === 'classify') {
        const labels = node.config.labels.map(label => label.id);
        if (new Set(labels).size !== labels.length || labels.some(label => ['in', 'next', 'error', 'unclassified'].includes(label))) issues.push(diagnostic('INVALID_LABELS', 'Classification labels must be unique and cannot use reserved ports', `${path}/config/labels`, node.id));
      }
      const definition = getNodeDefinition(node.type)!;
      const required = requiredInputFields(node);
      const properties = definition.inputSchema.properties as Record<string, unknown>;
      for (const field of required) if (!Object.hasOwn(node.inputBindings, field)) issues.push(diagnostic('INPUT_BINDING_REQUIRED', `Required input binding: ${field}`, `${path}/inputBindings`, node.id));
      for (const field of Object.keys(node.inputBindings)) if (node.type !== 'merge' && !Object.hasOwn(properties, field)) issues.push(diagnostic('UNKNOWN_INPUT_BINDING', `Unsupported input field: ${field}`, `${path}/inputBindings/${field}`, node.id));
      for (const [field, binding] of Object.entries(node.inputBindings)) if (binding?.from === 'literal' && Object.hasOwn(properties, field) && !validateJsonValue(properties[field], binding.value).valid) issues.push(diagnostic('INPUT_TYPE_MISMATCH', `Literal input does not satisfy ${field}`, `${path}/inputBindings/${field}`, node.id));
      for (const alias of modelReferences(node)) if (!Object.hasOwn(workflow.modelProfiles, alias)) issues.push(diagnostic('MODEL_PROFILE_NOT_FOUND', `Model profile is not declared: ${alias}`, `${path}/config`, node.id));
      const requireModelKind = (alias: string | undefined, kind: 'chat' | 'embedding' | 'reranker') => {
        if (alias && workflow.modelProfiles[alias] && workflow.modelProfiles[alias]!.kind !== kind) issues.push(diagnostic('MODEL_PROFILE_KIND_MISMATCH', `Model profile ${alias} must have kind ${kind}`, `${path}/config`, node.id));
      };
      const config = node.config as Record<string, unknown>;
      if (typeof config.modelProfile === 'string') requireModelKind(config.modelProfile, 'chat');
      if (node.type === 'retrieval') requireModelKind(node.config.reranker?.modelProfile, 'reranker');
      if (node.type === 'knowledge') {
        requireModelKind(node.config.indexSettings?.embeddingProfile, 'embedding');
        requireModelKind(node.config.indexSettings?.graphExtractionProfile, 'chat');
        requireModelKind(node.config.indexSettings?.graphSummaryProfile, 'chat');
      }
      for (const alias of resourceReferences(node)) if (!Object.hasOwn(workflow.resources, alias)) issues.push(diagnostic('RESOURCE_NOT_FOUND', `Resource is not declared: ${alias}`, `${path}/attachments`, node.id));
      const refs = flowReferences(node);
      if (!calls.has(flowId)) calls.set(flowId, new Set());
      for (const reference of refs) if (reference.kind === 'local') {
        if (!flows.has(reference.flowId)) issues.push(diagnostic('FLOW_NOT_FOUND', `Child flow is not declared: ${reference.flowId}`, `${path}/config`, node.id));
        else calls.get(flowId)!.add(reference.flowId);
      }
      if (node.type === 'agent' && node.config.retrievalPolicy?.onInsufficient === 'ask' && !node.config.retrievalPolicy.clarificationFlowRef) issues.push(diagnostic('CLARIFICATION_FLOW_REQUIRED', 'Asking for clarification requires an explicit form flow', `${path}/config/retrievalPolicy`, node.id));
      if (node.type === 'knowledge' && node.config.indexSettings && node.config.indexSettings.chunkOverlap >= node.config.indexSettings.chunkSize) issues.push(diagnostic('INVALID_CHUNK_OVERLAP', 'Chunk overlap must be smaller than chunk size', `${path}/config/indexSettings`, node.id));
      if (node.type === 'program' && /(^[A-Za-z]:|^\/|\\|(^|\/)\.\.(\/|$))/.test(node.config.codeRef.path)) issues.push(diagnostic('UNSAFE_CODE_PATH', 'Code reference must stay inside its resource', `${path}/config/codeRef/path`, node.id));
    }
    // A bounded traversal is used even for malformed cyclic input so diagnostics cannot hang.
    const reachable = (from: string, to?: string): Set<string> => {
      const seen = new Set<string>(); const pending = [from];
      while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id); if (id === to) break; pending.push(...(outgoing.get(id) ?? [])); }
      return seen;
    };
    const reached = reachable(flow.entryNodeId);
    for (const node of flow.nodes) if (!reached.has(node.id)) issues.push(diagnostic('UNREACHABLE_NODE', 'Node is not reachable from the entry', nodePath(node.id), node.id));
    const degrees = new Map([...incoming].map(([id, predecessors]) => [id, predecessors.length]));
    const queue = [...degrees].filter(([, count]) => count === 0).map(([id]) => id); const sorted: string[] = [];
    while (queue.length) { const id = queue.shift()!; sorted.push(id); for (const next of outgoing.get(id) ?? []) { degrees.set(next, degrees.get(next)! - 1); if (degrees.get(next) === 0) queue.push(next); } }
    if (sorted.length !== nodes.size) issues.push(diagnostic('CYCLE_DETECTED', 'Control cycles must use a loop block', `${prefix}/edges`));
    const dominators = new Map<string, Set<string>>();
    for (const id of sorted) {
      const parents = incoming.get(id)!;
      let common = new Set<string>();
      if (parents.length) {
        common = new Set(dominators.get(parents[0]!) ?? []);
        for (const parent of parents.slice(1)) for (const ancestor of common) if (!dominators.get(parent)?.has(ancestor)) common.delete(ancestor);
      }
      common.add(id); dominators.set(id, common);
    }
    for (const node of flow.nodes) for (const [name, binding] of Object.entries(node.inputBindings)) {
      if (!binding) continue;
      const path = `${nodePath(node.id)}/inputBindings/${name}`;
      if (binding.from === 'error' && node.type !== 'error') issues.push(diagnostic('INVALID_ERROR_BINDING', 'Error context is only available in an error handler', path, node.id));
      if (binding.from === 'workflowInput' && binding.onMissing === 'error' && pointerImpossible(flow.inputs, binding.pointer)) issues.push(diagnostic('BINDING_PATH_NOT_FOUND', 'Workflow input schema excludes this pointer', path, node.id));
      if (binding.from !== 'node') continue;
      const source = nodes.get(binding.nodeId);
      if (!source) { issues.push(diagnostic('BINDING_NODE_NOT_FOUND', 'Binding source does not exist in this flow', path, node.id)); continue; }
      if (source.id === node.id || !reachable(source.id).has(node.id)) { issues.push(diagnostic('BINDING_NOT_PREDECESSOR', 'Binding source must precede this node', path, node.id)); continue; }
      if (binding.onMissing === 'error' && pointerImpossible(outputContract(source, flow), binding.pointer)) issues.push(diagnostic('BINDING_PATH_NOT_FOUND', 'Source result contract excludes this pointer', path, node.id));
      if (binding.onMissing === 'error' && !dominators.get(node.id)?.has(source.id)) issues.push(diagnostic('BINDING_NOT_AVAILABLE', 'A required source may be skipped on another active branch', path, node.id));
      if (binding.onMissing === 'error') {
        const errorTargets = flow.edges.filter(edge => edge.from.nodeId === source.id && edge.from.port === 'error').map(edge => edge.to.nodeId);
        if (errorTargets.some(target => reachable(target).has(node.id))) issues.push(diagnostic('BINDING_NOT_AVAILABLE', 'The source may have failed on a route reaching this node', path, node.id));
      }
    }
  }
  // Topological child-call validation avoids exponential recursion through shared child definitions.
  const callDegrees = new Map([...flows.keys()].map(id => [id, 0]));
  for (const children of calls.values()) for (const child of children) callDegrees.set(child, callDegrees.get(child)! + 1);
  const ready = [...callDegrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  const depths = new Map([...flows.keys()].map(id => [id, 0]));
  let processed = 0;
  while (ready.length) {
    const id = ready.shift()!; processed += 1;
    for (const child of calls.get(id) ?? []) {
      depths.set(child, Math.max(depths.get(child)!, depths.get(id)! + 1));
      callDegrees.set(child, callDegrees.get(child)! - 1);
      if (callDegrees.get(child) === 0) ready.push(child);
    }
  }
  if (processed !== flows.size) issues.push(diagnostic('FLOW_RECURSION', 'Recursive child flows are not supported', '/subworkflows'));
  if ([...depths.values()].some(depth => depth > workflow.policy.limits.maxChildDepth)) issues.push(diagnostic('FLOW_DEPTH_EXCEEDED', 'Child flow nesting exceeds the declared limit', '/subworkflows'));
  issues.push(...validateCompletionSemantics(workflow));
  issues.push(...validateWorkDefinitionSemantics(workflow));
  issues.push(...validateWorkingContextSemantics(workflow));
  return issues;
}

export const validateWorkflowSemantics = analyzeWorkflow;

export interface WorkflowRequirements { capabilities: string[]; modelProfiles: string[]; resourceAliases: string[] }

/** Requirements are derived from all packaged definitions; a manifest cannot claim fewer capabilities. */
export function collectRequirements(workflow: Workflow): WorkflowRequirements {
  const capabilities = new Set<string>(); const models = new Set<string>(); const resources = new Set<string>();
  // Older Runners must reject an acceptance-aware package instead of silently dropping its business contract.
  if (workflow.completion) capabilities.add('workflow.completion@1');
  if (workflow.workDefinition) capabilities.add('workflow.work_definition@1');
  if (workflow.workDefinition?.harness.workingContext) capabilities.add('workflow.working_context@1');
  // Task references remain pinned even when excluded from this request's context. Selection controls disclosure,
  // not package ownership; deleting a node attachment must not orphan the declared optional-asset provenance.
  if (workflow.workDefinition) for (const asset of [...workflow.workDefinition.task.assets, ...workflow.workDefinition.task.skills]) resources.add(asset.alias);
  // Included Skill resources are validated and exposed as instruction bundles, even through generic bindings.
  if (Object.values(workflow.resources).some(resource => resource?.kind === 'skill')) capabilities.add('skill.instructions@1');
  const flows = [workflow, ...Object.values(workflow.subworkflows).filter((flow): flow is FlowDefinition => Boolean(flow))];
  for (const flow of flows) for (const node of flow.nodes) {
    capabilities.add(`node.${node.type}@${node.typeVersion}`);
    for (const alias of modelReferences(node)) models.add(alias);
    for (const alias of resourceReferences(node)) resources.add(alias);
    if (node.type === 'retrieval') {
      capabilities.add(`retrieval.${node.config.mode}@1`);
      if (node.config.reranker) { capabilities.add('retrieval.rerank@1'); capabilities.add('reranker.openai_responses_v1@1'); }
    }
    if (node.type === 'agent' && node.config.strategy === 'agentic_rag') {
      capabilities.add('agent.agentic_rag@1'); capabilities.add('agentic_rag.keyword@1');
      capabilities.add(`agentic_rag.${node.config.retrievalPolicy?.onInsufficient ?? 'invalid'}@1`);
    }
    if (node.type === 'agent' && node.config.strategy === 'task') {
      // A single model response does not imply iterative planning or permission to invoke tools.
      capabilities.add('agent.task@1');
      capabilities.add(`agent.${node.config.maxSteps === 1 ? 'single_step' : 'multi_step'}@1`);
      if (node.config.toolAllowlist.length) capabilities.add('agent.tools@1');
    }
    if (node.type === 'knowledge') {
      // Index operations and storage scope are separate contracts; build support does not grant deletion.
      capabilities.add(`knowledge.${node.config.operation}@1`);
      if (node.config.indexSettings) capabilities.add(`knowledge.${node.config.indexSettings.kind}@1`);
      if (['local-run-keyword-v1', 'local-run-embedding-v1'].includes(node.config.profile ?? '')) capabilities.add('rag.run_local@1');
      if (node.config.profile === 'local-run-embedding-v1') capabilities.add('embedding.openai_small_256@1');
    }
    if (node.type === 'skill') capabilities.add(`skill.${node.config.mode}@1`);
    if (node.type === 'ai' && node.attachments.some(attachment => attachment.role === 'skill')) capabilities.add('skill.instructions@1');
    // Mode requirements prevent a rules-only evaluator from claiming model evaluation support.
    if (node.type === 'evaluate') capabilities.add(`evaluate.${node.config.mode}@1`);
    if (node.type === 'program') capabilities.add(`worker.${node.config.workerProfile}@1`);
    // A fixed verifier and tree support never imply graph traversal or arbitrary verifier execution.
    if (node.type === 'candidate_search') { capabilities.add(`candidate_search.${node.config.mode}@1`); capabilities.add(`verifier.${node.config.verifierId}@1`); }
    // Trusted builtin identities are versioned independently; node.tool alone never enables an external MCP server.
    if (node.type === 'tool') capabilities.add(node.config.tool.kind === 'builtin' ? `tool.builtin.${node.config.tool.id}@${node.config.tool.version}` : 'tool.mcp@1');
    if (node.type === 'parallel') capabilities.add(`parallel.${node.config.mode}@1`);
    // Child modes are explicit so supporting local bounded flows cannot imply arbitrary packaged recursion.
    for (const ref of flowReferences(node)) capabilities.add(`flow.${ref.kind}@1`);
    if (node.type === 'loop') capabilities.add(`loop.${node.config.mode}@1`);
    if (node.type === 'file_output') capabilities.add(`file_output.${node.config.format}@1`);
    if (node.type === 'document_extract') {
      capabilities.add(`document_extract.${node.config.mode}@1`);
      capabilities.add(node.config.workerProfile ? `worker.${node.config.workerProfile}@1` : 'document_extract.builtin_utf8@1');
    }
    if (node.type === 'memory') capabilities.add(`memory.${node.config.scope}@1`);
    if (node.type === 'agent_team') capabilities.add(`agent_team.${node.config.mode}@1`);
    if (node.type === 'orchestrator') capabilities.add(`orchestrator.${node.config.mode}@1`);
  }
  return { capabilities: [...capabilities].sort(), modelProfiles: [...models].sort(), resourceAliases: [...resources].sort() };
}

export interface ResolvedPlan {
  schemaVersion: '1.0.0'; planRevision: 1; planHash: string;
  workflow: Workflow; verifiedDependencies: Record<string, unknown>; runtimeBindings: Record<string, unknown>; requirements: WorkflowRequirements;
}

function rejectSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectSecrets); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (['apikey', 'password', 'secret', 'accesstoken', 'refreshtoken', 'authorization', 'privatekey'].includes(normalized)) throw new ContractError('SECRET_IN_PLAN', 'Resolved plans cannot contain secret fields');
    rejectSecrets(item);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

/** Hash immutable, non-secret execution inputs with JCS and WebCrypto, preserving browser compatibility. */
export async function createResolvedPlan(workflow: Workflow, verifiedDependencies: Record<string, unknown>, runtimeBindings: Record<string, unknown>): Promise<ResolvedPlan> {
  const issues = analyzeWorkflow(workflow);
  if (issues.some(item => item.severity === 'error')) throw new ContractError('WORKFLOW_INVALID', issues[0]!.message, issues[0]!.instancePath, issues[0]!.nodeId);
  assertJsonData(verifiedDependencies); assertJsonData(runtimeBindings);
  rejectSecrets(verifiedDependencies); rejectSecrets(runtimeBindings);
  const bindings = runtimeBindings.modelProfiles;
  if (bindings !== undefined) {
    if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) throw new ContractError('INVALID_MODEL_BINDINGS', 'Model bindings must be an object');
    for (const alias of Object.keys(bindings)) if (!Object.hasOwn(workflow.modelProfiles, alias)) throw new ContractError('INVALID_MODEL_BINDINGS', `Unknown model profile: ${alias}`);
  }
  const requirements = collectRequirements(workflow);
  for (const alias of requirements.modelProfiles) {
    const binding = bindings && typeof bindings === 'object' ? (bindings as Record<string, unknown>)[alias] : undefined;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new ContractError('MODEL_BINDING_REQUIRED', `Resolve model profile before creating a plan: ${alias}`);
    const model = binding as Record<string, unknown>;
    if (typeof model.provider !== 'string' || !model.provider || typeof model.model !== 'string' || !model.model) throw new ContractError('MODEL_BINDING_REQUIRED', `Resolved model profile requires provider and model: ${alias}`);
  }
  const body = structuredClone({ schemaVersion: '1.0.0' as const, planRevision: 1 as const, workflow, verifiedDependencies, runtimeBindings, requirements });
  const bytes = new TextEncoder().encode(canonicalize(body));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const planHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return freezeDeep({ ...body, planHash });
}

// Pure P3 foundations do not install handlers or advertise new Runner capabilities.
export { validateExpression, evaluateExpression, evaluateCondition, classifyByRules, evaluateRules } from './expressions.js';
export type { Expression, ClassificationRule, RuleClassification, EvaluationRule, RulesEvaluation } from './expressions.js';
export { applyTransform, validateTransformSteps } from './transform/operations.js';
export type { TransformStep } from './transform/operations.js';
export { CoreOperationError } from './transform/json.js';
export { validateGuardrail } from './guardrail.js';
export { validateArtifactFilename, validateManagedOutput, validateTaskAgent, validateAgenticRag, validateTextExtraction, validateRunRagNode } from './operational-modes.js';
export { resolveNodeActivation, selectControlEdges, propagateInactiveEdges, mergeValues } from './control-flow.js';
export type { ControlEdgeState, ControlOutcome, IncomingControl, NodeActivationInput, NodeActivation, MergeConfig } from './control-flow.js';
