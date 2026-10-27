"use client";
import { getNodeDefinition, type Workflow, type WorkflowNode } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { outputPorts, portNames } from './editor-contract';

/** Select-based connections are a keyboard alternative to dragging; every port has exactly one selected successor. */
export function ControlConnections({ node, workflow, onChange }: { node: WorkflowNode; workflow: Workflow; onChange: (edges: Workflow['edges']) => void }) {
  const ports = outputPorts(node);
  const obsolete = workflow.edges.filter((edge) => edge.from.nodeId === node.id && !ports.includes(edge.from.port));
  if (!ports.length && !obsolete.length) return null;
  return <section className="control-connections"><h3>다음 작업 연결</h3><p className="inline-help">실행할 순서입니다. 전달할 내용은 입력·결과 탭에서 선택하세요.</p>{ports.map((port) => {
    const edge = workflow.edges.find((item) => item.from.nodeId === node.id && item.from.port === port);
    return <Field key={port} label={`${portNames[port] ?? port} 연결`} htmlFor={`next-${node.id}-${port}`}><select id={`next-${node.id}-${port}`} value={edge?.to.nodeId ?? ''} onChange={(event) => {
      const edges = workflow.edges.filter((item) => !(item.from.nodeId === node.id && item.from.port === port));
      if (event.target.value) edges.push({ id: `e_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`, from: { nodeId: node.id, port }, to: { nodeId: event.target.value, port: 'in' } });
      onChange(edges);
    }}><option value="">연결할 블록 선택</option>{workflow.nodes.filter((candidate) => candidate.id !== node.id && getNodeDefinition(candidate.type)!.controlPorts.inputs.includes('in') && (port === 'error' ? candidate.type === 'error' : candidate.type !== 'error')).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></Field>;
  })}{obsolete.length ? <div className="obsolete-connections"><p className="form-error">이름 또는 설정이 바뀌어 사용할 수 없는 연결이 {obsolete.length}개 있습니다: {obsolete.map((edge) => edge.from.port).join(', ')}</p><Button variant="secondary" onClick={() => { const ids = new Set(obsolete.map((edge) => edge.id)); onChange(workflow.edges.filter((edge) => !ids.has(edge.id))); }}>사용하지 않는 연결 제거</Button></div> : null}</section>;
}
