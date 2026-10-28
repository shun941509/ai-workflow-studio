import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { validateRunRagNode } from '@studio/workflow-core';
import { addRerankerDeclaration, nextRerankerAlias, retrievalMode, toggleRerank, validateAuthoredRag } from '../../apps/studio-web/src/features/editor/rag-authoring';
import { addLocalFlow, editFlowDraft } from '../../apps/studio-web/src/features/editor/flow-helpers';
import { newLocalDraft } from '../../apps/studio-web/src/features/editor/local-drafts';

const search = () => { const node = createNode('retrieval'); if (node.type !== 'retrieval') throw new Error('factory'); return node; };

/** User opt-in, shared declarations and bounds must survive mode edits without silently changing prior user choices. */
describe('reranker authoring', () => {
  it.each(['keyword', 'vector', 'hybrid'] as const)('round trips explicit reranking on %s and separates disabling from shared declaration deletion', mode => {
    const flow = createBasicWorkflow(); const node = search(); Object.assign(node, retrievalMode(node, mode)); Object.assign(node, toggleRerank(node, true)); flow.nodes.push(node);
    const next = { ...flow, ...addRerankerDeclaration(flow, node.id, nextRerankerAlias(flow)) }; const after = next.nodes.at(-1)!;
    expect(next.modelProfiles.reranker_default).toEqual({ kind: 'reranker', requiredFeatures: ['rerank'] }); expect(() => validateAuthoredRag(after)).not.toThrow(); if (after.type !== 'retrieval') throw new Error('type'); expect(() => validateRunRagNode(after)).not.toThrow();
    const changed = { ...after, ...retrievalMode(after, mode === 'keyword' ? 'hybrid' : 'keyword') } as typeof after; expect(changed.config.reranker).toEqual(after.config.reranker);
    const disabled = toggleRerank(after, false).config; expect(disabled).not.toHaveProperty('reranker'); expect(Object.hasOwn(disabled!, 'candidateLimit')).toBe(mode === 'hybrid'); expect(next.modelProfiles.reranker_default).toBeDefined();
  });
  it('keeps over-limit and imported unsupported settings visible rather than clamping or deleting them', () => {
    const node = search(); node.config.topK = 30; Object.assign(node, toggleRerank(node, true)); node.config.reranker!.modelProfile = 'rank'; expect(node.config.topK).toBe(30); expect(node.config.candidateLimit).toBe(30); expect(() => validateAuthoredRag(node)).toThrow(/20/);
    node.config.topK = 1; node.config.candidateLimit = 20;
    for (const timeoutMs of [0, 1.5, 120001]) { node.config.reranker!.timeoutMs = timeoutMs; expect(() => validateAuthoredRag(node)).toThrow(); }
    node.config.reranker!.timeoutMs = 1; expect(() => validateAuthoredRag(node)).not.toThrow();
    Object.assign(node.config.reranker!, { endpoint: 'https://untrusted.example' }); const before = JSON.stringify(node); expect(() => validateAuthoredRag(node)).toThrow(); expect(JSON.stringify(node)).toBe(before);
  });
  it('never converts a chat alias or changes Korean child metadata when adding the reranker role', () => {
    const draft = newLocalDraft(); draft.workflow = addLocalFlow(draft.workflow, 'child'); draft.editor.subflows = { child: { name: '근거 다시 살피기', positions: {} } };
    draft.workflow.modelProfiles.reranker_default = { kind: 'chat', requiredFeatures: ['text'] }; const node = search(); node.id = 'work'; Object.assign(node, toggleRerank(node, true)); draft.workflow.subworkflows.child!.nodes.push(node);
    const alias = nextRerankerAlias(draft.workflow); expect(alias).toBe('reranker_2');
    const next = editFlowDraft(draft, 'child', view => ({ ...view, workflow: { ...view.workflow, ...addRerankerDeclaration(view.workflow, node.id, alias) } }));
    expect(next.workflow.modelProfiles.reranker_default!.kind).toBe('chat'); expect(next.workflow.nodes).toEqual(draft.workflow.nodes); expect(next.editor).toEqual(draft.editor); expect(next.workflow.subworkflows.child!.nodes.at(-1)!.config).toMatchObject({ reranker: { modelProfile: alias } });
    expect(() => addRerankerDeclaration({ ...next.workflow, nodes: next.workflow.subworkflows.child!.nodes }, node.id, 'reranker_default')).toThrow(/이미/);
  });
});
