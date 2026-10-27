"use client";
import { useId } from 'react';
import type { WorkflowNode } from '@studio/spec';
import { Field } from '@studio/ui';

/** Show only the verified local keyword modes; model-backed and graph search remain explicit unsupported imports. */
export function RagInspector({ node, onNode }: { node: WorkflowNode; onNode: (patch: Partial<WorkflowNode>) => void }) {
  const id = useId();
  if (node.type === 'knowledge') {
    const settings = node.config.indexSettings;
    return <>
      <Field label="색인 작업" htmlFor={`${id}-operation`}><select id={`${id}-operation`} value={node.config.operation} onChange={event => {
        const operation = event.target.value as 'build' | 'open'; const key = operation === 'build' ? 'documents' : 'index';
        onNode({ config: operation === 'build' ? { operation, profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 2000, chunkOverlap: 200 } } : { operation }, inputBindings: node.inputBindings[key] ? { [key]: node.inputBindings[key] } : {} } as Partial<WorkflowNode>);
      }}><option value="build">선택한 문서로 만들기</option><option value="open">현재 실행의 색인 열기</option>{!['build', 'open'].includes(node.config.operation) ? <option value={node.config.operation}>{node.config.operation} (현재 미지원)</option> : null}</select></Field>
      <p className="inline-help">이 실행 안에서 사용할 키워드 색인입니다. TXT·Markdown·JSON 원문 파일 목록을 연결하세요. 파일당 2 MiB, 한 색인에 최대 32파일·총 8 MiB를 지원합니다. 다른 실행의 색인은 사용할 수 없습니다.</p>
      {node.config.operation === 'build' ? <details className="advanced-settings"><summary>문서 나누기 설정</summary>
        <Field label="조각 크기 (UTF-8 바이트)" htmlFor={`${id}-size`} hint="한글은 한 글자가 여러 바이트입니다. 원문 글자 중간은 자르지 않습니다."><input id={`${id}-size`} type="number" min={100} max={20000} value={settings?.chunkSize ?? 2000} onChange={event => onNode({ config: { ...node.config, indexSettings: { ...settings!, chunkSize: Number(event.target.value) } } } as Partial<WorkflowNode>)}/></Field>
        <Field label="조각 겹침 (UTF-8 바이트)" htmlFor={`${id}-overlap`} hint="조각 크기보다 작아야 합니다."><input id={`${id}-overlap`} type="number" min={0} max={Math.min(10000, (settings?.chunkSize ?? 2000) - 1)} value={settings?.chunkOverlap ?? 200} onChange={event => onNode({ config: { ...node.config, indexSettings: { ...settings!, chunkOverlap: Number(event.target.value) } } } as Partial<WorkflowNode>)}/></Field>
      </details> : null}
      <p className="inline-help">다음 검색 블록의 ‘검색용 색인’에 이 블록의 /data를 연결하세요. 문서는 원문과 인용 위치를 함께 보존합니다.</p>
    </>;
  }
  if (node.type === 'retrieval') return <>
    <div className="step-card"><strong>문서 키워드 검색</strong><p className="inline-help">문서에 등장하는 단어를 기준으로 검색합니다. 동의어·형태소 분석·벡터·웹·그래프 검색은 현재 이 모드에 포함되지 않습니다.</p></div>
    <Field label="최대 검색 결과 수" htmlFor={`${id}-topk`}><input id={`${id}-topk`} type="number" min={1} max={100} value={node.config.topK} onChange={event => onNode({ config: { ...node.config, topK: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>
    <Field label="문맥 최대 분량 (토큰)" htmlFor={`${id}-tokens`} hint="고정 o200k_base 기준입니다. 실제 모델의 사용량·요금과는 다릅니다."><input id={`${id}-tokens`} type="number" min={20} max={200000} value={node.config.maxContextTokens} onChange={event => onNode({ config: { ...node.config, maxContextTokens: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>
    <p className="inline-help">입력·결과에서 검색어와 현재 실행의 색인을 연결하세요. AI에게 전달할 문맥은 /data/context, 인용 근거는 /data/citations, 검색 결과는 /data/candidates에 있습니다. 권한과 분량을 확인한 전체 조각만 문맥에 포함합니다.</p>
  </>;
  return null;
}
