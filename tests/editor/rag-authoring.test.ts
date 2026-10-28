import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { validateRunRagNode } from '@studio/workflow-core';
import { addEmbeddingDeclaration, declaredProfiles, knowledgeMode, nextEmbeddingAlias, retrievalMode, validateAuthoredRag } from '../../apps/studio-web/src/features/editor/rag-authoring';
import { editorSupportIssues } from '../../apps/studio-web/src/features/editor/editor-contract';
import { nodeValueOptions } from '../../apps/studio-web/src/features/editor/binding-options';
import { addLocalFlow, editFlowDraft } from '../../apps/studio-web/src/features/editor/flow-helpers';
import { newLocalDraft } from '../../apps/studio-web/src/features/editor/local-drafts';

/** Authoring changes must be canonical and explicit, including when an imported unsupported node is retained. */
describe('RAG authoring contract', () => {
  it.each(['keyword', 'vector', 'hybrid'] as const)('creates a valid %s index without mutating the source', kind => {
    const source = createNode('knowledge'); if (source.type !== 'knowledge') throw new Error('type');
    const before = JSON.stringify(source); const next = { ...source, ...knowledgeMode(source, kind) } as typeof source;
    if (kind !== 'keyword') next.config.indexSettings!.embeddingProfile = 'documents';
    expect(() => validateRunRagNode(next)).not.toThrow(); expect(() => validateAuthoredRag(next)).not.toThrow(); expect(JSON.stringify(source)).toBe(before);
  });
  it.each(['keyword', 'vector', 'hybrid'] as const)('creates %s retrieval and its actual output binding paths', mode => {
    const source = createNode('retrieval'); if (source.type !== 'retrieval') throw new Error('type');
    const next = { ...source, ...retrievalMode(source, mode) } as typeof source;
    expect(() => validateRunRagNode(next)).not.toThrow(); expect(() => validateAuthoredRag(next)).not.toThrow();
    expect(nodeValueOptions(next, createBasicWorkflow()).map(item => item.pointer)).toEqual(['/data', '/data/context', '/data/citations', '/data/candidates', '/data/index']);
    if (mode === 'hybrid') expect(next.config.fusion).toEqual({ method: 'rrf', k: 60 });
  });
  it('adds a declaration and scoped reference atomically, keeping unrelated profiles and original nodes', () => {
    const flow = createBasicWorkflow(); const node = createNode('knowledge'); if (node.type !== 'knowledge') throw new Error('type');
    Object.assign(node, knowledgeMode(node, 'vector')); flow.nodes.push(node); const before = JSON.stringify(flow);
    const patch = addEmbeddingDeclaration(flow, node.id, 'documents'); const next = { ...flow, ...patch };
    expect(next.modelProfiles.documents).toEqual({ kind: 'embedding', requiredFeatures: ['embedding'] }); expect(declaredProfiles(next, 'embedding')).toEqual(['documents']);
    expect(declaredProfiles(next, 'chat')).toEqual(Object.keys(flow.modelProfiles)); expect(JSON.stringify(flow)).toBe(before);
    expect((next.nodes.at(-1)!.config as { indexSettings: { embeddingProfile: string } }).indexSettings.embeddingProfile).toBe('documents');
    expect(() => addEmbeddingDeclaration(next, node.id, 'documents')).toThrow(/이미/);
    for (const alias of ['한글', '../file', '__proto__', 'constructor', '']) expect(() => addEmbeddingDeclaration(flow, node.id, alias)).toThrow();
  });
  it('does not silently repair unsupported imported settings and gates every nested flow', () => {
    const flow = createBasicWorkflow(); const node = createNode('retrieval'); if (node.type !== 'retrieval') throw new Error('type');
    node.config = { mode: 'hybrid', topK: 3, maxContextTokens: 1000, keywordTopK: 10, vectorTopK: 10, candidateLimit: 10, fusion: { method: 'rrf', k: 60 }, reranker: { modelProfile: 'judge' } } as typeof node.config;
    flow.subworkflows.child = { entryNodeId: 'start', inputs: true, outputs: true, nodes: [node, createNode('output')], edges: [] };
    const before = JSON.stringify(flow); expect(editorSupportIssues(flow).some(issue => issue.instancePath === '/subworkflows/child/nodes/0/config')).toBe(true); expect(JSON.stringify(flow)).toBe(before);
    for (const mode of ['graph_local', 'web']) { node.config.mode = mode as typeof node.config.mode; expect(() => validateAuthoredRag(node)).toThrow(); }
    delete node.config.reranker; node.config.mode = 'hybrid'; Object.assign(node.config, { filters: {} }); expect(() => validateAuthoredRag(node)).toThrow();
  });
  it('only explicit mode changes remove incompatible embedding or RRF settings', () => {
    const index = createNode('knowledge'); const retrieval = createNode('retrieval'); if (index.type !== 'knowledge' || retrieval.type !== 'retrieval') throw new Error('type');
    Object.assign(index, knowledgeMode(index, 'hybrid')); index.config.indexSettings!.embeddingProfile = 'docs';
    expect((knowledgeMode(index, 'keyword').config as typeof index.config).indexSettings).not.toHaveProperty('embeddingProfile'); expect(index.config.indexSettings!.embeddingProfile).toBe('docs');
    Object.assign(retrieval, retrievalMode(retrieval, 'hybrid')); expect(retrievalMode(retrieval, 'vector').config).not.toHaveProperty('fusion'); expect(retrieval.config).toHaveProperty('fusion');
  });
  it('allocates unused aliases and updates a child without changing Korean names, layouts or root node identities', () => {
    const draft = newLocalDraft(); draft.workflow = addLocalFlow(draft.workflow, 'child'); draft.editor.subflows = { child: { name: '문서 정리', positions: { input: { x: 10, y: 20 } } } };
    const node = createNode('knowledge'); if (node.type !== 'knowledge') throw new Error('factory'); node.id = 'work'; Object.assign(node, knowledgeMode(node, 'vector')); draft.workflow.subworkflows.child!.nodes.push(node);
    const before = JSON.stringify(draft); const alias = nextEmbeddingAlias(draft.workflow); expect(alias).toBe('embedding_default');
    const after = editFlowDraft(draft, 'child', view => ({ ...view, workflow: { ...view.workflow, ...addEmbeddingDeclaration(view.workflow, node.id, alias) } }));
    expect(after.workflow.nodes).toEqual(draft.workflow.nodes); expect(after.editor).toEqual(draft.editor); expect(after.workflow.subworkflows.child!.nodes.at(-1)!.config).toMatchObject({ indexSettings: { embeddingProfile: alias } });
    expect(nextEmbeddingAlias(after.workflow)).toBe('embedding_2'); after.workflow.modelProfiles.embedding_2 = { kind: 'chat', requiredFeatures: ['text'] }; expect(nextEmbeddingAlias(after.workflow)).toBe('embedding_3'); expect(JSON.stringify(draft)).toBe(before);
  });
});
