import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow, type Workflow } from '@studio/spec';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { assertPreservedResourceDependencies, attachResourceSelection, pruneResourceState, selectedResourceAlias, validateResourceState } from '../../apps/studio-web/src/features/editor/resource-state';
import { withoutResourceAttachment } from '../../apps/studio-web/src/features/editor/resource-links';
import { normalizeLayout, readLocalDraft, writeLocalDraft } from '../../apps/studio-web/src/features/editor/local-drafts';
import { resourceFixture, legacyTextFixture } from '../fixtures/resource-ui';

const document = resourceFixture(1, 'document'), first = resourceFixture(2, 'instruction', [document]), second = resourceFixture(3, 'instruction', [document]);
const aiId = (flow: Workflow) => flow.nodes.find(node => node.type === 'ai')!.id;
const initial = () => attachResourceSelection(createBasicWorkflow(), aiId(createBasicWorkflow()), first.detail);
afterEach(() => vi.unstubAllGlobals());

/** Closure bookkeeping preserves immutable bytes and ownership bindings without adding execution permissions. */
describe('private resource authoring state', () => {
  it('accepts legacy private text only with the real server UUID identity convention', async () => {
    const text = legacyTextFixture(50), workflow = createBasicWorkflow(); const state = attachResourceSelection(workflow, aiId(workflow), text.detail);
    expect(text.alias).toBe(text.detail.resource.id); expect(text.detail.version.reference.id).toBe(text.alias);
    const archive = await inspectPackage((await buildPackage({ workflow: state.workflow, host: 'codex', resources: text.files })).bytes); expect(archive.workflow!.resources).toEqual(text.detail.refs);
  });
  it('keeps the source alias, descriptor id and account ids distinct', () => {
    const state = initial(); expect(selectedResourceAlias(first.detail)).toBe(first.alias);
    expect(state.workflow.nodes.find(node => node.type === 'ai')!.attachments[0]!.resource).toBe(first.alias);
    expect(state.workflow.resources[first.alias]!.id).not.toBe(first.alias); expect(first.detail.resource.id).not.toBe(first.detail.version.id);
    expect(state.resourceBindings).toEqual(first.detail.resourceBindings); expect(Object.keys(state.workflow.resources)).toHaveLength(2);
  });
  it('keeps a shared dependency until the last root is detached', () => {
    const one = initial(), both = attachResourceSelection(one.workflow, aiId(one.workflow), second.detail, one);
    const removed = pruneResourceState(both.workflow, withoutResourceAttachment(both.workflow, aiId(both.workflow), first.alias), both);
    expect(Object.keys(removed.workflow.resources).sort()).toEqual([document.alias, second.alias].sort());
    const empty = pruneResourceState(removed.workflow, withoutResourceAttachment(removed.workflow, aiId(removed.workflow), second.alias), removed);
    expect(empty.workflow.resources).toEqual({}); expect(empty.resourceBindings).toEqual({}); expect(empty.resourceDependencies).toEqual({});
  });
  it('preserves deliberate unreferenced pins and their dependencies', () => {
    const one = initial(); one.workflow.resources = { ...one.workflow.resources, ...second.detail.refs }; Object.assign(one.resourceBindings, second.detail.resourceBindings); Object.assign(one.resourceDependencies, second.detail.resourceDependencies);
    const removed = pruneResourceState(one.workflow, withoutResourceAttachment(one.workflow, aiId(one.workflow), first.alias), one);
    expect(Object.keys(removed.workflow.resources).sort()).toEqual([document.alias, second.alias].sort());
  });
  it('retains a child-flow attachment even when the main-flow attachment is detached', () => {
    const one = initial(); const child = createBasicWorkflow(); child.nodes.find(node => node.type === 'ai')!.attachments = [{ resource: first.alias, role: 'instructions' }];
    one.workflow.subworkflows.child = { inputs: child.inputs, outputs: child.outputs, entryNodeId: child.entryNodeId, nodes: child.nodes, edges: child.edges };
    const removed = pruneResourceState(one.workflow, withoutResourceAttachment(one.workflow, aiId(one.workflow), first.alias), one);
    expect(removed.workflow.resources).toEqual(one.workflow.resources);
  });
  it('rejects changed same-alias references, account versions and cyclic or incomplete closures', () => {
    const one = initial(); const changed = resourceFixture(2, 'instruction', [document], 2);
    expect(() => attachResourceSelection(one.workflow, aiId(one.workflow), changed.detail, one)).toThrow(/충돌/);
    const wrong = structuredClone(first.detail); wrong.resourceBindings[first.alias] = document.detail.version.id;
    expect(() => attachResourceSelection(one.workflow, aiId(one.workflow), wrong, one)).toThrow();
    const cycle = structuredClone(first.detail); cycle.resourceDependencies[document.alias] = [first.alias];
    expect(() => attachResourceSelection(one.workflow, aiId(one.workflow), cycle, one)).toThrow();
    const missing = structuredClone(first.detail); delete missing.refs[document.alias];
    expect(() => attachResourceSelection(one.workflow, aiId(one.workflow), missing, one)).toThrow();
  });
  it('rejects replacement dependency hashes instead of retaining an old parent binding', () => {
    const one = initial(), next = structuredClone(one.workflow); next.resources[document.alias] = resourceFixture(1, 'document', [], 2).detail.version.reference;
    expect(() => pruneResourceState(one.workflow, next, one)).toThrow(/의존 자료/);
    const changedRoot = structuredClone(one.workflow); changedRoot.resources[first.alias] = resourceFixture(2, 'instruction', [document], 2).detail.version.reference;
    const changed = pruneResourceState(one.workflow, changedRoot, one); expect(changed.resourceBindings[first.alias]).toBeUndefined();
  });
  it('rejects explicit JSON child deletion but permits removing the complete parent closure', () => {
    const one = initial(), next = structuredClone(one.workflow); delete next.resources[document.alias];
    expect(() => assertPreservedResourceDependencies(one.workflow, next, one)).toThrow(/의존 자료/);
    next.resources = {}; expect(() => assertPreservedResourceDependencies(one.workflow, next, one)).not.toThrow();
  });
  it('never invents dependency edges for legacy drafts', () => {
    const one = initial(); const next = pruneResourceState(one.workflow, withoutResourceAttachment(one.workflow, aiId(one.workflow), first.alias));
    expect(Object.keys(next.workflow.resources)).toEqual([document.alias]); expect(next.resourceDependencies).toEqual({});
  });
  it('persists source bindings and Korean flow layout outside workflow and editor execution data', () => {
    const one = initial(), storage = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    const draft = { storageVersion: 1 as const, ...one, editor: normalizeLayout({}, one.workflow), updatedAt: '2026-10-28T00:00:00Z', origin: first.detail.origin };
    writeLocalDraft(draft); const reopened = readLocalDraft(one.workflow.id)!; expect(reopened.resourceBindings).toEqual(one.resourceBindings); expect(reopened.resourceDependencies).toEqual(one.resourceDependencies); expect(reopened.origin).toEqual(first.detail.origin);
    expect(JSON.stringify(reopened.workflow)).not.toContain(first.detail.version.id); expect(JSON.stringify(reopened.editor)).not.toContain(first.detail.version.id);
    expect(() => validateResourceState(one.workflow, { unknown: first.detail.version.id }, {})).toThrow();
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves actual source bytes in a %s workflow ZIP', async host => {
    const state = initial(); const built = await buildPackage({ host, workflow: state.workflow, resources: first.files }); const imported = await inspectPackage(built.bytes);
    for (const [path, bytes] of Object.entries(first.files)) expect(imported.files.get(path)).toEqual(bytes);
    expect(imported.workflow!.resources).toEqual(first.detail.refs); expect(new TextDecoder().decode(imported.files.get('workflow.json'))).not.toContain(first.detail.version.id);
  });
});
