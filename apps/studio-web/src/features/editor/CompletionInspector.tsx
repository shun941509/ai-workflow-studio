'use client';
import { useId, useState } from 'react';
import type { Workflow } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { SchemaFields } from './ValueForms';
import { COMPLETION_LABELS, completionReferenceIssues, completionSources, type AuthoredCompletionCriterion as CompletionCriterion, type CompletionEdit, type CompletionKind, type CompletionSource } from './completion-authoring';

/** Explicit acceptance editing shares the parent draft transaction; it never evaluates results or changes node logic. */
export function CompletionInspector({ workflow, onEdit }: { workflow: Workflow; onEdit: (edit: CompletionEdit) => void }) {
  const id = useId(), sources = completionSources(workflow), criteria = workflow.completion?.criteria ?? [];
  const [error, setError] = useState<{ workflow: Workflow; message: string }>();
  const [kind, setKind] = useState<CompletionKind>('result_schema'), [nodeId, setNodeId] = useState(''), [label, setLabel] = useState('');
  const [evaluationId, setEvaluationId] = useState(''), [reviewId, setReviewId] = useState(''), [confirmDisable, setConfirmDisable] = useState<Workflow>();
  const issues = completionReferenceIssues(workflow);
  const act = (edit: CompletionEdit) => { try { onEdit(edit); setError(undefined); setConfirmDisable(undefined); } catch (caught) { setError({ workflow, message: caught instanceof Error ? caught.message : '완료 기준을 확인하세요.' }); } };
  const available = sources.filter(source => source.kind === kind), enabled = workflow.completion !== undefined;
  return <section aria-label="업무 완료 기준" className="advanced-settings"><h3>업무 완료 기준</h3>
    <p className="inline-help">실행이 끝났는지와 업무 기준을 모두 충족했는지는 따로 표시됩니다. 선언한 모든 기준이 필수입니다. 결과 형식 검사는 사실 정확성이나 업무 품질을 보장하지 않습니다.</p>
    {!enabled ? <><p>완료 기준을 사용하지 않습니다. 실행 결과는 업무 완료 미평가로 남습니다.</p><Button variant="secondary" onClick={() => act({ type: 'enable' })}>결과 형식 기준으로 시작</Button><p className="inline-help">현재 최종 결과 형식을 하나의 명시적인 기준으로 복사합니다. 이후 두 형식은 자동으로 함께 바뀌지 않습니다.</p></> : <>
      <p>{criteria.length} / 32개 기준 · 모두 필수</p>
      {criteria.map((criterion, index) => <CriterionField key={criterion.id} criterion={criterion} index={index} sources={sources} issue={issues.find(issue => issue.id === criterion.id)?.message} onEdit={act}/>)}
      <fieldset className="step-card"><legend>완료 기준 추가</legend><Field label="추가할 완료 기준 종류" htmlFor={`${id}-kind`}><select id={`${id}-kind`} value={kind} onChange={event => { setKind(event.target.value as CompletionKind); setNodeId(''); }}>
        {(Object.keys(COMPLETION_LABELS) as CompletionKind[]).map(value => <option key={value} value={value} disabled={value !== 'result_schema' && !sources.some(source => source.kind === value)}>{COMPLETION_LABELS[value]}</option>)}
      </select></Field>{kind !== 'result_schema' && <Field label="기준으로 사용할 블록" htmlFor={`${id}-node`}><select id={`${id}-node`} value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">기본 흐름의 블록 선택</option>{available.map(source => <option value={source.id} key={source.id}>{source.label} · {source.id}</option>)}</select></Field>}
      <Field label="새 완료 기준 설명" htmlFor={`${id}-label`}><input id={`${id}-label`} value={label} maxLength={200} onChange={event => setLabel(event.target.value)} placeholder={COMPLETION_LABELS[kind]}/></Field><Button variant="secondary" disabled={criteria.length >= 32 || kind !== 'result_schema' && !available.some(source => source.id === nodeId)} onClick={() => act({ type: 'add', kind, nodeId, label: label || COMPLETION_LABELS[kind] })}>완료 기준 추가</Button></fieldset>
      <details><summary>기존 규칙 검사·사용자 검토 함께 연결</summary><p className="inline-help">기존 두 블록을 완료 기준에 연결합니다. 검사 조건·검토 질문·실행 순서·자동 보완은 바꾸지 않습니다.</p>
        <Field label="함께 연결할 규칙 검사" htmlFor={`${id}-evaluation`}><select id={`${id}-evaluation`} value={evaluationId} onChange={event => setEvaluationId(event.target.value)}><option value="">규칙 검사 선택</option>{sources.filter(source => source.kind === 'evaluate_passed').map(source => <option key={source.id} value={source.id}>{source.label} · {source.id}</option>)}</select></Field>
        <Field label="함께 연결할 사용자 검토" htmlFor={`${id}-review`}><select id={`${id}-review`} value={reviewId} onChange={event => setReviewId(event.target.value)}><option value="">사용자 검토 선택</option>{sources.filter(source => source.kind === 'review_accepted').map(source => <option key={source.id} value={source.id}>{source.label} · {source.id}</option>)}</select></Field>
        <Button variant="secondary" disabled={!evaluationId || !reviewId} onClick={() => act({ type: 'checks-and-review', evaluationId, reviewId })}>선택한 검사·검토를 기준에 연결</Button>
      </details>
      {workflow.workDefinition ? <p className="inline-help">업무 정의가 연결되어 있어 판정을 해제할 수 없습니다. 기준을 편집하면 Task의 전체 기준과 확인 블록 연결을 함께 저장합니다.</p> : <><Button variant="ghost" onClick={() => setConfirmDisable(workflow)}>완료 기준 해제</Button>{confirmDisable === workflow && <div className="step-card"><p>기준을 모두 해제하면 이후 실행은 업무 완료 미평가로 남습니다. 노드와 결과 형식은 유지합니다.</p><Button variant="secondary" onClick={() => act({ type: 'disable' })}>판정을 해제하고 미평가로 저장</Button><Button variant="ghost" onClick={() => setConfirmDisable(undefined)}>해제 취소</Button></div>}</>}
    </>}
    {error?.workflow === workflow && <p className="form-error" role="alert">{error.message}</p>}
  </section>;
}

/** A pending label is local text until blur/Enter; stale UI text cannot overwrite an undo or reopened criterion. */
function CriterionField({ criterion, index, sources, issue, onEdit }: { criterion: CompletionCriterion; index: number; sources: CompletionSource[]; issue?: string; onEdit: (edit: CompletionEdit) => void }) {
  const id = useId(), [pending, setPending] = useState<{ criterion: CompletionCriterion; label: string }>();
  const value = pending?.criterion === criterion ? pending.label : criterion.label;
  const updateLabel = () => { if (value !== criterion.label) onEdit({ type: 'replace', id: criterion.id, criterion: { ...criterion, label: value } }); };
  const eligible = sources.filter(source => source.kind === criterion.kind);
  return <fieldset className="step-card"><legend>완료 기준 {index + 1}: {COMPLETION_LABELS[criterion.kind]}</legend>
    <Field label={`완료 기준 ${index + 1} 설명`} htmlFor={`${id}-label`}><input id={`${id}-label`} value={value} maxLength={200} onChange={event => setPending({ criterion, label: event.target.value })} onBlur={updateLabel} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/></Field>
    {criterion.kind === 'result_schema' ? <SchemaFields label={`완료 기준 ${index + 1} 결과 형식`} value={criterion.schema} onChange={schema => onEdit({ type: 'replace', id: criterion.id, criterion: { ...criterion, schema } })}/> : <Field label={`완료 기준 ${index + 1} 확인 블록`} htmlFor={`${id}-node`}><select id={`${id}-node`} value={criterion.nodeId} onChange={event => onEdit({ type: 'replace', id: criterion.id, criterion: { ...criterion, nodeId: event.target.value } })}>
      {!eligible.some(source => source.id === criterion.nodeId) && <option value={criterion.nodeId}>확인 필요: {criterion.nodeId}</option>}{eligible.map(source => <option value={source.id} key={source.id}>{source.label} · {source.id}</option>)}
    </select></Field>}
    {criterion.kind === 'result_schema' && <p className="inline-help">형식 충족만 확인합니다. 내용의 사실 정확성이나 의미 품질은 별도 검사·사용자 검토가 필요합니다.</p>}
    {issue && <p className="form-error" role="status">{issue}</p>}
    <Button variant="ghost" aria-label={`완료 기준 ${index + 1} 삭제`} onClick={() => onEdit({ type: 'remove', id: criterion.id })}>이 기준 삭제</Button>
  </fieldset>;
}
