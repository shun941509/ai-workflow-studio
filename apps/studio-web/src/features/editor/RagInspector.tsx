"use client";
import { useId, useState } from 'react';
import type { Workflow, WorkflowNode } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { addEmbeddingDeclaration, declaredProfiles, knowledgeMode, nextEmbeddingAlias, retrievalMode, searchModeNames, type SearchMode } from './rag-authoring';
import { RerankInspector } from './RerankInspector';

const transferNotice = '벡터·혼합 색인을 만들면 원문 조각을, 검색하면 검색어를 OpenAI로 전송합니다. text-embedding-3-small · 256차원 고정이며 한 색인은 최대 128조각입니다. 실제 모델·키는 Runner에서 연결합니다.';

/** Explicit forms expose installed RAG modes while retaining unsupported imported values until the user changes them. */
export function RagInspector({ node, workflow, onNode, onWorkflow }: { node: WorkflowNode; workflow: Workflow; onNode: (patch: Partial<WorkflowNode>) => void; onWorkflow: (patch: Partial<Workflow>) => void }) {
  const id = useId(); const [alias, setAlias] = useState(''); const [error, setError] = useState('');
  if (node.type === 'knowledge') {
    const settings = node.config.indexSettings; const kind = settings?.kind ?? ''; const embedding = kind === 'vector' || kind === 'hybrid';
    const profiles = declaredProfiles(workflow, 'embedding'); const selected = settings?.embeddingProfile ?? '';
    return <>
      <Field label="색인 작업" htmlFor={`${id}-operation`}><select id={`${id}-operation`} value={node.config.operation} onChange={event => {
        const operation = event.target.value as 'build' | 'open'; const key = operation === 'build' ? 'documents' : 'index';
        onNode({ config: operation === 'build' ? { operation, profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 2000, chunkOverlap: 200 } } : { operation }, inputBindings: node.inputBindings[key] ? { [key]: node.inputBindings[key] } : {} } as Partial<WorkflowNode>);
      }}><option value="build">선택한 문서로 만들기</option><option value="open">현재 실행의 색인 열기</option>{!['build', 'open'].includes(node.config.operation) ? <option value={node.config.operation}>{node.config.operation} (현재 미지원)</option> : null}</select></Field>
      <p className="inline-help">{node.config.operation === 'build' ? 'TXT·Markdown·JSON 원문 파일 목록을 연결하세요. 파일당 2 MiB, 한 색인에 최대 32파일·총 8 MiB를 지원합니다.' : '앞선 지식 색인 블록이 만든 색인 결과를 연결하세요.'} 현재 실행에서 만든 색인만 사용할 수 있습니다.</p>
      {node.config.operation === 'build' ? <>
        <Field label="색인 방식" htmlFor={`${id}-kind`} hint="방식을 직접 바꾸면 해당 방식의 설정으로 변경됩니다."><select id={`${id}-kind`} value={kind} onChange={event => { setError(''); onNode(knowledgeMode(node, event.target.value as SearchMode)); }}>{Object.entries(searchModeNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}{!Object.hasOwn(searchModeNames, kind) && <option value={kind}>{kind || '설정 필요'} (현재 미지원)</option>}</select></Field>
        {embedding ? <><p className="inline-help">{transferNotice}</p>
          <Field label="문서 검색용 연결" htmlFor={`${id}-embedding`} hint="프로젝트의 연결 자리를 선택합니다. 실제 연결 이름과 API 키는 Runner에서 설정하세요."><select id={`${id}-embedding`} value={selected} onChange={event => onNode({ config: { ...node.config, indexSettings: { ...settings!, embeddingProfile: event.target.value } } } as Partial<WorkflowNode>)}><option value="">연결 자리를 추가하거나 선택하세요</option>{selected && !profiles.includes(selected) && <option value={selected}>{selected} (선언 누락 또는 종류 불일치)</option>}{profiles.map(name => <option key={name}>{name}</option>)}</select></Field>
          <Button variant="secondary" onClick={() => { try { onWorkflow(addEmbeddingDeclaration(workflow, node.id, alias || nextEmbeddingAlias(workflow))); setAlias(''); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : '이름을 확인하세요.'); } }}>문서 검색용 연결 추가</Button>{error && <p role="alert" className="inline-help">{error}</p>}
          <details className="advanced-settings"><summary>연결 식별자 직접 지정 (선택)</summary><Field label="새 임베딩 프로필 이름" htmlFor={`${id}-alias`} hint="비워 두면 자동으로 정합니다. 표시 이름은 Runner에서 한글로 입력할 수 있습니다."><input id={`${id}-alias`} value={alias} maxLength={64} placeholder={nextEmbeddingAlias(workflow)} onChange={event => { setAlias(event.target.value); setError(''); }}/></Field></details>
        </> : kind === 'keyword' ? <p className="inline-help">이 키워드 색인 단계는 모델을 호출하지 않습니다. 벡터·혼합 검색에는 해당 방식으로 만든 색인이 필요합니다.</p> : null}
        <details className="advanced-settings"><summary>문서 나누기 설정</summary>
          <Field label="조각 크기 (UTF-8 바이트)" htmlFor={`${id}-size`} hint="한글은 한 글자가 여러 바이트입니다. 원문 글자 중간은 자르지 않습니다."><input id={`${id}-size`} type="number" min={100} max={20000} value={settings?.chunkSize ?? 2000} onChange={event => onNode({ config: { ...node.config, indexSettings: { ...settings!, chunkSize: Number(event.target.value) } } } as Partial<WorkflowNode>)}/></Field>
          <Field label="조각 겹침 (UTF-8 바이트)" htmlFor={`${id}-overlap`} hint="조각 크기보다 작아야 합니다."><input id={`${id}-overlap`} type="number" min={0} max={Math.min(10000, (settings?.chunkSize ?? 2000) - 1)} value={settings?.chunkOverlap ?? 200} onChange={event => onNode({ config: { ...node.config, indexSettings: { ...settings!, chunkOverlap: Number(event.target.value) } } } as Partial<WorkflowNode>)}/></Field>
        </details>
      </> : null}
      <p className="inline-help">다음 검색 블록의 ‘검색용 색인’에 이 블록의 /data를 연결하세요. 문서는 원문과 인용 위치를 함께 보존합니다. 그래프·외부 색인은 현재 지원하지 않습니다.</p>
    </>;
  }
  if (node.type === 'retrieval') return <>
    <Field label="검색 방식" htmlFor={`${id}-mode`} hint="검색 방식과 색인 방식을 맞추세요. 가져온 미지원 설정은 자동으로 바뀌지 않습니다."><select id={`${id}-mode`} value={node.config.mode} onChange={event => onNode(retrievalMode(node, event.target.value as SearchMode))}>{Object.entries(searchModeNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}{!Object.hasOwn(searchModeNames, node.config.mode) && <option value={node.config.mode}>{node.config.mode} (현재 미지원)</option>}</select></Field>
    <p className="inline-help">{node.config.mode === 'keyword' ? '문서에 등장하는 단어를 기준으로 검색합니다. 이 검색 단계는 임베딩을 호출하지 않습니다.' : ['vector', 'hybrid'].includes(node.config.mode) ? transferNotice : '현재 지원하지 않는 검색 설정입니다. 원본은 보존되며 준비 검사에서 차단합니다.'}</p>
    <Field label="최대 검색 결과 수" htmlFor={`${id}-topk`}><input id={`${id}-topk`} type="number" min={1} max={node.config.reranker ? 20 : 100} value={node.config.topK} onChange={event => onNode({ config: { ...node.config, topK: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>
    <Field label="문맥 최대 분량 (토큰)" htmlFor={`${id}-tokens`} hint="고정 o200k_base 기준입니다. 실제 모델의 사용량·요금과는 다릅니다."><input id={`${id}-tokens`} type="number" min={20} max={200000} value={node.config.maxContextTokens} onChange={event => onNode({ config: { ...node.config, maxContextTokens: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>
    {node.config.mode === 'hybrid' && <details className="advanced-settings"><summary>혼합 검색 설정</summary><p className="inline-help">두 검색의 순위를 RRF로 합칩니다. 이 혼합 검색을 사용하는 Agentic RAG와 GraphRAG는 현재 지원하지 않습니다.</p>{(['keywordTopK', 'vectorTopK', 'candidateLimit'] as const).map((key, index) => key === 'candidateLimit' && node.config.reranker ? null : <Field key={key} label={['키워드 후보 수', '벡터 후보 수', '합친 후보 상한'][index]!} htmlFor={`${id}-${key}`}><input id={`${id}-${key}`} type="number" min={1} max={1000} value={node.config[key] ?? ''} onChange={event => onNode({ config: { ...node.config, [key]: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>)}<Field label="RRF 순위 완화값" htmlFor={`${id}-rrf`} hint="기본값 60. 합친 후보 상한은 최대 검색 결과 수 이상이어야 합니다."><input id={`${id}-rrf`} type="number" min={1} max={1000} value={node.config.fusion?.k ?? ''} onChange={event => onNode({ config: { ...node.config, fusion: { ...node.config.fusion!, k: Number(event.target.value) } } } as Partial<WorkflowNode>)}/></Field></details>}
    <RerankInspector node={node} workflow={workflow} onNode={onNode} onWorkflow={onWorkflow}/>
    <p className="inline-help">입력·결과에서 검색어와 현재 실행의 색인을 연결하세요. AI에게 전달할 문맥은 /data/context, 인용 근거는 /data/citations, 검색 결과는 /data/candidates에 있습니다. 권한과 분량을 확인한 전체 조각만 문맥에 포함합니다.</p>
  </>;
  return null;
}
