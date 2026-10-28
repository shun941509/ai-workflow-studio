import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow, createNode, DOCUMENTED_RUNNER_CAPABILITIES, EDITOR_NODE_TYPES, NODE_DEFINITIONS, NODE_SUPPORT_INVENTORY, SUPPORT_INVENTORY_VERIFICATION, type NodeSupport, type NodeType } from '@studio/spec';
import { EDITOR_TYPES, editorSupportIssues } from '../../apps/studio-web/src/features/editor/editor-contract';
import { RunnerService } from '../../apps/runner/src/service';
import { RunStore } from '../../apps/runner/src/state/store';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store';

// The inventory documents product scope. Only the real Runner constructor determines the runtime capability set.
const records = Object.entries(NODE_SUPPORT_INVENTORY) as [NodeType, NodeSupport][];

describe('single documented node/mode support inventory', () => {
  it('covers each canonical type exactly once without changing the schema registry', () => {
    expect(records).toHaveLength(31);
    expect(records.map(([type]) => type).sort()).toEqual(NODE_DEFINITIONS.map(item => item.type).sort());
    expect(records.filter(([, entry]) => entry.modes.length).map(([type]) => type)).toHaveLength(28);
    expect(records.filter(([, entry]) => !entry.modes.length).map(([type]) => type).sort()).toEqual(['compensate', 'program', 'trigger']);
  });

  it('derives the exact established 21-block palette and reuses the same immutable list', () => {
    expect(EDITOR_NODE_TYPES).toEqual(['input', 'form', 'ai', 'agent', 'classify', 'output', 'resource', 'transform', 'condition', 'merge', 'guardrail', 'evaluate', 'error', 'review', 'file_input', 'file_output', 'document_extract', 'memory', 'knowledge', 'retrieval', 'subworkflow']);
    expect(EDITOR_TYPES).toBe(EDITOR_NODE_TYPES);
    expect(EDITOR_NODE_TYPES.map(type => NODE_SUPPORT_INVENTORY[type].editorOrder)).toEqual(Array.from({ length: 21 }, (_, order) => order));
  });

  it('records explicit mode prerequisites, constraints and authoring state without claiming live verification', () => {
    expect(SUPPORT_INVENTORY_VERIFICATION).toEqual({ externalServices: 'unverified', hostExecution: 'unverified' });
    for (const [type, entry] of records) {
      expect(entry.constraints.length, type).toBeGreaterThan(0);
      expect(new Set(entry.modes.map(mode => mode.id)).size, type).toBe(entry.modes.length);
      expect(entry.modes.some(mode => mode.editor), type).toBe(entry.editorOrder !== null);
      if (!entry.modes.length) expect(entry.unavailable.length, type).toBeGreaterThan(0);
      for (const mode of entry.modes) {
        expect(mode.label.trim().length, `${type}/${mode.id}`).toBeGreaterThan(0);
        expect(mode.prerequisites.length, `${type}/${mode.id}`).toBeGreaterThan(0);
        for (const capability of mode.capabilities) expect(capability).toMatch(/^[a-z][a-z0-9_.-]*@\d+$/);
      }
    }
  });

  it('freezes nested modes and palette entries so one consumer cannot enable another consumer', () => {
    expect(Object.isFrozen(NODE_SUPPORT_INVENTORY)).toBe(true);
    expect(Object.isFrozen(NODE_SUPPORT_INVENTORY.agent.modes[0].capabilities)).toBe(true);
    expect(() => (NODE_SUPPORT_INVENTORY.parallel as unknown as { editorOrder: number }).editorOrder = 21).toThrow();
    expect(() => (EDITOR_NODE_TYPES as unknown as string[]).push('program')).toThrow();
    expect(() => (DOCUMENTED_RUNNER_CAPABILITIES as unknown as string[]).push('worker.unrestricted@1')).toThrow();
  });

  it('retains the default Runner capability contract without making external or model calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-support-inventory-'));
    const store = new RunStore(join(directory, 'state.sqlite'));
    const denied = vi.fn(async (): Promise<never> => { throw new Error('Inventory inspection must not access credentials'); });
    const credentials: CredentialStore = { available: false, get: denied, set: denied, has: denied, delete: denied };
    // Default production providers/tokenizer are constructed but never invoked; no key or fake model is installed.
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Inventory inspection must not access the network'); });
    let service: RunnerService | undefined;
    try {
      service = new RunnerService(store, credentials, directory);
      // Completion and work definition are cross-workflow contracts, not additional node types or execution modes.
      // Keep this exclusion explicit: a new unclassified runtime capability must still fail this drift check.
      const nodeAndModeCapabilities = service.capabilities.filter(capability => !['workflow.completion@1', 'workflow.work_definition@1', 'workflow.working_context@1'].includes(capability));
      expect([...new Set(nodeAndModeCapabilities)].sort()).toEqual(DOCUMENTED_RUNNER_CAPABILITIES);
      expect(nodeAndModeCapabilities).toHaveLength(new Set(nodeAndModeCapabilities).size);
      expect(denied).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally {
      await service?.shutdown(); store.close(); network.mockRestore();
      // Delete only the test's fresh direct temp child; never follow a computed workspace/global target.
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('studio-support-inventory-')) throw new Error('Unsafe support inventory cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(records.filter(([, entry]) => entry.editorOrder === null).map(([type]) => type))('does not activate the %s editor/export path from a documented Runner mode', type => {
    const workflow = createBasicWorkflow(), node = createNode(type); workflow.nodes.push(node);
    expect(editorSupportIssues(workflow)).toContainEqual(expect.objectContaining({ nodeId: node.id, code: 'EDITOR_MODE_UNSUPPORTED', message: expect.stringContaining('아직 편집·다운로드를 지원하지 않습니다') }));
  });

  it('keeps configuration validators authoritative when a documented type has unsupported settings', () => {
    const workflow = createBasicWorkflow(), task = createNode('agent'), search = createNode('retrieval'), extraction = createNode('document_extract'), evaluation = createNode('evaluate');
    if (task.type !== 'agent' || search.type !== 'retrieval' || extraction.type !== 'document_extract' || evaluation.type !== 'evaluate') throw new Error('Registry mismatch');
    task.config.maxSteps = 8; search.config.mode = 'graph_local'; extraction.config.mode = 'ocr';
    evaluation.config = { mode: 'model', modelProfile: 'text-default', instructions: '기준에 맞게 평가하세요.', resultSchema: true, passRule: { literal: true } };
    workflow.nodes.push(task, search, extraction, evaluation);
    const rejectedIds = editorSupportIssues(workflow).map(issue => issue.nodeId);
    expect(rejectedIds).toEqual(expect.arrayContaining([task.id, search.id, extraction.id, evaluation.id]));
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('agent.multi_step@1');
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('agentic_rag.ask@1');
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('retrieval.graph_local@1');
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('skill.execute@1');
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('tool.mcp@1');
    expect(DOCUMENTED_RUNNER_CAPABILITIES).not.toContain('parallel.first_match@1');
  });
});
