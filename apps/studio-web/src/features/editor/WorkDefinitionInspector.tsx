'use client';
import { useId, useState } from 'react';
import { Button, Field } from '@studio/ui';
import type { Workflow, WorkDefinition } from '@studio/spec';
import { applyWorkingContextPreset, removeWorkingContextPreset } from '@studio/workflow-core';
import { createWorkDefinition, selectWorkAsset, workPerformers } from './work-definition-authoring';

/** One selected business task uses the same canonical workflow and history as the detailed canvas. */
export function WorkDefinitionInspector({ workflow, onChange }: { workflow: Workflow; onChange: (workflow: Workflow) => void }) {
  const id = useId(), [error, setError] = useState('');
  const definition = workflow.workDefinition;
  const act = (operation: () => Workflow) => { try { onChange(operation()); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : '업무 설정을 확인하세요.'); } };
  const patch = (change: (value: WorkDefinition) => void) => act(() => { const next = structuredClone(workflow); change(next.workDefinition!); return next; });
  const fields: Array<{ section: 'card' | 'role' | 'task'; key: string; label: string; limit: number }> = [
    { section: 'card', key: 'title', label: '업무 파트너 이름', limit: 120 }, { section: 'card', key: 'purpose', label: '맡을 책임과 목적', limit: 2000 },
    { section: 'role', key: 'title', label: '담당 역할', limit: 120 }, { section: 'role', key: 'responsibility', label: '역할의 판단 기준', limit: 4000 },
    { section: 'task', key: 'title', label: '이번 반복 업무 이름', limit: 120 }, { section: 'task', key: 'goal', label: '검토할 결과와 업무 목표', limit: 4000 },
  ];
  return <section aria-labelledby={`${id}-title`} className="advanced-settings"><h3 id={`${id}-title`}>업무 정의와 사용할 자료</h3>
    <p className="inline-help">업무 파트너의 책임 → 역할 → 이번 작업을 정합니다. 실행 권한과 개인 모델 연결은 Runner에서 별도로 확인합니다.</p>
    {!definition ? <><Button variant="secondary" disabled={!workflow.completion || !workPerformers(workflow).length} onClick={() => act(() => ({ ...workflow, workDefinition: createWorkDefinition(workflow) }))}>업무 정의 추가</Button>{!workflow.completion ? <p className="inline-help">위에서 업무 완료 기준을 먼저 설정하세요.</p> : null}</> : <>
      {fields.map(field => <Field key={`${field.section}-${field.key}`} label={field.label} htmlFor={`${id}-${field.section}-${field.key}`}><textarea id={`${id}-${field.section}-${field.key}`} rows={field.limit > 120 ? 3 : 1} maxLength={field.limit} value={String((definition[field.section] as unknown as Record<string, unknown>)[field.key])} onChange={event => patch(value => { (value[field.section] as unknown as Record<string, unknown>)[field.key] = event.target.value; })}/></Field>)}
      <fieldset className="step-card"><legend>판단을 맡길 블록</legend>{workPerformers(workflow).map(node => <label key={node.id}><input type="checkbox" checked={definition.harness.perform.includes(node.id)} disabled={!!definition.harness.workingContext} onChange={event => patch(value => { const next = event.target.checked ? [...value.harness.perform, node.id] : value.harness.perform.filter(item => item !== node.id); if (!next.length) throw new Error('수행 블록을 하나 이상 선택하세요.'); value.harness.perform = next as WorkDefinition['harness']['perform']; })}/>{node.label}</label>)}{definition.harness.workingContext ? <p className="inline-help">수행 블록을 바꾸려면 아래에서 문맥 묶기를 해제하세요.</p> : null}</fieldset>
      <p className="inline-help">자료 탭에서 프로젝트에 연결한 자료를 선택합니다. 문서는 참고 데이터로 전달되며 지침으로 승격되지 않습니다.</p>
      {Object.entries(workflow.resources).filter(([, ref]) => ref && ['instruction', 'document', 'skill'].includes(ref.kind)).map(([alias, reference]) => {
        const link = [...definition.task.assets, ...definition.task.skills].find(value => value.alias === alias), selected = definition.harness.selectedContext.includes(alias);
        return <fieldset key={alias} className="step-card"><legend>{alias} · 버전 {reference!.revision}</legend><label><input type="checkbox" checked={selected} onChange={event => act(() => ({ ...workflow, workDefinition: selectWorkAsset(workflow, alias, event.target.checked) }))}/>이번 업무 문맥에 포함</label>
          {link ? <><Field label="이 자료가 필요한 이유" htmlFor={`${id}-asset-${alias}`}><input id={`${id}-asset-${alias}`} value={link.purpose} maxLength={1000} onChange={event => patch(value => { [...value.task.assets, ...value.task.skills].find(item => item.alias === alias)!.purpose = event.target.value; })}/></Field><label><input type="checkbox" checked={link.required} disabled={!selected} onChange={event => patch(value => { [...value.task.assets, ...value.task.skills].find(item => item.alias === alias)!.required = event.target.checked; })}/>이 업무에 필수</label>{!selected ? <p className="inline-help">이 실행 문맥에서 제외합니다.</p> : null}</> : null}
        </fieldset>;
      })}
      <p className="inline-help">‘문맥 구성 적용’은 선택 자료를 수행 블록에 첨부하고 업무 정의를 묶는 블록을 추가합니다. 원래 문맥은 context.request로 이동합니다. 지침에 context.sourceText 같은 경로가 있으면 context.request.sourceText로 직접 수정하세요.</p>
      <Button variant="secondary" onClick={() => act(() => applyWorkingContextPreset(workflow, definition.harness.workingContext?.maxBytes))}>{definition.harness.workingContext ? '문맥 구성 새로 반영' : '문맥 구성 적용'}</Button>
      {definition.harness.workingContext ? <><p className="inline-help">업무 내용이나 자료 선택을 바꿨다면 문맥 구성을 새로 반영하세요. 실제 전달 내역은 실행한 Runner의 기록에서 확인합니다.</p><Button variant="ghost" onClick={() => act(() => removeWorkingContextPreset(workflow))}>문맥 묶기 해제</Button><p className="inline-help">해제하면 원래 문맥 연결로 돌립니다. 지침의 경로는 직접 확인하세요. 연결한 자료와 업무 정의는 유지됩니다.</p></> : <Button variant="ghost" onClick={() => act(() => { const next = structuredClone(workflow); delete next.workDefinition; return next; })}>업무 정의 해제</Button>}
    </>}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
