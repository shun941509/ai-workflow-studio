import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { collectRequirements } from '@studio/workflow-core';

/** Capability collection is structural; readiness remains responsible for installing every requested mode. */
describe('child-flow capability requirements', () => {
  it('keeps index operations, search algorithms and trusted storage scope distinct', () => {
    const workflow = createBasicWorkflow(); const node = createNode('knowledge'); if (node.type !== 'knowledge') throw new Error('Wrong factory');
    node.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 100 } }; workflow.nodes.push(node);
    expect(collectRequirements(workflow).capabilities).toEqual(expect.arrayContaining(['knowledge.build@1', 'knowledge.keyword@1', 'rag.run_local@1']));
    expect(collectRequirements(workflow).capabilities).not.toContain('knowledge.delete@1');
    node.config = { operation: 'delete' };
    expect(collectRequirements(workflow).capabilities).toContain('knowledge.delete@1');
    expect(collectRequirements(workflow).capabilities).not.toContain('knowledge.build@1');
  });
  it('separates a single task response from iterative and tool-using agents', () => {
    const workflow = createBasicWorkflow(); const node = createNode('agent'); if (node.type !== 'agent') throw new Error('Wrong node factory');
    node.config.strategy = 'task'; node.config.maxSteps = 1; node.config.toolAllowlist = []; workflow.nodes.push(node);
    expect(collectRequirements(workflow).capabilities).toEqual(expect.arrayContaining(['agent.task@1', 'agent.single_step@1']));
    expect(collectRequirements(workflow).capabilities).not.toContain('agent.multi_step@1');
    node.config.maxSteps = 2;
    expect(collectRequirements(workflow).capabilities).toContain('agent.multi_step@1');
    expect(collectRequirements(workflow).capabilities).not.toContain('agent.single_step@1');
  });
  it('declares Skill interpretation for every bundled Skill, including generic resource consumers', () => {
    const workflow = createBasicWorkflow();
    workflow.resources.guide = { kind: 'skill', id: 'guide', revision: 1, sha256: 'a'.repeat(64) };
    expect(collectRequirements(workflow).capabilities).toContain('skill.instructions@1');
  });
  it('distinguishes local and packaged flow references and loop modes', () => {
    const workflow = createBasicWorkflow();
    const local = createNode('subworkflow'); if (local.type !== 'subworkflow') throw new Error('Wrong factory type');
    local.config.flowRef = { kind: 'local', flowId: 'child' };
    const packaged = structuredClone(local); packaged.id = 'packaged'; packaged.config.flowRef = { kind: 'package', workflowId: 'external', revision: 1, sha256: 'a'.repeat(64) };
    const loop = createNode('loop'); if (loop.type !== 'loop') throw new Error('Wrong factory type');
    workflow.nodes.push(local, packaged, loop);
    expect(collectRequirements(workflow).capabilities).toEqual(expect.arrayContaining(['flow.local@1', 'flow.package@1', 'loop.foreach@1']));
    loop.config.mode = 'until';
    expect(collectRequirements(workflow).capabilities).toContain('loop.until@1');
    expect(collectRequirements(workflow).capabilities).not.toContain('loop.foreach@1');
  });
});
