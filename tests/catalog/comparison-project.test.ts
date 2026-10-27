import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWorkflowJson, validateJsonValue, type Workflow } from '@studio/spec';
import { analyzeWorkflow, resolveBindings } from '@studio/workflow-core';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import { WindowsCredentialStore } from '../../apps/runner/src/security/credential-store.js';

/** This verifies authored project contracts and prerequisite blocking, not model quality or actual host use. */
describe('EP-006 authored comparison workflow', () => {
  let workflow: Workflow; let sample: Record<string, unknown>; let directory: string; let store: RunStore; let service: RunnerService;
  beforeAll(async () => {
    const parsed = parseWorkflowJson(await readFile('catalog/official/projects/EP-006/workflow.json', 'utf8')); if (!parsed.valid) throw new Error('Invalid authored workflow'); workflow = parsed.value;
    sample = JSON.parse(await readFile('catalog/official/projects/EP-006/sample-input.json', 'utf8'));
    directory = await mkdtemp(join(tmpdir(), 'studio-comparison-')); store = new RunStore(join(directory, 'state.sqlite'));
    service = new RunnerService(store, new WindowsCredentialStore(join(directory, 'credentials')), directory);
  });
  afterAll(async () => { await service?.shutdown(); store?.close(); if (directory) { const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-comparison-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true }); } });
  it('preserves its actual form-agent-transform path and empty-evidence inputs', () => {
    expect(analyzeWorkflow(workflow).filter(issue => issue.severity === 'error')).toEqual([]);
    expect(workflow.nodes.map(node => node.type)).toEqual(['form', 'agent', 'transform', 'output']);
    expect(validateJsonValue(workflow.inputs, sample).valid).toBe(true);
    expect(validateJsonValue(workflow.inputs, { ...sample, facts: [] }).valid).toBe(true);
    expect(validateJsonValue(workflow.inputs, { ...sample, criteria: [] }).valid).toBe(false);
    expect(workflow.policy.limits.maxModelCalls).toBe(1);
    const agent = workflow.nodes.find(node => node.type === 'agent')!;
    expect(resolveBindings(agent, { workflowInput: sample, nodeOutputs: { request: { data: sample } } })).toEqual({ task: sample.goal, context: sample });
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('produces a real %s ZIP and blocks before execution without a model', async host => {
    const built = await buildPackage({ workflow, host }); const checked = await inspectPackage(built.bytes);
    expect(checked.workflow).toEqual(workflow); expect(checked.manifest.requiredCapabilities).toContain('agent.single_step@1');
    const imported = await service.importPackage(built.bytes); const readiness = await service.validate(imported.packageHandle, {});
    expect(readiness.ready).toBe(false);
    await expect(service.start({ packageHandle: imported.packageHandle, requestId: `comparison_${host}`, inputs: sample, modelBindings: {} })).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' });
    expect(store.listRuns()).toHaveLength(0);
  });
});
