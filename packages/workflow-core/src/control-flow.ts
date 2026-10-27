import { assertJsonData, type FlowDefinition, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { assertAllowedKeys, assertSafeKey, copyJson, CoreOperationError, requireRecord } from './transform/json.js';

export type ControlEdgeState = 'pending' | 'active' | 'inactive';
export type ControlOutcome = 'succeeded' | 'handled_error' | 'failed' | 'blocked' | 'cancelled';
export interface IncomingControl { edgeId: string; state: ControlEdgeState; outcome?: ControlOutcome }
export interface NodeActivationInput {
  nodeId: string;
  entryNodeId: string;
  incoming: readonly IncomingControl[];
  waitFor?: 'single' | 'all_active';
  acceptRecoverableError?: boolean;
}
export interface NodeActivation {
  state: 'ready' | 'waiting' | 'skipped' | 'failed' | 'blocked' | 'cancelled';
  activeEdgeIds: string[];
  reason?: string;
}

/** Resolve readiness from explicit edge states; inactive branches never count as unfinished predecessors. */
export function resolveNodeActivation(input: NodeActivationInput): NodeActivation {
  assertJsonData(input); assertAllowedKeys(requireRecord(input), ['nodeId', 'entryNodeId', 'incoming', 'waitFor', 'acceptRecoverableError']);
  const { nodeId, entryNodeId, incoming, waitFor = 'single', acceptRecoverableError = false } = input;
  if (typeof nodeId !== 'string' || !nodeId || typeof entryNodeId !== 'string' || !entryNodeId || !Array.isArray(incoming) || incoming.length > 2000 || !['single', 'all_active'].includes(waitFor) || typeof acceptRecoverableError !== 'boolean') throw new CoreOperationError('INVALID_CONTROL_INPUT', 'Invalid node activation input');
  if (nodeId === entryNodeId) {
    if (incoming.length) throw new CoreOperationError('ENTRY_HAS_PREDECESSOR', 'The entry node cannot have incoming control edges');
    return { state: 'ready', activeEdgeIds: [] };
  }
  if (!incoming.length) throw new CoreOperationError('UNCONNECTED_NODE', 'A non-entry node requires a control predecessor');
  if (waitFor === 'single' && incoming.length !== 1) throw new CoreOperationError('MERGE_REQUIRED', 'Multiple control inputs require all_active merge semantics');
  const ids = new Set<string>();
  for (const edge of incoming) {
    assertAllowedKeys(requireRecord(edge), ['edgeId', 'state', 'outcome']);
    if (typeof edge.edgeId !== 'string' || !edge.edgeId || ids.has(edge.edgeId)) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'Incoming edge IDs must be unique strings');
    ids.add(edge.edgeId);
    if (!['pending', 'active', 'inactive'].includes(edge.state)) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'Unknown control edge state');
    if (edge.outcome !== undefined && !['succeeded', 'handled_error', 'failed', 'blocked', 'cancelled'].includes(edge.outcome)) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'Unknown predecessor outcome');
    if (edge.state === 'pending' && edge.outcome !== undefined) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'An undecided edge cannot carry a terminal outcome');
  }
  const active = incoming.filter(edge => edge.state === 'active');
  const activeEdgeIds = active.map(edge => edge.edgeId).sort();
  // Protected failures stop scheduling even when another predecessor remains pending.
  if (active.some(edge => edge.outcome === 'blocked')) return { state: 'blocked', activeEdgeIds, reason: 'UPSTREAM_BLOCKED' };
  if (active.some(edge => edge.outcome === 'cancelled')) return { state: 'cancelled', activeEdgeIds, reason: 'UPSTREAM_CANCELLED' };
  if (active.some(edge => edge.outcome === 'failed')) return { state: 'failed', activeEdgeIds, reason: 'UPSTREAM_FAILED' };
  if (active.some(edge => edge.outcome === 'handled_error') && !acceptRecoverableError) throw new CoreOperationError('INVALID_ERROR_ROUTE', 'Only an explicit error handler may accept a recoverable error token');
  if (incoming.some(edge => edge.state === 'pending') || active.some(edge => edge.outcome === undefined)) return { state: 'waiting', activeEdgeIds };
  return active.length ? { state: 'ready', activeEdgeIds } : { state: 'skipped', activeEdgeIds: [] };
}

/** Mark only this node's outgoing ports; descendants are settled separately to preserve shared joins. */
export function selectControlEdges(nodeId: string, selectedPort: string, edges: readonly WorkflowEdge[]): Record<string, ControlEdgeState> {
  assertJsonData(edges);
  const outgoing = edges.filter(edge => edge.from.nodeId === nodeId);
  const selected = outgoing.filter(edge => edge.from.port === selectedPort);
  if (selected.length !== 1) throw new CoreOperationError(selected.length ? 'PARALLEL_REQUIRED' : 'INVALID_PORT', 'A selected control port requires exactly one outgoing edge');
  const result: Record<string, ControlEdgeState> = Object.create(null) as Record<string, ControlEdgeState>;
  for (const edge of outgoing) {
    assertSafeKey(edge.id);
    if (Object.hasOwn(result, edge.id)) throw new CoreOperationError('DUPLICATE_ID', 'Duplicate control edge ID');
    result[edge.id] = edge.from.port === selectedPort ? 'active' : 'inactive';
  }
  return result;
}

/** Propagate inactivity only when every incoming path is inactive, never by skipping all descendants. */
export function propagateInactiveEdges(flow: Pick<FlowDefinition, 'entryNodeId' | 'nodes' | 'edges'>, initialStates: Readonly<Record<string, ControlEdgeState>>): { edgeStates: Record<string, ControlEdgeState>; skippedNodeIds: string[] } {
  assertJsonData(flow); assertJsonData(initialStates);
  if (flow.nodes.length > 10000 || flow.edges.length > 20000) throw new CoreOperationError('CONTROL_LIMIT', 'Control graph exceeds its pure-evaluation limit');
  const nodeIds = new Set(flow.nodes.map(node => node.id));
  if (nodeIds.size !== flow.nodes.length || !nodeIds.has(flow.entryNodeId)) throw new CoreOperationError('INVALID_CONTROL_GRAPH', 'Duplicate node or missing entry');
  const incoming = new Map(flow.nodes.map(node => [node.id, [] as string[]]));
  const outgoing = new Map(flow.nodes.map(node => [node.id, [] as string[]]));
  const edgeStates: Record<string, ControlEdgeState> = Object.create(null) as Record<string, ControlEdgeState>;
  for (const edge of flow.edges) {
    assertSafeKey(edge.id);
    if (Object.hasOwn(edgeStates, edge.id) || !nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) throw new CoreOperationError('INVALID_CONTROL_GRAPH', 'Duplicate edge or missing endpoint');
    const state = Object.hasOwn(initialStates, edge.id) ? initialStates[edge.id]! : 'pending';
    if (!['pending', 'active', 'inactive'].includes(state)) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'Unknown edge state');
    edgeStates[edge.id] = state;
    incoming.get(edge.to.nodeId)!.push(edge.id); outgoing.get(edge.from.nodeId)!.push(edge.id);
  }
  for (const id of Object.keys(initialStates)) if (!Object.hasOwn(edgeStates, id)) throw new CoreOperationError('INVALID_CONTROL_EDGE', 'A state references a missing edge');
  if (incoming.get(flow.entryNodeId)!.length) throw new CoreOperationError('ENTRY_HAS_PREDECESSOR', 'Entry cannot have incoming edges');
  for (const node of flow.nodes) if (node.id !== flow.entryNodeId && !incoming.get(node.id)!.length) throw new CoreOperationError('UNCONNECTED_NODE', 'A non-entry node has no incoming edge');
  // Each edge is visited at most once after validation; reverse-ordered long chains cannot cause quadratic scans.
  const remaining = new Map([...incoming].map(([nodeId, ids]) => [nodeId, ids.filter(id => edgeStates[id] !== 'inactive').length]));
  const targets = new Map(flow.edges.map(edge => [edge.id, edge.to.nodeId]));
  const queue = flow.nodes.filter(node => node.id !== flow.entryNodeId && remaining.get(node.id) === 0).map(node => node.id);
  const skipped = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const nodeId = queue[index]!;
    if (skipped.has(nodeId)) continue;
    skipped.add(nodeId);
    for (const edgeId of outgoing.get(nodeId)!) {
      if (edgeStates[edgeId] === 'active') throw new CoreOperationError('CONTROL_STATE_CONFLICT', 'An already active edge cannot become inactive');
      if (edgeStates[edgeId] === 'inactive') continue;
      edgeStates[edgeId] = 'inactive';
      const target = targets.get(edgeId)!;
      const count = remaining.get(target)! - 1; remaining.set(target, count);
      if (count === 0 && target !== flow.entryNodeId) queue.push(target);
    }
  }
  return { edgeStates, skippedNodeIds: [...skipped].sort() };
}

export type MergeConfig = Extract<WorkflowNode, { type: 'merge' }>['config'];

/** Merge uses binding-alias order, not task completion timing; collisions never silently overwrite data. */
export function mergeValues(values: Record<string, unknown>, config: MergeConfig): unknown {
  assertJsonData(values); assertJsonData(config); requireRecord(values); assertAllowedKeys(requireRecord(config), ['waitFor', 'combine', 'collision', 'selectKey']);
  if (config.waitFor !== 'all_active' || !['object', 'array', 'select'].includes(config.combine) || !['error', 'namespace'].includes(config.collision)) throw new CoreOperationError('INVALID_MERGE_CONFIG', 'Unsupported merge policy');
  const aliases = Object.keys(values).sort();
  if (!aliases.length) throw new CoreOperationError('NO_ACTIVE_INPUT', 'A merge without active values must be skipped by the scheduler');
  if (config.combine !== 'select' && config.selectKey !== undefined) throw new CoreOperationError('OPTION_NOT_APPLICABLE', 'selectKey is only valid for select merge');
  if (config.combine !== 'object' && config.collision !== 'error') throw new CoreOperationError('OPTION_NOT_APPLICABLE', 'Namespace collision handling only applies to object merge');
  if (config.combine === 'array') return copyJson(aliases.map(alias => values[alias]));
  if (config.combine === 'select') {
    const selected = config.selectKey ?? (aliases.length === 1 ? aliases[0]! : undefined);
    if (selected === undefined) throw new CoreOperationError('AMBIGUOUS_MERGE', 'Select merge requires exactly one active value or an explicit selectKey');
    assertSafeKey(selected);
    if (!Object.hasOwn(values, selected)) throw new CoreOperationError('MERGE_SELECTION_MISSING', 'The selected merge input is not available');
    return copyJson(values[selected]);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const alias of aliases) {
    assertSafeKey(alias);
    if (config.collision === 'namespace') { result[alias] = values[alias]; continue; }
    const source = requireRecord(values[alias], 'MERGE_TYPE');
    for (const [key, value] of Object.entries(source)) {
      assertSafeKey(key);
      if (Object.hasOwn(result, key)) throw new CoreOperationError('MERGE_COLLISION', `Merge would overwrite field: ${key}`);
      result[key] = value;
    }
  }
  return copyJson(result);
}
