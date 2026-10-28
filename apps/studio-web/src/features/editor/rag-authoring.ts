import type { Workflow, WorkflowNode } from '@studio/spec';

export type SearchMode = 'keyword' | 'vector' | 'hybrid';
export const searchModeNames: Record<SearchMode, string> = { keyword: '키워드 · 문서의 단어로 찾기', vector: '벡터 · 문장의 의미로 찾기', hybrid: '혼합 · 단어와 의미를 함께 찾기' };

/** Keep the authoring contract closed even when a newer Runner adds modes or provider features. */
export function validateAuthoredRag(node: WorkflowNode): void {
  const closed = (value: object, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('편집기는 키워드·벡터·혼합(RRF)만 지원합니다. 추가 검색 설정은 보존되지만 다운로드할 수 없습니다.'); };
  if (node.type === 'knowledge') {
    closed(node.config, node.config.operation === 'build' ? ['operation', 'profile', 'indexSettings'] : ['operation']);
    if (node.config.operation === 'build' && node.config.indexSettings) closed(node.config.indexSettings, ['kind', 'chunkSize', 'chunkOverlap', 'embeddingProfile']);
    if (node.config.operation === 'build' && !['keyword', 'vector', 'hybrid'].includes(node.config.indexSettings?.kind ?? '') || !['build', 'open'].includes(node.config.operation)) throw new Error('현재 실행의 키워드·벡터·혼합 색인만 편집할 수 있습니다.');
  }
  if (node.type === 'retrieval') {
    if (!['keyword', 'vector', 'hybrid'].includes(node.config.mode)) throw new Error('현재 편집기는 키워드·벡터·혼합 검색을 지원합니다.');
    closed(node.config, ['mode', 'topK', 'maxContextTokens', ...(node.config.mode === 'hybrid' ? ['keywordTopK', 'vectorTopK', 'candidateLimit', 'fusion'] : []), ...(node.config.reranker ? ['reranker', 'candidateLimit'] : [])]);
    if (node.config.fusion) { closed(node.config.fusion, ['method', 'k']); if (node.config.fusion.method !== 'rrf') throw new Error('혼합 검색은 RRF 방식만 지원합니다.'); }
    if (node.config.reranker) {
      const reranker = node.config.reranker; closed(reranker, ['modelProfile', 'timeoutMs', 'onFailure']);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reranker.modelProfile) || !Number.isSafeInteger(reranker.timeoutMs) || reranker.timeoutMs < 1 || reranker.timeoutMs > 120000 || !['fail', 'use_original'].includes(reranker.onFailure)) throw new Error('검색 결과 재정렬의 연결·대기 시간·실패 처리 설정을 확인하세요.');
      if (!Number.isSafeInteger(node.config.candidateLimit) || node.config.candidateLimit! < node.config.topK || node.config.candidateLimit! > 20) throw new Error('재정렬 후보 수는 최대 검색 결과 수 이상, 최대 20개여야 합니다. 기존 값은 자동으로 줄이지 않습니다.');
    }
  }
}

/** Workflow declarations are strict; only the Runner's saved legacy profiles may omit kind. */
export function declaredProfiles(workflow: Workflow, kind: 'chat' | 'embedding' | 'reranker'): string[] {
  return Object.entries(workflow.modelProfiles).filter(([, profile]) => profile?.kind === kind).map(([alias]) => alias);
}

/** Beginners need not invent an ASCII runtime identifier; existing shared declarations remain untouched. */
export function nextEmbeddingAlias(workflow: Workflow): string {
  if (!Object.hasOwn(workflow.modelProfiles, 'embedding_default')) return 'embedding_default';
  let suffix = 2; while (Object.hasOwn(workflow.modelProfiles, `embedding_${suffix}`)) suffix++;
  return `embedding_${suffix}`;
}

/** Called only by an explicit mode choice. Merely viewing/importing a node never rewrites unsupported options. */
export function knowledgeMode(node: Extract<WorkflowNode, { type: 'knowledge' }>, kind: SearchMode): Partial<WorkflowNode> {
  const settings = node.config.indexSettings;
  return { config: { operation: 'build', profile: kind === 'keyword' ? 'local-run-keyword-v1' : 'local-run-embedding-v1', indexSettings: {
    kind, chunkSize: settings?.chunkSize ?? 2000, chunkOverlap: settings?.chunkOverlap ?? 200,
    ...(kind === 'keyword' ? {} : { embeddingProfile: settings?.embeddingProfile ?? '' }),
  } } } as Partial<WorkflowNode>;
}

/** Preserve explicitly enabled reranking when switching supported search channels; never infer agentic options. */
export function retrievalMode(node: Extract<WorkflowNode, { type: 'retrieval' }>, mode: SearchMode): Partial<WorkflowNode> {
  return { config: { mode, topK: node.config.topK, maxContextTokens: node.config.maxContextTokens,
    ...(mode === 'hybrid' ? { keywordTopK: node.config.keywordTopK ?? 20, vectorTopK: node.config.vectorTopK ?? 20, candidateLimit: node.config.candidateLimit ?? Math.max(20, node.config.topK), fusion: { method: 'rrf', k: node.config.fusion?.k ?? 60 } } : {}),
    ...(node.config.reranker ? { reranker: { ...node.config.reranker }, candidateLimit: node.config.candidateLimit } : {}),
  } } as Partial<WorkflowNode>;
}

/** Explicit opt-in adds a separate model role. Existing numbers are never silently clamped to the new limit. */
export function toggleRerank(node: Extract<WorkflowNode, { type: 'retrieval' }>, enabled: boolean): Partial<WorkflowNode> {
  if (enabled) return { config: { ...node.config, candidateLimit: node.config.candidateLimit ?? Math.max(10, node.config.topK), reranker: node.config.reranker ?? { modelProfile: '', timeoutMs: 30000, onFailure: 'fail' } } } as Partial<WorkflowNode>;
  const { reranker: _removed, candidateLimit, ...config } = node.config;
  return { config: { ...config, ...(node.config.mode === 'hybrid' ? { candidateLimit } : {}) } } as Partial<WorkflowNode>;
}

export function nextRerankerAlias(workflow: Workflow): string {
  if (!Object.hasOwn(workflow.modelProfiles, 'reranker_default')) return 'reranker_default';
  let suffix = 2; while (Object.hasOwn(workflow.modelProfiles, `reranker_${suffix}`)) suffix++;
  return `reranker_${suffix}`;
}

/** A declaration plus scoped reference is one undoable change; a chat profile never changes kind implicitly. */
export function addRerankerDeclaration(workflow: Workflow, nodeId: string, alias: string): Partial<Workflow> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || ['__proto__', 'constructor', 'prototype'].includes(alias)) throw new Error('프로필 식별자는 영문·숫자로 시작하는 영문·숫자·밑줄·하이픈 1~64자로 입력하세요.');
  if (Object.hasOwn(workflow.modelProfiles, alias)) throw new Error('이미 있는 프로필 이름입니다. 기존 재정렬 연결을 선택하거나 다른 식별자를 입력하세요.');
  const node = workflow.nodes.find(item => item.id === nodeId);
  if (!node || node.type !== 'retrieval' || !node.config.reranker || !['keyword', 'vector', 'hybrid'].includes(node.config.mode)) throw new Error('검색 결과 재정렬을 먼저 켜세요.');
  return { modelProfiles: { ...workflow.modelProfiles, [alias]: { kind: 'reranker', requiredFeatures: ['rerank'] } }, nodes: workflow.nodes.map(item => item !== node ? item : { ...node, config: { ...node.config, reranker: { ...node.config.reranker!, modelProfile: alias } } }) as Workflow['nodes'] };
}

/** Add one shared declaration and its explicit node reference in the same undoable scoped draft change. */
export function addEmbeddingDeclaration(workflow: Workflow, nodeId: string, alias: string): Partial<Workflow> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || ['__proto__', 'constructor', 'prototype'].includes(alias)) throw new Error('프로필 이름은 영문·숫자로 시작하는 영문·숫자·밑줄·하이픈 1~64자로 입력하세요.');
  if (Object.hasOwn(workflow.modelProfiles, alias)) throw new Error('이미 있는 프로필 이름입니다. 기존 임베딩 프로필을 선택하거나 다른 이름을 입력하세요.');
  const node = workflow.nodes.find(item => item.id === nodeId);
  if (!node || node.type !== 'knowledge' || node.config.operation !== 'build' || !['vector', 'hybrid'].includes(node.config.indexSettings?.kind ?? '')) throw new Error('벡터 또는 혼합 색인 블록을 선택하세요.');
  return { modelProfiles: { ...workflow.modelProfiles, [alias]: { kind: 'embedding', requiredFeatures: ['embedding'] } }, nodes: workflow.nodes.map(item => item !== node ? item : { ...node, config: { ...node.config, indexSettings: { ...node.config.indexSettings!, embeddingProfile: alias } } }) as Workflow['nodes'] };
}
