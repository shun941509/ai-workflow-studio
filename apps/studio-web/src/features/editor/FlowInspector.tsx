'use client';
import { useState } from 'react';
import type { Workflow } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { SchemaFields } from './ValueForms';
import { CompletionInspector } from './CompletionInspector';
import { WorkDefinitionInspector } from './WorkDefinitionInspector';
import { applyCompletionEdit } from './completion-authoring';
import { flowReferrers, flowView } from './flow-helpers';
import styles from './flows.module.css';

/** Flow navigation is presentation only. All edits are delegated to the same whole-draft history boundary. */
export function FlowNavigation({ workflow, activeFlow, names = {}, onSwitch, onSettings }: { workflow: Workflow; names?: Record<string, string>; activeFlow: string; onSwitch: (id: string) => void; onSettings: () => void }) {
  return <div className={styles.navigation}><label>편집할 흐름<select aria-label="편집할 흐름" value={activeFlow} onChange={event => onSwitch(event.target.value)}><option value="main">기본 흐름</option>{Object.keys(workflow.subworkflows).filter(id => id !== 'main').map(id => <option key={id} value={id}>{names[id] ?? id}</option>)}</select></label><Button variant="secondary" onClick={onSettings}>흐름 설정·추가</Button><span>각 흐름의 입력과 결과를 명시적으로 연결합니다.</span></div>;
}

/** Schema controls edit the same fields as input/output cards; no second input contract is introduced. */
export function FlowInspector({ workflow, activeFlow, names = {}, onRename, onAdd, onRemove, onSchema, onWorkflowChange }: { workflow: Workflow; names?: Record<string, string>; onRename: (name: string) => void; activeFlow: string; onAdd: (name: string) => void; onRemove: () => void; onSchema: (patch: Pick<Partial<Workflow>, 'inputs' | 'outputs'>) => void; onWorkflowChange: (change: (workflow: Workflow) => Workflow) => void }) {
  const [name, setName] = useState(''); const [renamed, setRenamed] = useState(names[activeFlow] ?? activeFlow); const [error, setError] = useState('');
  const view = flowView(workflow, activeFlow); const refs = activeFlow === 'main' ? [] : flowReferrers(workflow, activeFlow);
  return <div className="inspector-content"><h3>{names[activeFlow] ?? activeFlow} 설정</h3><p className="inline-help">하위 흐름은 별도 입력을 받아 결과를 반환합니다. 모델·자료·실행 한도는 프로젝트 전체가 공유합니다.</p><SchemaFields label={activeFlow === 'main' ? '프로젝트 입력' : '하위 흐름 입력'} value={view.inputs} onChange={inputs => onSchema({ inputs })}/><SchemaFields label={activeFlow === 'main' ? '최종 결과 형식' : '하위 흐름 결과'} value={view.outputs} onChange={outputs => onSchema({ outputs })}/>
    {activeFlow === 'main' ? <><CompletionInspector workflow={workflow} onEdit={edit => onWorkflowChange(current => applyCompletionEdit(current, edit, activeFlow))}/><WorkDefinitionInspector workflow={workflow} onChange={next => onWorkflowChange(() => next)}/></> : <><p className="inline-help">업무 완료 기준은 기본 흐름 설정에서만 편집합니다.</p><Field label="하위 흐름 이름" htmlFor="rename-flow-name"><input id="rename-flow-name" value={renamed} maxLength={80} onChange={event => setRenamed(event.target.value)}/></Field><Button variant="secondary" onClick={() => { try { onRename(renamed); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : '이름을 확인하세요.'); } }}>이름 변경</Button><section className={styles.deleteSection}><p>{refs.length ? `이 흐름을 호출하는 블록 ${refs.length}개: ${refs.map(ref => `${names[ref.flowId] ?? ref.flowId} / ${ref.label}`).join(', ')}. 호출을 먼저 해제하세요.` : '이 흐름을 호출하는 블록이 없습니다.'}</p><Button variant="secondary" disabled={refs.length > 0} onClick={onRemove}>이 하위 흐름 삭제</Button></section></>}
    <section className={styles.addSection}><h3>하위 흐름 추가</h3><Field label="새 하위 흐름 이름" htmlFor="new-flow-name" hint="문서 정리, 결과 검토처럼 알아보기 쉬운 이름을 입력하세요."><input id="new-flow-name" value={name} maxLength={80} onChange={event => setName(event.target.value)}/></Field><Button variant="secondary" onClick={() => { try { onAdd(name); setName(''); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : '흐름 이름을 확인하세요.'); } }}>하위 흐름 추가</Button>{error ? <p className="form-error" role="alert">{error}</p> : null}</section>
  </div>;
}

/** Caller configuration never rewrites its binding when a different contract is selected. */
export function SubworkflowInspector({ workflow, flowId, currentFlowId, names = {}, onSelect, onOpen }: { workflow: Workflow; names?: Record<string, string>; flowId?: string; currentFlowId: string; onSelect: (id: string) => void; onOpen?: (id: string) => void }) {
  const target = flowId ? workflow.subworkflows[flowId] : undefined;
  return <><Field label="호출할 하위 흐름" htmlFor="called-flow"><select id="called-flow" value={flowId ?? ''} onChange={event => onSelect(event.target.value)}>{!flowId || !target || flowId === currentFlowId ? <option value={flowId ?? ''}>{flowId ? `확인 필요: ${flowId}` : '프로젝트 안의 흐름을 선택하세요'}</option> : null}{Object.keys(workflow.subworkflows).filter(id => id !== currentFlowId && id !== 'main').map(id => <option key={id} value={id}>{names[id] ?? id}</option>)}</select></Field><p className="inline-help">입력·결과 탭에서 ‘하위 흐름에 전달할 값’을 연결하세요. 이 값은 호출한 흐름의 입력 전체가 됩니다.</p>{target ? <><Button variant="secondary" onClick={() => onOpen?.(flowId!)}>호출한 흐름 편집</Button><details className="advanced-settings"><summary>호출 입력·결과 계약</summary><p>입력 계약</p><pre className="schema-preview">{JSON.stringify(target.inputs, null, 2)}</pre><p>반환 값 (/data)</p><pre className="schema-preview">{JSON.stringify(target.outputs, null, 2)}</pre></details></> : <p className="inline-help">흐름 설정·추가에서 하위 흐름을 먼저 만드세요.</p>}</>;
}
