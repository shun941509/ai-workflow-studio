"use client";
import { useId, useState } from 'react';
import { getNodeDefinition, type Binding, type Workflow, type WorkflowNode } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { bindingFields, bindingNames } from './editor-contract';
import { LiteralField } from './ValueForms';
import { bindingValueOptions } from './binding-options';

/** Sources stay explicit and preserve absent versus null. The graph validator still checks dominance and skipped branches. */
function BindingRow({ name, fieldKey, binding, workflow, node, onChange, flowId }: { name: string; fieldKey: string; binding: Binding; workflow: Workflow; node: WorkflowNode; onChange: (binding: Binding) => void; flowId?: string }) {
  const id = useId();
  // Derive suggestions from the selected producer, never from prior output or user data. Unknown pointers stay editable.
  const valueOptions = bindingValueOptions(binding, workflow);
  const selectedOption = binding.from !== 'literal' ? valueOptions.find(option => option.pointer === binding.pointer) : undefined;
  const indexList = node.type === 'agent' && node.config.strategy === 'agentic_rag' && fieldKey === 'indexes';
  // Selecting an input source is explicit; an index list never starts as an unrelated /text string.
  const setSource = (from: string) => onChange(from === 'literal' ? { from, value: indexList ? [] : '' } : from === 'node' ? { from, nodeId: workflow.nodes.find((item) => item.id !== node.id)?.id ?? '', pointer: '/data', onMissing: node.type === 'merge' ? 'omit' : 'error' } : from === 'resource' ? { from, resource: Object.keys(workflow.resources)[0] ?? '', pointer: '/data', onMissing: 'error' } : from === 'error' ? { from, pointer: '', onMissing: 'error' } : { from: 'workflowInput', pointer: indexList ? '/indexes' : '/text', onMissing: 'error' });
  return <><Field label={`${name} 가져올 곳`} htmlFor={`${id}-source`}><select id={`${id}-source`} value={binding.from} onChange={(event) => setSource(event.target.value)}><option value="node">다른 블록의 결과</option><option value="workflowInput">{flowId && flowId !== 'main' ? '이 하위 흐름의 입력' : '프로젝트 실행 입력'}</option><option value="literal">직접 입력</option><option value="resource">고정된 자료</option>{node.type === 'error' ? <option value="error">발생한 오류</option> : null}</select></Field>
    {binding.from === 'node' ? <Field label={`${name} 결과 블록`} htmlFor={`${id}-node`}><select id={`${id}-node`} value={binding.nodeId} onChange={(event) => onChange({ ...binding, nodeId: event.target.value })}>{!workflow.nodes.some((item) => item.id === binding.nodeId) ? <option value={binding.nodeId}>찾을 수 없는 블록: {binding.nodeId}</option> : null}{workflow.nodes.filter((item) => item.id !== node.id).map((item) => <option key={item.id} value={item.id}>{item.label} · {getNodeDefinition(item.type)?.title}</option>)}</select></Field> : null}
    {binding.from === 'resource' ? <Field label={`${name} 자료`} htmlFor={`${id}-resource`}><select id={`${id}-resource`} value={binding.resource} onChange={(event) => onChange({ ...binding, resource: event.target.value })}><option value="">자료를 먼저 연결하세요</option>{Object.entries(workflow.resources).map(([alias, ref]) => <option key={alias} value={alias}>{alias} · 버전 {ref?.revision}</option>)}</select></Field> : null}
    {binding.from === 'literal' ? <LiteralField label={`${name} 직접 입력`} value={binding.value} onChange={(value) => onChange({ from: 'literal', value })}/> : <>
      <Field label={`${name} 가져올 값`} htmlFor={`${id}-value`} hint={selectedOption?.description || '선택한 블록의 결과에서 사용할 값을 고르세요. 직접 지정한 경로는 아래에서 편집할 수 있습니다.'}>
        <select id={`${id}-value`} value={selectedOption?.pointer ?? '__custom_pointer__'} onChange={(event) => { if (valueOptions.some(option => option.pointer === event.target.value)) onChange({ ...binding, pointer: event.target.value }); }}>
          {!selectedOption ? <option value="__custom_pointer__">직접 지정한 경로 (고급)</option> : null}
          {valueOptions.map(option => <option key={option.pointer} value={option.pointer}>{option.label}</option>)}
        </select>
      </Field>
      <Field label={`${name} 값 위치`} htmlFor={`${id}-pointer`} hint="고급 설정 · 위에서 값을 선택하면 경로가 입력됩니다. 직접 수정한 경로와 누락 규칙은 그대로 유지됩니다."><input id={`${id}-pointer`} value={binding.pointer} onChange={(event) => onChange({ ...binding, pointer: event.target.value })}/></Field>
      <Field label={`${name} 값이 없을 때`} htmlFor={`${id}-missing`}><select id={`${id}-missing`} value={binding.onMissing} onChange={(event) => { const { defaultValue: _unused, ...base } = binding as Binding & { defaultValue?: unknown }; onChange(event.target.value === 'default' ? { ...base, onMissing: 'default', defaultValue: '' } as Binding : { ...base, onMissing: event.target.value } as Binding); }}><option value="error">오류로 중단</option><option value="omit">이 입력 제외 (분기 합류)</option><option value="default">대체 값 사용</option></select></Field>{binding.onMissing === 'default' ? <LiteralField label={`${name} 대체 값`} value={binding.defaultValue} onChange={(defaultValue) => onChange({ ...binding, defaultValue })}/> : null}</>}
  </>;
}

/** Registry field names are shown with plain-language labels; arbitrary merge aliases have explicit add/remove actions. */
export function BindingEditor({ node, workflow, onChange, flowId = 'main' }: { node: WorkflowNode; workflow: Workflow; onChange: (value: WorkflowNode['inputBindings']) => void; flowId?: string }) {
  const [alias, setAlias] = useState(''); const [error, setError] = useState('');
  const fields = bindingFields(node);
  return <section className="binding-editor"><h3>사용할 데이터</h3><p className="muted">연결선은 순서이고, 아래 선택은 전달할 내용입니다.</p>{node.type === 'merge' ? <p className="inline-help">실행되지 않은 분기는 ‘이 입력 제외’로 연결하세요. 활성 경로의 결과가 모이면 합류합니다.</p> : null}{fields.map(({ key, required }) => {
    const label = node.type === 'subworkflow' && key === 'input' ? '하위 흐름에 전달할 값' : node.type === 'document_extract' && key === 'file' ? '읽을 문서' : bindingNames[key] ?? key; const binding = node.inputBindings[key];
    return <fieldset className="binding-card" key={key}><legend>{label}{required ? ' · 필수' : ''}</legend>{binding ? <><BindingRow flowId={flowId} name={label} fieldKey={key} binding={binding} workflow={workflow} node={node} onChange={(next) => onChange({ ...node.inputBindings, [key]: next })}/><Button variant="ghost" onClick={() => { const next = { ...node.inputBindings }; delete next[key]; onChange(next); }}>입력 연결 해제</Button></> : <Button variant="secondary" onClick={() => onChange({ ...node.inputBindings, [key]: key === 'error' ? { from: 'error', pointer: '', onMissing: 'error' } : { from: 'workflowInput', pointer: node.type === 'agent' && node.config.strategy === 'agentic_rag' && key === 'indexes' ? '/indexes' : '/text', onMissing: 'error' } })}>{label} 연결</Button>}</fieldset>;
  })}{!fields.length && node.type !== 'merge' ? <p className="inline-help">이 블록은 별도 입력 연결이 필요하지 않습니다.</p> : null}{node.type === 'merge' ? <><Field label="합칠 입력 이름" htmlFor="merge-binding-alias" hint="예: accepted, rejected"><input id="merge-binding-alias" value={alias} onChange={(event) => setAlias(event.target.value)}/></Field><Button variant="secondary" onClick={() => { if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype', '__proto__'].includes(alias) || Object.hasOwn(node.inputBindings, alias)) { setError('중복되지 않는 영문 입력 이름을 입력하세요.'); return; } onChange({ ...node.inputBindings, [alias]: { from: 'node', nodeId: workflow.nodes.find((item) => item.id !== node.id)?.id ?? '', pointer: '/data', onMissing: 'omit' } }); setAlias(''); setError(''); }}>합칠 입력 추가</Button>{error ? <p role="alert" className="form-error">{error}</p> : null}</> : null}</section>;
}
