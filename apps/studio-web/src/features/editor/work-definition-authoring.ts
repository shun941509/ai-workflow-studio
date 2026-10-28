import { validateWorkDefinitionDeclaration, type Workflow, type WorkDefinition, type WorkflowNode } from '@studio/spec';

/** Only presently executable root performers are offered; choosing a task does not enable new agent strategies. */
export function workPerformers(workflow: Workflow): WorkflowNode[] {
  return workflow.nodes.filter(node => node.type === 'ai' || node.type === 'agent' && node.config.strategy === 'task' && node.config.maxSteps === 1);
}

/** Add one explicit selected task around existing criteria and graph; no run, permission or external resource is created. */
export function createWorkDefinition(workflow: Workflow): WorkDefinition {
  if (workflow.workDefinition) return structuredClone(workflow.workDefinition);
  if (!workflow.completion) throw new Error('먼저 업무 완료 기준을 설정하세요.');
  const performer = workPerformers(workflow)[0], output = workflow.nodes.find(node => node.type === 'output');
  if (!performer || !output) throw new Error('기본 흐름에 AI 작업 또는 단일 작업 에이전트와 최종 결과 블록이 필요합니다.');
  const definition: WorkDefinition = {
    version: 1, id: 'selected_work', revision: 1,
    card: { id: 'partner', title: `${workflow.name.slice(0, 100)} 업무 파트너`, purpose: '이 프로젝트의 업무를 검토 가능한 결과로 정리합니다.' },
    role: { id: 'worker', title: '업무 수행 담당', responsibility: '제공된 자료와 완료 기준에 따라 작업하고, 확인하지 못한 내용은 구분합니다.' },
    task: { id: 'task', title: workflow.name, goal: '프로젝트 입력을 바탕으로 작업하고 지정한 완료 기준에 따라 결과를 검토합니다.', criterionIds: workflow.completion.criteria.map(criterion => criterion.id) as WorkDefinition['task']['criterionIds'], assets: [], skills: [] },
    harness: { context: [workflow.entryNodeId], perform: [performer.id], accept: [...new Set(workflow.completion.criteria.map(criterion => criterion.kind === 'result_schema' ? output.id : criterion.nodeId))], deliver: [output.id], selectedContext: [] },
  };
  // Existing explicit attachments seed selection; unconnected account materials are never fetched implicitly.
  for (const attachment of performer.attachments) addAsset(definition, workflow, attachment.resource);
  const checked = validateWorkDefinitionDeclaration(definition); if (!checked.valid) throw new Error(checked.issues[0]!.message);
  return checked.value;
}

function addAsset(definition: WorkDefinition, workflow: Workflow, alias: string): void {
  const resource = workflow.resources[alias];
  if (!resource || !['instruction', 'document', 'skill'].includes(resource.kind)) throw new Error('프로젝트에 연결한 지침·문서·Skill만 업무 자산으로 선택할 수 있습니다.');
  const assets = [...definition.task.assets], skills: Array<WorkDefinition['task']['skills'][number]> = [...definition.task.skills];
  if (![...definition.task.assets, ...definition.task.skills].some(link => link.alias === alias)) {
    if (resource.kind === 'skill') skills.push({ alias, kind: 'skill', usage: 'instructions', purpose: '이 작업에 적용할 재사용 절차', required: false });
    else assets.push({ alias, kind: resource.kind as 'instruction' | 'document', usage: resource.kind === 'instruction' ? 'instructions' : 'reference', purpose: resource.kind === 'instruction' ? '이 작업에 적용할 판단 지침' : '이 작업의 근거를 확인할 참고 자료', required: false });
  }
  const selectedContext = definition.harness.selectedContext.includes(alias) ? definition.harness.selectedContext : [...definition.harness.selectedContext, alias];
  // Revalidate bounded arrays instead of coercing a growing list to a generated maximum-length tuple.
  const checked = validateWorkDefinitionDeclaration({ ...definition, task: { ...definition.task, assets, skills }, harness: { ...definition.harness, selectedContext } });
  if (!checked.valid) throw new Error(checked.issues[0]!.message);
  Object.assign(definition, checked.value);
}

/** Selection is editable task intent. An explicit preset refresh later synchronizes actual node attachments. */
export function selectWorkAsset(workflow: Workflow, alias: string, selected: boolean): WorkDefinition {
  if (!workflow.workDefinition) throw new Error('업무 정의를 먼저 추가하세요.');
  const definition = structuredClone(workflow.workDefinition);
  if (selected) addAsset(definition, workflow, alias);
  else {
    const link = [...definition.task.assets, ...definition.task.skills].find(value => value.alias === alias);
    if (link?.required) throw new Error('필수 자료입니다. 필수 설정을 해제한 뒤 제외하세요.');
    definition.harness.selectedContext = definition.harness.selectedContext.filter(value => value !== alias);
  }
  const checked = validateWorkDefinitionDeclaration(definition); if (!checked.valid) throw new Error(checked.issues[0]!.message);
  return checked.value;
}
