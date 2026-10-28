import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, validateWorkflowShape } from '@studio/spec';
import { analyzeWorkflow, applyWorkingContextPreset } from '@studio/workflow-core';
import { createWorkDefinition, selectWorkAsset, workPerformers } from '../../apps/studio-web/src/features/editor/work-definition-authoring.js';
import { createAvatarMeetingProject } from '../../tooling/catalog/materialize-avatar-meeting-followup.js';
import { pruneResourceState } from '../../apps/studio-web/src/features/editor/resource-state.js';

/** Authoring tests verify explicit intent, required selections, graph preservation and absence of implicit execution. */
describe('selected task authoring', () => {
  it('requires explicit completion and keeps an existing legacy workflow unchanged', () => {
    const workflow = createBasicWorkflow(), before = structuredClone(workflow);
    expect(() => createWorkDefinition(workflow)).toThrow('완료 기준'); expect(workflow).toEqual(before);
    workflow.completion = { version: 1, criteria: [{ id: 'shape', label: '결과 형식', kind: 'result_schema', schema: workflow.outputs }] };
    const definition = createWorkDefinition(workflow); expect(workflow.workDefinition).toBeUndefined();
    const next = { ...workflow, workDefinition: definition };
    expect(validateWorkflowShape(next).valid).toBe(true); expect(analyzeWorkflow(next)).toEqual([]);
    expect(definition.task.criterionIds).toEqual(['shape']); expect(definition.harness.accept).toEqual(['finish']);
  });
  it('copies only explicit existing attachment selections and does not mutate the original project', async () => {
    const workflow = (await createAvatarMeetingProject()).workflow; delete workflow.workDefinition;
    const before = structuredClone(workflow), definition = createWorkDefinition(workflow);
    expect(workflow).toEqual(before); expect(definition.harness.selectedContext).toEqual(['judgment', 'template', 'procedure']);
    expect(definition.task.assets).toHaveLength(2); expect(definition.task.skills).toHaveLength(1);
    expect(analyzeWorkflow({ ...workflow, workDefinition: definition })).toEqual([]);
  });
  it('keeps required sources selected and retains optional exclusion reasons until explicitly reapplied', async () => {
    const workflow = (await createAvatarMeetingProject()).workflow;
    expect(() => selectWorkAsset(workflow, 'judgment', false)).toThrow('필수');
    workflow.workDefinition!.task.assets.find(link => link.alias === 'judgment')!.required = false;
    const definition = selectWorkAsset(workflow, 'judgment', false);
    expect(definition.task.assets.find(link => link.alias === 'judgment')?.purpose).toBeTruthy();
    expect(definition.harness.selectedContext).not.toContain('judgment');
    expect(workflow.nodes.find(node => node.id === 'draft')!.attachments.some(attachment => attachment.resource === 'judgment')).toBe(true);
    const compiled = applyWorkingContextPreset({ ...workflow, workDefinition: definition });
    expect(compiled.nodes.find(node => node.id === 'draft')!.attachments.some(attachment => attachment.resource === 'judgment')).toBe(false);
    expect(analyzeWorkflow(compiled)).toEqual([]);
    const pruned = pruneResourceState(workflow, compiled).workflow;
    expect(pruned.resources.judgment).toEqual(workflow.resources.judgment);
    expect(analyzeWorkflow(pruned)).toEqual([]);
  });
  it('rejects undeclared resources and excludes unsupported agent modes from selectable performers', async () => {
    const workflow = (await createAvatarMeetingProject()).workflow;
    expect(() => selectWorkAsset(workflow, 'unconnected-account-resource', true)).toThrow('프로젝트');
    const node = workflow.nodes.find(value => value.id === 'draft')!; if (node.type !== 'agent') throw new Error('Expected task agent');
    node.config.strategy = 'agentic_rag'; expect(workPerformers(workflow)).toEqual([]);
  });
});
