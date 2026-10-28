import { validateCompletionDeclaration, validateWorkDefinitionDeclaration, type Workflow, type WorkflowNode, type ValidationIssue } from '@studio/spec';

const contextTypes = new Set<WorkflowNode['type']>(['input', 'form', 'resource', 'skill', 'file_input', 'document_extract', 'transform', 'merge', 'memory', 'knowledge', 'retrieval']);
const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value));

/** A business definition names one selected task and existing root nodes/resources. It does not create
 * instructions, edges, capabilities, grants, model settings, completion evidence or a runtime context manifest. */
export function validateWorkDefinitionSemantics(workflow: Workflow): ValidationIssue[] {
  if (workflow.workDefinition === undefined) return [];
  const checked = validateWorkDefinitionDeclaration(workflow.workDefinition); if (!checked.valid) return checked.issues;
  const definition = checked.value, issues: ValidationIssue[] = [];
  const add = (code: string, message: string, path: string, nodeId?: string) => issues.push({ severity: 'error' as const, stage: 'work-definition', code, message, instancePath: `/workDefinition/${path}`, ...(nodeId ? { nodeId } : {}) });
  const completion = validateCompletionDeclaration(workflow.completion);
  if (!completion.valid) add('WORK_COMPLETION_REQUIRED', '업무 정의에는 유효한 전체 완료 기준 선언이 필요합니다.', 'task/criterionIds');
  else if (!sameSet(definition.task.criterionIds, completion.value.criteria.map(criterion => criterion.id))) add('WORK_CRITERIA_MISMATCH', 'Task의 기준 ID는 전체 completion 기준과 정확히 일치해야 합니다.', 'task/criterionIds');

  const links = [...definition.task.assets, ...definition.task.skills];
  const aliases = new Set(links.map(link => link.alias)), selected = new Set(definition.harness.selectedContext);
  for (const [index, link] of links.entries()) {
    const path = index < definition.task.assets.length ? `task/assets/${index}` : `task/skills/${index - definition.task.assets.length}`;
    const reference = Object.hasOwn(workflow.resources, link.alias) ? workflow.resources[link.alias] : undefined;
    if (!reference || reference.kind !== link.kind) add('WORK_ASSET_REFERENCE_INVALID', '자료 별칭과 종류는 workflow.resources의 고정 참조와 일치해야 합니다.', `${path}/alias`);
    if (link.kind === 'instruction' && link.usage !== 'instructions' || link.kind === 'document' && link.usage === 'instructions') add('WORK_ASSET_USAGE_INVALID', '작업 지침은 instructions로, 문서는 reference 또는 template 용도로 연결하세요.', `${path}/usage`);
    if (link.required && !selected.has(link.alias)) add('WORK_REQUIRED_CONTEXT_MISSING', '필수 업무 자산과 Skill은 선택 문맥 목록에 포함해야 합니다.', `${path}/required`);
  }
  for (const [index, alias] of definition.harness.selectedContext.entries()) if (!aliases.has(alias)) add('WORK_CONTEXT_UNDECLARED', '선택 문맥은 이 Task에 선언한 자산 또는 Skill 별칭만 포함할 수 있습니다.', `harness/selectedContext/${index}`);

  // Never let a child with the same ID satisfy a root role. Ambiguous duplicate root IDs are also rejected.
  const root = (id: string): WorkflowNode | undefined => { const matches = workflow.nodes.filter(node => node.id === id); return matches.length === 1 ? matches[0] : undefined; };
  for (const role of ['context', 'perform', 'accept', 'deliver'] as const) {
    for (const [index, id] of definition.harness[role].entries()) {
      const node = root(id);
      if (!node) { add('WORK_HARNESS_NODE_MISSING', 'Harness는 실제 루트 흐름의 고유한 블록을 참조해야 합니다.', `harness/${role}/${index}`, id); continue; }
      const allowed = role === 'context' ? contextTypes.has(node.type)
        : role === 'perform' ? node.type === 'ai' || node.type === 'agent'
        : role === 'deliver' ? node.type === 'output' || node.type === 'file_output'
        : node.type === 'output' || node.type === 'review' || node.type === 'evaluate' || node.type === 'agent' && node.config.strategy === 'agentic_rag' || node.type === 'loop' && node.config.mode === 'until';
      if (!allowed) add('WORK_HARNESS_ROLE_INVALID', '블록 종류가 지정한 업무 역할과 맞지 않습니다.', `harness/${role}/${index}`, id);
    }
  }
  const outputs = workflow.nodes.filter(node => node.type === 'output');
  if (outputs.length !== 1 || !definition.harness.deliver.includes(outputs[0]!.id)) add('WORK_DELIVERY_OUTPUT_MISSING', '전달 역할에는 실제 루트 최종 결과 블록을 포함해야 합니다.', 'harness/deliver');
  if (completion.valid && outputs.length === 1) {
    const expected = [...new Set(completion.value.criteria.map(criterion => criterion.kind === 'result_schema' ? outputs[0]!.id : criterion.nodeId))];
    if (!sameSet(definition.harness.accept, expected)) add('WORK_ACCEPTANCE_MAPPING_MISMATCH', '완료 확인 역할은 전체 completion 기준이 참조하는 실제 블록과 일치해야 합니다.', 'harness/accept');
  }
  // Mapping a node never creates a control edge. The ordinary graph/binding validator remains authoritative
  // for ordering, branches, accessibility and execution. Actual selected-byte consumption is an R-07 boundary.
  return issues;
}
