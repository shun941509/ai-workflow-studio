import { canonicalize } from 'json-canonicalize';
import { createNode, validateWorkDefinitionDeclaration, validateWorkflowShape, type JsonValue, type ValidationIssue, type Workflow, type WorkflowNode } from '@studio/spec';

/** Only shared business metadata becomes context. No credentials, personal connection or session value is copied. */
export function workingTaskContext(workflow: Workflow): JsonValue {
  const definition = workflow.workDefinition;
  if (!definition) throw new Error('업무 정의가 필요합니다.');
  return structuredClone({ definition: { id: definition.id, revision: definition.revision }, card: definition.card, role: definition.role,
    task: { id: definition.task.id, title: definition.task.title, goal: definition.task.goal, criterionIds: definition.task.criterionIds } });
}

/** Selected instruction roles remain explicit; document/template data never acquires instruction authority. */
export function workingContextAttachments(workflow: Workflow): WorkflowNode['attachments'] {
  const definition = workflow.workDefinition;
  if (!definition) throw new Error('업무 정의가 필요합니다.');
  const links = [...definition.task.assets, ...definition.task.skills];
  return definition.harness.selectedContext.map(alias => {
    const link = links.find(value => value.alias === alias);
    if (!link) throw new Error('Task에 선언하지 않은 문맥 자료입니다.');
    return { resource: alias, role: link.kind === 'skill' ? 'skill' : link.kind === 'instruction' ? 'instructions' : 'reference' };
  });
}

/** Context is an opt-in root preset, not a new node or a general information-flow security proof. */
export function validateWorkingContextSemantics(workflow: Workflow): ValidationIssue[] {
  const definition = workflow.workDefinition;
  if (!definition?.harness.workingContext) return [];
  const shape = validateWorkDefinitionDeclaration(definition); if (!shape.valid) return shape.issues;
  const specification = definition.harness.workingContext, issues: ValidationIssue[] = [];
  const add = (code: string, message: string, index?: number, nodeId?: string) => issues.push({ severity: 'error' as const, stage: 'working-context', code, message,
    instancePath: `/workDefinition/harness/workingContext${index === undefined ? '' : `/bindings/${index}`}`, ...(nodeId ? { nodeId } : {}) });
  const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
  const mapped = specification.bindings.map(binding => binding.nodeId);
  if (new Set(mapped).size !== mapped.length || mapped.length !== definition.harness.perform.length || !mapped.every(id => definition.harness.perform.includes(id))) add('WORK_CONTEXT_PERFORM_MISMATCH', '문맥 매핑은 전체 업무 수행 블록을 정확히 한 번씩 포함해야 합니다.');
  if (new Set(specification.bindings.map(binding => binding.contextNodeId)).size !== specification.bindings.length) add('WORK_CONTEXT_DUPLICATE', '수행 블록마다 별도의 문맥 구성 블록을 지정하세요.');
  let expected: WorkflowNode['attachments'];
  try { expected = workingContextAttachments(workflow); } catch { add('WORK_CONTEXT_SELECTION_INVALID', '선택한 업무 자료 선언을 확인하세요.'); return issues; }
  const root = (id: string) => { const values = workflow.nodes.filter(node => node.id === id); return values.length === 1 ? values[0] : undefined; };
  for (const [index, binding] of specification.bindings.entries()) {
    const node = root(binding.nodeId), context = root(binding.contextNodeId);
    if (!node || !(node.type === 'ai' || node.type === 'agent' && node.config.strategy === 'task' && node.config.maxSteps === 1)) { add('WORK_CONTEXT_NODE_UNSUPPORTED', '업무 문맥은 기본 흐름의 AI 작업 또는 단일 작업 에이전트에 연결하세요.', index, binding.nodeId); continue; }
    if (!context || context.type !== 'merge' || !same(context.config, { waitFor: 'all_active', combine: 'object', collision: 'namespace' }) || !definition.harness.context.includes(context.id)) { add('WORK_CONTEXT_MERGE_INVALID', '문맥 역할의 이름별 묶기 블록을 연결하세요.', index, binding.nodeId); continue; }
    const request = context.inputBindings.request;
    if (!same(Object.keys(context.inputBindings).sort(), ['businessTask', 'request']) || !same(context.inputBindings.businessTask, { from: 'literal', value: workingTaskContext(workflow) }) || !request || request.from !== 'literal' && request.onMissing === 'omit') add('WORK_CONTEXT_CONTENT_INVALID', '현재 업무 정의와 일치하는 businessTask 및 명시적인 request 문맥이 필요합니다.', index, binding.nodeId);
    if (!same(node.inputBindings.context, { from: 'node', nodeId: context.id, pointer: '/data', onMissing: 'error' })) add('WORK_CONTEXT_BINDING_INVALID', '수행 블록은 지정한 문맥 구성 결과 전체를 연결해야 합니다.', index, node.id);
    // Keep one control predecessor on each side. Ordinary graph validation separately proves ordering/dominance.
    const incoming = workflow.edges.filter(edge => edge.to.nodeId === node.id), before = workflow.edges.filter(edge => edge.to.nodeId === context.id);
    if (incoming.length !== 1 || incoming[0]!.from.nodeId !== context.id || incoming[0]!.from.port !== 'next' || before.length !== 1) add('WORK_CONTEXT_CONTROL_INVALID', '문맥 블록은 해당 수행 블록의 단일 선행 경로에 있어야 합니다.', index, node.id);
    const normalize = (attachments: WorkflowNode['attachments']) => [...attachments].sort((a, b) => a.resource.localeCompare(b.resource));
    if (!same(normalize(node.attachments), normalize(expected))) add('WORK_CONTEXT_ATTACHMENTS_MISMATCH', '실제 첨부 자료와 역할은 Task에서 선택한 문맥과 정확히 일치해야 합니다.', index, node.id);
  }
  return issues;
}

/** Compile a reviewable preset using existing merge/attachment contracts. The input is never mutated.
 * Existing opaque instructions are not rewritten: callers must explain the new context.request path.
 * Reapplication refreshes metadata/selection only after the old structure is proven intact. */
export function applyWorkingContextPreset(input: Workflow, maxBytes = 262144): Workflow {
  const checked = validateWorkflowShape(input);
  if (!checked.valid || !input.workDefinition) throw new Error('유효한 워크플로와 업무 정의가 필요합니다.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1048576) throw new Error('문맥 크기는 1 KiB부터 1 MiB 사이여야 합니다.');
  const workflow = structuredClone(checked.value), definition = workflow.workDefinition!;
  const existing = definition.harness.workingContext;
  if (existing) {
    // A stale literal/selection is refreshable. Broken control/binding mappings need deliberate user edits first.
    const blocking = validateWorkingContextSemantics(workflow).filter(issue => !['WORK_CONTEXT_CONTENT_INVALID', 'WORK_CONTEXT_ATTACHMENTS_MISMATCH'].includes(issue.code));
    if (blocking.length) throw new Error(blocking[0]!.message);
    for (const binding of existing.bindings) {
      const context = workflow.nodes.find(node => node.id === binding.contextNodeId)!;
      const request = context.inputBindings.request;
      if (!request || request.from !== 'literal' && request.onMissing === 'omit' || Object.keys(context.inputBindings).sort().join(',') !== 'businessTask,request') throw new Error('기존 요청 문맥 연결을 먼저 확인하세요.');
      context.inputBindings.businessTask = { from: 'literal', value: workingTaskContext(workflow) };
      workflow.nodes.find(node => node.id === binding.nodeId)!.attachments = workingContextAttachments(workflow);
    }
    existing.maxBytes = maxBytes;
    return workflow;
  }
  if (definition.harness.context.length + definition.harness.perform.length > 32) throw new Error('문맥 역할은 최대 32개 블록까지 지정할 수 있습니다.');
  const used = new Set([...workflow.nodes.map(node => node.id), ...workflow.edges.map(edge => edge.id)]);
  const nextId = (prefix: string) => { let ordinal = 1; while (used.has(`${prefix}_${ordinal}`)) ordinal++; const id = `${prefix}_${ordinal}`; used.add(id); return id; };
  const bindings: Array<NonNullable<NonNullable<Workflow['workDefinition']>['harness']['workingContext']>['bindings'][number]> = [];
  for (const nodeId of definition.harness.perform) {
    const node = workflow.nodes.find(value => value.id === nodeId);
    if (!node || !(node.type === 'ai' || node.type === 'agent' && node.config.strategy === 'task' && node.config.maxSteps === 1)) throw new Error('기본 흐름의 AI 작업 또는 단일 작업 에이전트만 문맥을 구성할 수 있습니다.');
    const incoming = workflow.edges.filter(edge => edge.to.nodeId === node.id);
    if (incoming.length !== 1) throw new Error('수행 블록에 단일 선행 연결이 필요합니다.');
    const priorContext = node.inputBindings.context;
    if (priorContext && priorContext.from !== 'literal' && priorContext.onMissing === 'omit') throw new Error('선택적 문맥에는 명시적인 기본값을 연결한 뒤 구성하세요.');
    const context = createNode('merge'); context.id = nextId('context'); context.label = `${node.label.slice(0, 100)} 업무 문맥`;
    context.config = { waitFor: 'all_active', combine: 'object', collision: 'namespace' };
    context.inputBindings = { businessTask: { from: 'literal', value: workingTaskContext(workflow) }, request: node.inputBindings.context ?? { from: 'literal', value: null } };
    const incomingPort = incoming[0]!.to.port;
    incoming[0]!.to = { nodeId: context.id, port: 'in' };
    workflow.edges.push({ id: nextId('context_edge'), from: { nodeId: context.id, port: 'next' }, to: { nodeId: node.id, port: incomingPort } });
    workflow.nodes.splice(workflow.nodes.indexOf(node), 0, context);
    node.inputBindings.context = { from: 'node', nodeId: context.id, pointer: '/data', onMissing: 'error' };
    node.attachments = workingContextAttachments(workflow);
    definition.harness.context.push(context.id); bindings.push({ nodeId, contextNodeId: context.id });
  }
  // Validate the completed nonempty array instead of asserting a generated tuple type during construction.
  const declared = validateWorkDefinitionDeclaration({ ...definition, harness: { ...definition.harness, workingContext: { version: 1, maxBytes, bindings } } });
  if (!declared.valid) throw new Error('완성한 업무 문맥 선언이 공통 규격과 맞지 않습니다.');
  workflow.workDefinition = declared.value;
  const issues = validateWorkingContextSemantics(workflow); if (issues.length) throw new Error(issues[0]!.message);
  return workflow;
}

/** Remove only a still-private generated context wrapper. A reused merge requires an explicit canvas edit.
 * Attachments and opaque instructions remain authored data; absent original context is represented by null. */
export function removeWorkingContextPreset(input: Workflow): Workflow {
  const checked = validateWorkflowShape(input); if (!checked.valid) throw new Error('유효한 워크플로가 필요합니다.');
  const workflow = structuredClone(checked.value), declaration = workflow.workDefinition?.harness.workingContext;
  if (!declaration) return workflow;
  const issues = validateWorkingContextSemantics(workflow).filter(issue => !['WORK_CONTEXT_CONTENT_INVALID', 'WORK_CONTEXT_ATTACHMENTS_MISMATCH'].includes(issue.code));
  if (issues.length) throw new Error('변경된 문맥 연결을 먼저 확인하세요.');
  const removed = new Set<string>();
  for (const binding of declaration.bindings) {
    const context = workflow.nodes.find(node => node.id === binding.contextNodeId)!, node = workflow.nodes.find(value => value.id === binding.nodeId)!;
    const outgoing = workflow.edges.filter(edge => edge.from.nodeId === context.id);
    const foreignReference = workflow.nodes.some(value => Object.entries(value.inputBindings).some(([key, source]) => source?.from === 'node' && source.nodeId === context.id && !(value.id === node.id && key === 'context')));
    if (outgoing.length !== 1 || foreignReference || !context.inputBindings.request) throw new Error('다른 블록에서 사용하는 문맥입니다. 캔버스의 연결을 먼저 정리하세요.');
    if (Object.keys(context.inputBindings).sort().join(',') !== 'businessTask,request' || context.inputBindings.request.from !== 'literal' && context.inputBindings.request.onMissing === 'omit') throw new Error('문맥 묶기에 추가한 입력을 먼저 확인하세요.');
    const incoming = workflow.edges.find(edge => edge.to.nodeId === context.id)!;
    incoming.to = { ...outgoing[0]!.to }; node.inputBindings.context = structuredClone(context.inputBindings.request);
    workflow.edges = workflow.edges.filter(edge => edge.id !== outgoing[0]!.id); removed.add(context.id);
  }
  workflow.workDefinition!.harness.context = workflow.workDefinition!.harness.context.filter(id => !removed.has(id));
  delete workflow.workDefinition!.harness.workingContext;
  const restored = validateWorkflowShape({ ...workflow, nodes: workflow.nodes.filter(node => !removed.has(node.id)) });
  if (!restored.valid) throw new Error('문맥을 해제한 결과가 공통 규격에 맞지 않습니다.');
  return restored.value;
}
