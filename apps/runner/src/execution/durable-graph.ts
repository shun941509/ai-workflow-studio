import type { FlowDefinition, WorkflowNode } from '@studio/spec';
import { propagateInactiveEdges, resolveNodeActivation, selectControlEdges, type ControlEdgeState, type ControlOutcome, type NodeOutput } from '@studio/workflow-core';
import { RunStore, scopedKey, type EdgeRecord } from '../state/store.js';
import { RunnerError } from '../errors.js';

/** A sequential DAG scheduler uses durable edge decisions, never node-array order or recursive descendant skipping. */
export class DurableGraph {
  private readonly states = new Map<string, string>();
  private readonly edges = new Map<string, EdgeRecord>();
  constructor(private readonly runId: string, private readonly workflow: FlowDefinition, private readonly store: RunStore, private readonly scopeId = 'main') {
    const persisted = store.graphState(runId, scopeId);
    for (const node of persisted.nodes) this.states.set(node.nodeId, node.status);
    for (const edge of persisted.edges) this.edges.set(edge.edgeId, edge);
  }

  next(): WorkflowNode | undefined {
    for (const node of this.workflow.nodes) {
      if (this.states.get(node.id) !== 'pending') continue;
      const activation = resolveNodeActivation({ nodeId: node.id, entryNodeId: this.workflow.entryNodeId,
        incoming: this.workflow.edges.filter((edge) => edge.to.nodeId === node.id).map((edge) => this.edges.get(edge.id)!),
        waitFor: node.type === 'merge' ? 'all_active' : 'single', acceptRecoverableError: node.type === 'error',
      });
      if (activation.state === 'ready') return node;
      if (activation.state !== 'waiting' && activation.state !== 'skipped') throw new RunnerError('UPSTREAM_BLOCKED', '이전 작업이 완료되지 않아 후속 작업을 중단했습니다.');
    }
    return undefined;
  }

  complete(node: WorkflowNode, port: string | undefined, output: NodeOutput | undefined, outcome: 'succeeded' | 'handled_error' = 'succeeded', waitId?: string): void {
    const oldStates = Object.fromEntries([...this.edges].map(([id, edge]) => [id, edge.state])) as Record<string, ControlEdgeState>;
    const chosen = port === undefined ? {} : selectControlEdges(node.id, port, this.workflow.edges);
    const propagated = propagateInactiveEdges(this.workflow, { ...oldStates, ...chosen });
    const changes: EdgeRecord[] = [];
    for (const [edgeId, state] of Object.entries(propagated.edgeStates)) if (state !== oldStates[edgeId]) changes.push({ edgeId, state, ...(state === 'active' ? { outcome: outcome as ControlOutcome } : {}) });
    const skipped = propagated.skippedNodeIds.filter((id) => this.states.get(id) === 'pending');
    this.store.completeGraphStep(this.runId, { nodeId: scopedKey(this.scopeId, node.id), status: outcome, ...(output ? { result: output } : {}), ...(waitId ? { waitId } : {}) }, changes.map((edge) => ({ ...edge, edgeId: scopedKey(this.scopeId, edge.edgeId) })), skipped.map((id) => scopedKey(this.scopeId, id)));
    this.states.set(node.id, outcome); for (const id of skipped) this.states.set(id, 'skipped'); for (const edge of changes) this.edges.set(edge.edgeId, edge);
  }
}
